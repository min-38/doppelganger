import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initSchema } from "./db.js";
import { tools } from "./tools/index.js";

// Sent to every client on connect, whichever model is behind it. Kept short and
// stable: the rules themselves are data (ai_rules) and arrive in tool responses,
// so editing them never needs a server restart.
const INSTRUCTIONS = [
  "doppelganger is the user's personal lifelog database. Answer questions about the user's own life from stored records, never from memory.",
  "Reading: call find_relevant_collections first, then query_records on the 1-3 collections it returns. Use get_stats for sums and averages.",
  "Rules: the user's working rules are stored in the database and come back as `rules` in find_relevant_collections and describe_collection — global ones plus those for the collections involved. Follow them; they override your defaults.",
  "Advice: before giving advice, a plan or an evaluation, call get_context with the topic and stay consistent with the active advice it returns. Record new advice in advice_log; if it replaces earlier advice, say why and link it with supersedes.",
  "Protected values: fields the user entered can be protected by those rules. If update_record refuses a change, do not work around it — show the user what would change, and only after they agree retry with confirm: true and a reason.",
].join("\n");

const server = new McpServer({ name: "doppelganger", version: "0.1.0" }, { instructions: INSTRUCTIONS });

for (const tool of tools) {
  server.registerTool(tool.name, tool.config, async (args: any) => {
    try {
      const result = await tool.run(args ?? {});
      // Compact JSON: indentation added ~30% to every response for no gain.
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // stderr only — stdout is the MCP channel.
      console.error(`[${tool.name}] ${message}`);
      return { content: [{ type: "text" as const, text: message }], isError: true };
    }
  });
}

await initSchema();
await server.connect(new StdioServerTransport());
console.error(`doppelganger MCP server ready (${tools.length} tools)`);
