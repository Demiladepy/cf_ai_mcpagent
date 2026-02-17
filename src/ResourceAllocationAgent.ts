/**
 * Resource Allocation Agent
 *
 * Manages shared resources (equipment, licenses, parking): request/return via chat,
 * waitlists with auto-assignment, return reminders, and utilization metrics.
 * Optional MCP (Slack/Email) for notifications.
 */
import { Agent, callable } from "agents";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ResourceType = "equipment" | "license" | "parking";

export type Resource = {
	id: string;
	type: ResourceType;
	name: string;
	quantity: number;
	metadata?: Record<string, string>;
};

export type Assignment = {
	id: string;
	resourceId: string;
	userId: string;
	assignedAt: string;
	dueReturnAt?: string;
	status: "active" | "returned";
};

export type WaitlistEntry = {
	id: string;
	resourceId: string;
	userId: string;
	requestedAt: string;
	priority?: number;
};

export type UtilizationLogEntry = {
	resourceId: string;
	date: string;
	allocated: number;
	total: number;
};

export type ConversationMessage = { role: "user" | "assistant"; content: string };

export type ResourceAllocationState = {
	resources: Resource[];
	assignments: Assignment[];
	waitlist: WaitlistEntry[];
	utilizationLog: UtilizationLogEntry[];
	notifications: Record<string, string[]>;
	/** Bounded per-user conversation history for LLM context. */
	conversationByUser: Record<string, ConversationMessage[]>;
};

