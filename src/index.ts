/**
 * Resource Allocation Agent – Worker entry point.
 *
 * - GET /api/utilization: read-only metrics (query: resourceId, dateFrom, dateTo).
 * - POST /api/voice: transcribe audio via Workers AI Whisper, returns { text }.
 * - /agents/resource-allocation-agent/:name: WebSocket + HTTP for the agent.
 * - /message, /random: legacy demo routes.
 */
import { getAgentByName, routeAgentRequest } from "agents";
import { ResourceAllocationAgent } from "./ResourceAllocationAgent.js";

export { ResourceAllocationAgent };

const DEFAULT_AGENT_NAME = "default";
const CORS_HEADERS = { "Access-Control-Allow-Origin": "*" };
const WHISPER_MODEL = "@cf/openai/whisper";

async function getAudioBytes(request: Request): Promise<Uint8Array | null> {
	const contentType = request.headers.get("content-type") ?? "";
	if (contentType.includes("application/json")) {
		const body = (await request.json()) as { audio?: string };
		if (typeof body?.audio !== "string") return null;
		const binary = atob(body.audio);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	}
	if (contentType.includes("multipart/form-data")) {
		const formData = await request.formData();
		const file = formData.get("audio") ?? formData.get("file");
		if (!file || typeof file === "string") return null;
		const blob = file as Blob;
		const buf = await blob.arrayBuffer();
		return new Uint8Array(buf);
	}
	// Raw body (e.g. audio/* or application/octet-stream)
	const buf = await request.arrayBuffer();
	return buf.byteLength > 0 ? new Uint8Array(buf) : null;
}

export default {
	async fetch(
		request: Request,
		env: Env,
		_ctx: ExecutionContext
	): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/api/utilization" && request.method === "GET") {
			const agent = await getAgentByName(env.ResourceAllocationAgent, DEFAULT_AGENT_NAME);
			const data = await agent.getUtilization(
				url.searchParams.get("resourceId") ?? undefined,
				url.searchParams.get("dateFrom") ?? undefined,
				url.searchParams.get("dateTo") ?? undefined
			);
			return Response.json(data, { headers: CORS_HEADERS });
		}

		if (url.pathname === "/api/voice" && request.method === "POST") {
			const audio = await getAudioBytes(request);
			if (!audio || audio.length === 0) {
				return Response.json(
					{ error: "No audio provided. Send multipart form 'audio', JSON { audio: base64 }, or raw body." },
					{ status: 400, headers: CORS_HEADERS }
				);
			}
			try {
				const result = (await env.AI.run(WHISPER_MODEL, {
					audio: [...audio],
				})) as { text?: string };
				const text = typeof result?.text === "string" ? result.text.trim() : "";
				return Response.json({ text }, { headers: CORS_HEADERS });
			} catch (e) {
				console.error("[api/voice] Whisper failed:", e);
				return Response.json(
					{ error: "Transcription failed" },
					{ status: 500, headers: CORS_HEADERS }
				);
			}
		}

		const agentResponse = await routeAgentRequest(request, env, { cors: true });
		if (agentResponse) return agentResponse;

		switch (url.pathname) {
			case "/message":
				return new Response("Hello, Resource Allocation Agent!");
			case "/random":
				return new Response(crypto.randomUUID());
			default:
				return new Response("Not Found", { status: 404 });
		}
	},
} satisfies ExportedHandler<Env>;
