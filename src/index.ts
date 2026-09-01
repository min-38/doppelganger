import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initSchema } from "./db.js";
import { tools } from "./tools/index.js";

const server = new McpServer({ name: "doppelganger", version: "0.1.0" });

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