export type Env = {
	ResourceAllocationAgent: DurableObjectNamespace;
	AI: Ai;
	SLACK_MCP_URL?: string;
	EMAIL_MCP_URL?: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REMINDER_CRON = "0 9 * * *";
const REMINDER_HOURS_AHEAD = 24;
const CONVERSATION_CAP_PER_USER = 20;
const LLAMA_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

const DEFAULT_RESOURCES: Resource[] = [
	{ id: "P1", type: "parking", name: "Parking Spot 1", quantity: 1, metadata: { location: "Lot A" } },
	{ id: "P2", type: "parking", name: "Parking Spot 2", quantity: 1, metadata: { location: "Lot A" } },
	{ id: "L1", type: "license", name: "Adobe CC", quantity: 5 },
	{ id: "E1", type: "equipment", name: "Projector", quantity: 2 },
];

const MCP_NOTIFY_CONFIG: ReadonlyArray<{
	serverId: string;
	toolName: string;
	args: (userId: string, message: string) => Record<string, string>;
}> = [
	{ serverId: "slack", toolName: "send_message", args: (channel, message) => ({ channel, message }) },
	{ serverId: "email", toolName: "send_email", args: (to, body) => ({ to, body }) },
];

// ---------------------------------------------------------------------------
// Helpers (pure)
// ---------------------------------------------------------------------------

function generateId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function todayDateString(): string {
	return new Date().toISOString().slice(0, 10);
}

function formatAssignmentLine(a: Assignment): string {
	const due = a.dueReturnAt ? `, due ${a.dueReturnAt.slice(0, 10)}` : "";
	return `${a.resourceId} (assigned ${a.assignedAt.slice(0, 10)}${due})`;
}

function appendConversation(
	conversationByUser: Record<string, ConversationMessage[]>,
	userId: string,
	userContent: string,
	assistantContent: string
): Record<string, ConversationMessage[]> {
	const prev = conversationByUser[userId] ?? [];
	const next = [
		...prev,
		{ role: "user" as const, content: userContent },
		{ role: "assistant" as const, content: assistantContent },
	].slice(-CONVERSATION_CAP_PER_USER);
	return { ...conversationByUser, [userId]: next };
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export class ResourceAllocationAgent extends Agent<Env, ResourceAllocationState> {
	override initialState: ResourceAllocationState = {
		resources: [],
		assignments: [],
		waitlist: [],
		utilizationLog: [],
		notifications: {},
		conversationByUser: {},
	};

	override async onStart(): Promise<void> {
		this.seedResourcesIfEmpty();
		await this.schedule(REMINDER_CRON, "checkReturnReminders", {});
		await this.registerMcpServers();
	}

	private seedResourcesIfEmpty(): void {
		if (this.state.resources.length > 0) return;
		this.setState({
			...this.state,
			conversationByUser: this.state.conversationByUser ?? {},
			resources: [...DEFAULT_RESOURCES],
		});
	}

	private async registerMcpServers(): Promise<void> {
		const entries: Array<[string, string | undefined]> = [
			["slack", this.env.SLACK_MCP_URL],
			["email", this.env.EMAIL_MCP_URL],
		];
		for (const [name, url] of entries) {
			if (!url) continue;
			try {
				await this.addMcpServer(name, url, {});
			} catch (e) {
				console.error(`[ResourceAllocationAgent] Failed to add ${name} MCP server:`, e);
			}
		}
	}

	/**
	 * Notify a user via an MCP server (Slack or Email). Never throws.
	 */
	private async notifyViaMcp(
		userId: string,
		message: string,
		preferServerId?: string
	): Promise<void> {
		const servers = this.mcp.listServers();
		if (!servers?.length) return;

		const order =
			preferServerId === "email"
				? [...MCP_NOTIFY_CONFIG].reverse()
				: [...MCP_NOTIFY_CONFIG];

		for (const { serverId, toolName, args } of order) {
			const conn = this.mcp.mcpConnections[serverId];
			if (!conn || conn.connectionState !== "ready") continue;
			try {
				await this.mcp.callTool({
					serverId,
					name: toolName,
					arguments: args(userId, message),
				});
				return;
			} catch (e) {
				console.error(`[ResourceAllocationAgent] MCP notify (${serverId}) failed:`, e);
			}
		}
	}

	private activeAssignmentCount(resourceId: string): number {
		return this.state.assignments.filter(
			(a) => a.resourceId === resourceId && a.status === "active"
		).length;
	}

	private getNextWaitlistEntry(resourceId: string): WaitlistEntry | undefined {
		return this.state.waitlist
			.filter((w) => w.resourceId === resourceId)
			.sort((a, b) => new Date(a.requestedAt).getTime() - new Date(b.requestedAt).getTime())[0];
	}

	private appendNotification(
		notifications: Record<string, string[]>,
		userId: string,
		message: string
	): Record<string, string[]> {
		const prev = notifications[userId] ?? [];
		return { ...notifications, [userId]: [...prev, message] };
	}

	@callable()
	async requestResource(
		resourceId: string,
		userId: string,
		dueReturnAt?: string
	): Promise<{ ok: boolean; message: string; assignmentId?: string; waitlistPosition?: number }> {
		const resource = this.state.resources.find((r) => r.id === resourceId);
		if (!resource) {
			return { ok: false, message: `Unknown resource: ${resourceId}` };
		}

		const used = this.activeAssignmentCount(resourceId);
		if (used < resource.quantity) {
			const assignment: Assignment = {
				id: generateId(),
				resourceId,
				userId,
				assignedAt: new Date().toISOString(),
				dueReturnAt,
				status: "active",
			};
			this.setState({
				...this.state,
				assignments: [...this.state.assignments, assignment],
			});
			return {
				ok: true,
				message: `Assigned ${resource.name} to you.`,
				assignmentId: assignment.id,
			};
		}

		const waitlistEntry: WaitlistEntry = {
			id: generateId(),
			resourceId,
			userId,
			requestedAt: new Date().toISOString(),
		};
		const waitlist = [...this.state.waitlist, waitlistEntry];
		this.setState({ ...this.state, waitlist });

		const position =
			this.state.waitlist.filter((w) => w.resourceId === resourceId).length + 1;
		const waitlistMessage = `You're #${position} for ${resource.name}. We'll notify you when it's available.`;
		await this.notifyViaMcp(userId, waitlistMessage);

		return {
			ok: false,
			message: `No availability. You were added to the waitlist (position ${position}).`,
			waitlistPosition: position,
		};
	}

	@callable()
	async returnResource(
		resourceId: string,
		userId: string
	): Promise<{ ok: boolean; message: string; autoAssigned?: string }> {
		const assignment = this.state.assignments.find(
			(a) => a.resourceId === resourceId && a.userId === userId && a.status === "active"
		);
		if (!assignment) {
			return { ok: false, message: `No active assignment found for ${resourceId} and you.` };
		}

		const assignments = this.state.assignments.map((a) =>
			a.id === assignment.id ? { ...a, status: "returned" as const } : a
		);
		let nextState: ResourceAllocationState = { ...this.state, assignments };
		let autoAssignedUserId: string | undefined;

		const next = this.getNextWaitlistEntry(resourceId);
		if (next) {
			const resource = this.state.resources.find((r) => r.id === resourceId)!;
			const newAssignment: Assignment = {
				id: generateId(),
				resourceId,
				userId: next.userId,
				assignedAt: new Date().toISOString(),
				status: "active",
			};
			nextState = {
				...nextState,
				assignments: [...nextState.assignments, newAssignment],
				waitlist: nextState.waitlist.filter((w) => w.id !== next.id),
				notifications: this.appendNotification(
					nextState.notifications,
					next.userId,
					`${resource.name} is now assigned to you.`
				),
			};
			autoAssignedUserId = next.userId;
			await this.notifyViaMcp(next.userId, `${resource.name} is now assigned to you.`);
		}

		this.setState(nextState);
		return {
			ok: true,
			message: autoAssignedUserId
				? `Returned. Next in line (${autoAssignedUserId}) was auto-assigned.`
				: "Returned successfully.",
			autoAssigned: autoAssignedUserId,
		};
	}

	@callable()
	async listMyAssignments(userId: string): Promise<Assignment[]> {
		return this.state.assignments.filter(
			(a) => a.userId === userId && a.status === "active"
		);
	}

	@callable()
	async listResources(type?: ResourceType): Promise<Array<Resource & { available: number }>> {
		const list = type
			? this.state.resources.filter((r) => r.type === type)
			: this.state.resources;
		return list.map((r) => ({
			...r,
			available: r.quantity - this.activeAssignmentCount(r.id),
		}));
	}

	@callable()
	async getUtilization(
		resourceId?: string,
		dateFrom?: string,
		dateTo?: string
	): Promise<{
		byResource: Array<{
			resourceId: string;
			date: string;
			allocated: number;
			total: number;
			utilization: number;
		}>;
	}> {
		const from = dateFrom ?? todayDateString();
		const to = dateTo ?? todayDateString();
		const log = this.state.utilizationLog.filter(
			(e) =>
				(!resourceId || e.resourceId === resourceId) &&
				e.date >= from &&
				e.date <= to
		);
		const byResource = log.map((e) => ({
			resourceId: e.resourceId,
			date: e.date,
			allocated: e.allocated,
			total: e.total,
			utilization: e.total > 0 ? e.allocated / e.total : 0,
		}));
		return { byResource };
	}

	@callable()
	async clearNotifications(userId: string): Promise<void> {
		const notifications = { ...this.state.notifications };
		delete notifications[userId];
		this.setState({ ...this.state, notifications });
	}

	@callable()
	async getRecommendations(userId: string): Promise<string[]> {
		const stateSummary = this.buildStateSummary(userId);
		const systemPrompt = `You are the resource allocation assistant. Based on current state, suggest 1-5 short recommendations (e.g. "Consider requesting P2", "You have L1; return by Friday"). Reply with only the suggestions, one per line, no numbering or extra text.`;
		const messages: Array<{ role: "system" | "user"; content: string }> = [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: stateSummary },
		];
		try {
			const result = (await this.env.AI.run(LLAMA_MODEL, {
				messages,
				max_tokens: 256,
			})) as { response?: string };
			const text = typeof result?.response === "string" ? result.response.trim() : "";
			if (!text) return [];
			return text
				.split(/\n+/)
				.map((s) => s.replace(/^[\d.)\-\*]\s*/, "").trim())
				.filter(Boolean);
		} catch (e) {
			console.error("[ResourceAllocationAgent] getRecommendations failed:", e);
			return [];
		}
	}

	@callable()
	async handleChat(userId: string, message: string): Promise<string> {
		const trimmed = message.trim();
		const trimmedLower = trimmed.toLowerCase();
		const conversationByUser = this.state.conversationByUser ?? {};

		const requestMatch = trimmedLower.match(/request\s+(?:resource\s+)?(\S+)/);
		if (requestMatch) {
			const res = await this.requestResource(requestMatch[1].toUpperCase(), userId);
			this.setState({
				...this.state,
				conversationByUser: appendConversation(
					conversationByUser,
					userId,
					trimmed,
					res.message
				),
			});
			return res.message;
		}

		const returnMatch = trimmedLower.match(/return\s+(?:resource\s+)?(\S+)/);
		if (returnMatch) {
			const res = await this.returnResource(returnMatch[1].toUpperCase(), userId);
			this.setState({
				...this.state,
				conversationByUser: appendConversation(
					conversationByUser,
					userId,
					trimmed,
					res.message
				),
			});
			return res.message;
		}

		if (/\b(my\s+)?(assignments|what\s+do\s+i\s+have|list\s+mine)\b/.test(trimmedLower)) {
			const list = await this.listMyAssignments(userId);
			const reply =
				list.length === 0
					? "You have no current assignments."
					: list.map(formatAssignmentLine).join("\n");
			this.setState({
				...this.state,
				conversationByUser: appendConversation(
					conversationByUser,
					userId,
					trimmed,
					reply
				),
			});
			return reply;
		}

		if (/\b(list\s+)?resources\b/.test(trimmedLower)) {
			const list = await this.listResources();
			const reply = list
				.map((r) => `${r.id} ${r.name}: ${r.available}/${r.quantity} available`)
				.join("\n");
			this.setState({
				...this.state,
				conversationByUser: appendConversation(
					conversationByUser,
					userId,
					trimmed,
					reply
				),
			});
			return reply;
		}

		if (/\butilization\b/.test(trimmedLower)) {
			const { byResource } = await this.getUtilization();
			const reply =
				byResource.length === 0
					? "No utilization data for this period."
					: byResource
							.map(
								(e) =>
									`${e.resourceId} ${e.date}: ${(e.utilization * 100).toFixed(0)}% (${e.allocated}/${e.total})`
							)
							.join("\n");
			this.setState({
				...this.state,
				conversationByUser: appendConversation(
					conversationByUser,
					userId,
					trimmed,
					reply
				),
			});
			return reply;
		}

		// No regex match: use Llama with system prompt, state summary, and conversation history
		const stateSummary = this.buildStateSummary(userId);
		const history = conversationByUser[userId] ?? [];
		const lastN = history.slice(-CONVERSATION_CAP_PER_USER);
		const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
			{ role: "system", content: this.getSystemPrompt() + "\n\n" + stateSummary },
			...lastN.map((m) => ({ role: m.role, content: m.content })),
			{ role: "user", content: trimmed },
		];
		let reply: string;
		try {
			const result = (await this.env.AI.run(LLAMA_MODEL, {
				messages,
				max_tokens: 512,
			})) as { response?: string };
			reply =
				typeof result?.response === "string" && result.response.trim()
					? result.response.trim()
					: "I couldn't generate a response. Try: request <id>, return <id>, list resources, or ask for recommendations.";
		} catch (e) {
			console.error("[ResourceAllocationAgent] Llama run failed:", e);
			reply =
				"Something went wrong with the assistant. You can still say: request <id>, return <id>, list resources, or utilization.";
		}
		this.setState({
			...this.state,
			conversationByUser: appendConversation(conversationByUser, userId, trimmed, reply),
		});
		return reply;
	}

	private getSystemPrompt(): string {
		const resourceList = (this.state.resources ?? [])
			.map((r) => `${r.id} (${r.name})`)
			.join(", ");
		return `You are the resource allocation assistant. Users can request or return resources by id, list resources, list their assignments, or ask for recommendations.
Available resource IDs and names: ${resourceList || "None yet."}
Commands: request <id>, return <id>, list resources, list my assignments (or "what do I have"), utilization.
When relevant, suggest available resources or next actions (e.g. return by due date, or request something they don't have). Keep replies concise.`;
	}

	private buildStateSummary(userId: string): string {
		const assignments = (this.state.assignments ?? []).filter(
			(a) => a.userId === userId && a.status === "active"
		);
		const waitlist = (this.state.waitlist ?? []).filter((w) => w.userId === userId);
		const notifCount = (this.state.notifications ?? {})[userId]?.length ?? 0;
		const lines: string[] = [
			"Current state for this user:",
			`Assignments: ${assignments.length === 0 ? "none" : assignments.map(formatAssignmentLine).join("; ")}`,
			`Waitlist positions: ${waitlist.length === 0 ? "none" : waitlist.map((w) => w.resourceId).join(", ")}`,
			`Unread notifications: ${notifCount}`,
		];
		return lines.join("\n");
	}

	async checkReturnReminders(_payload: Record<string, never>): Promise<void> {
		const now = Date.now();
		const windowEnd = new Date(now + REMINDER_HOURS_AHEAD * 60 * 60 * 1000);
		let notifications = { ...this.state.notifications };

		for (const a of this.state.assignments) {
			if (a.status !== "active" || !a.dueReturnAt) continue;
			const due = new Date(a.dueReturnAt);
			if (due > windowEnd || due < new Date(now)) continue;

			const resource = this.state.resources.find((r) => r.id === a.resourceId);
			const msg = `Reminder: Please return ${resource?.name ?? a.resourceId} by ${a.dueReturnAt.slice(0, 10)}.`;
			notifications = this.appendNotification(notifications, a.userId, msg);
			await this.notifyViaMcp(a.userId, msg);
		}

		const date = todayDateString();
		const utilizationLog = [...this.state.utilizationLog];
		for (const r of this.state.resources) {
			const alreadyLogged = utilizationLog.some(
				(e) => e.resourceId === r.id && e.date === date
			);
			if (alreadyLogged) continue;
			utilizationLog.push({
				resourceId: r.id,
				date,
				allocated: this.activeAssignmentCount(r.id),
				total: r.quantity,
			});
		}

		this.setState({
			...this.state,
			notifications,
			utilizationLog,
		});
	}
}
