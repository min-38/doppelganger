import type { ZodRawShape } from "zod";
import { categoryTools } from "./category.js";
import { insertTools } from "./insert.js";
import { metaTools } from "./meta.js";
import { queryTools } from "./query.js";
import { z } from "zod";

export type ToolDef = {
  name: string;
  config: { title?: string; description: string; inputSchema?: ZodRawShape };
  /** Returns whatever should be shown to the caller; it gets JSON-stringified. */
  run: (args: any) => unknown | Promise<unknown>;
};

const ping: ToolDef = {
  name: "ping",
  config: {
    description: "Health check. Returns pong plus the echoed message.",
    inputSchema: { message: z.string().optional() },
  },
  run: ({ message }) => ({ pong: true, message: message ?? null }),
};

export const tools: ToolDef[] = [ping, ...metaTools, ...categoryTools, ...insertTools, ...queryTools];
