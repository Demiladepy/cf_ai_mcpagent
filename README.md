# Resource Allocation Agent

Manages shared resources (equipment, licenses, parking spots). Employees request and return items via chat; the agent tracks assignments, sends return reminders, and provides utilization metrics. Waitlists and automated assignment are supported.

## Stack

- **Cloudflare Agents SDK** (`agents`) on Durable Objects
- **JavaScript/TypeScript** worker

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars   # optional, for any future secrets
npm run dev
```

## Endpoints

- **Agent (WebSocket + HTTP)**  
  Connect to the agent at:
  - Path: `/agents/resource-allocation-agent/default`  
  (or use any instance name, e.g. `default`, `office-1`.)

  Clients can call these methods via the Agents SDK (e.g. `agent.stub.requestResource(...)` or `handleChat(userId, message)`):
  - `requestResource(resourceId, userId, dueReturnAt?)` – request a resource (or join waitlist)
  - `returnResource(resourceId, userId)` – return a resource (next on waitlist is auto-assigned)
  - `listMyAssignments(userId)` – list current assignments
  - `listResources(type?)` – list resources and availability
  - `getUtilization(resourceId?, dateFrom?, dateTo?)` – utilization metrics
  - `handleChat(userId, message)` – simple chat: "request P1", "return P1", "list resources", "what do I have", "utilization"
  - `clearNotifications(userId)` – clear pending reminders for a user

- **Utilization API (HTTP)**  
  - `GET /api/utilization?resourceId=&dateFrom=&dateTo=`  
  Returns JSON utilization data for dashboards.

## Chat commands (via `handleChat(userId, message)`)

- `request P1` or `request resource P1` – request resource by id
- `return P1` – return resource
- `list resources` or `resources` – list all resources and availability
- `what do I have` or `my assignments` – list your assignments
- `utilization` – show utilization metrics

## Return reminders

A daily job runs at 9:00 (cron `0 9 * * *`), finds assignments with `dueReturnAt` in the next 24 hours, and pushes reminder messages into `state.notifications[userId]`. If MCP is configured, the agent also sends reminders via Slack or Email MCP. Clients can show in-app notifications and call `clearNotifications(userId)` when done.

## MCP (Model Context Protocol) notifications

The agent can optionally call **external MCP servers** to send notifications. When configured, it will:

- Notify users when they are added to a waitlist (position and resource name).
- Notify the next user when a resource becomes available (auto-assignment).
- Send return reminders (in addition to in-app `state.notifications`).

**Configuration (opt-in):** Set environment variables (or Wrangler `vars` / secrets):

- `SLACK_MCP_URL` – URL of a Slack/Teams MCP server (e.g. `https://your-slack-mcp.example.com/mcp`).
- `EMAIL_MCP_URL` – URL of an Email MCP server.

The agent registers these in `onStart()` with `addMcpServer`. If a server fails to connect, the agent logs and continues; core behavior is unchanged without MCP.

**Tool names and arguments** depend on your MCP server. This implementation uses:

- **Slack:** `send_message` with `channel` (userId) and `message`.
- **Email:** `send_email` with `to` (userId) and `body`.

Adjust `notifyViaMcp` in [src/ResourceAllocationAgent.ts](src/ResourceAllocationAgent.ts) if your server exposes different tool names or parameters. OAuth-protected MCP servers are supported via the SDK’s `addMcpServer` flow. See [Cloudflare Agents MCP docs](https://developers.cloudflare.com/agents/api-reference/mcp-agent-api/).

## Deploy

```bash
npm run deploy
```

Then use your worker URL (e.g. `https://resource-allocation-agent.<account>.workers.dev`) for the agent path and `/api/utilization`.
