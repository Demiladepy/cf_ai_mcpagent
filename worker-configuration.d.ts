interface Env {
	ResourceAllocationAgent: DurableObjectNamespace;
	ASSETS?: Fetcher;
	/** Optional MCP server URL for Slack/Teams notifications (opt-in). */
	SLACK_MCP_URL?: string;
	/** Optional MCP server URL for email notifications (opt-in). */
	EMAIL_MCP_URL?: string;
}
