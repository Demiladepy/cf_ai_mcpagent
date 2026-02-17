/**
 * Resource Allocation Agent – Worker entry point.
 *
 * - GET /api/utilization: read-only metrics (query: resourceId, dateFrom, dateTo).
 * - /agents/resource-allocation-agent/:name: WebSocket + HTTP for the agent.
 * - /message, /random: legacy demo routes.
 */
import { getAgentByName, routeAgentRequest } from "agents";
import { ResourceAllocationAgent } from "./ResourceAllocationAgent.js";

export { ResourceAllocationAgent };

const DEFAULT_AGENT_NAME = "default";
const CORS_HEADERS = { "Access-Control-Allow-Origin": "*" };

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
