import { z } from "zod";
import { db } from "../db.js";
import { buildWhere, conditionSchema, jsonPath } from "../utils/filter.js";
import { projectRecord } from "../utils/project.js";
import { requireRegistered } from "./insert.js";
import type { ToolDef } from "./index.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

const queryRecords: ToolDef = {
  name: "query_records",
  config: {
    description:
      "Read records from ONE collection. Call find_relevant_collections first and query only the collections it returned — never loop over every collection. " +
      "Filter values are matched against fields inside the stored record. Supported per-field conditions: a plain value (equality) or " +
      "{ eq, ne, gte, lte, gt, lt, contains, in }. Date fields are compared as 'YYYY-MM-DD HH:MM:SS' strings, so a range is " +
      "{ date: { gte: '2026-08-01', lte: '2026-08-07' } } — an end bound given as a bare date covers that whole day. " +
      "`date` is when the event happened (an indexed column); created_at/updated_at are when the row was written. Newest first. " +
      "Ask for `fields` whenever you know which ones you need — records can be several KB each, and long values are cut short unless full: true.",
    inputSchema: {
      collection_name: z.string().describe("A collection returned by find_relevant_collections"),
      filter: z.record(z.string(), conditionSchema).optional().describe("Field conditions, e.g. { food: { contains: '김치' } }"),
      limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Max rows (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`),
      order_by: z.string().optional().describe("Record field to sort by (default: date, falling back to insertion order)"),
      ascending: z.boolean().optional().describe("Sort oldest first (default false)"),
      fields: z
        .array(z.string())
        .optional()
        .describe("Return only these record fields, e.g. ['title','status'] — omit for everything"),
      full: z.boolean().optional().describe("Return long text values in full instead of truncating them"),
    },
  },
  run: async ({
    collection_name,
    filter,
    limit,
    order_by,
    ascending,
    fields,
    full,
  }: {
    collection_name: string;
    filter?: Record<string, unknown>;
    limit?: number;
    order_by?: string;
    ascending?: boolean;
    fields?: string[];
    full?: boolean;
  }) => {
    await requireRegistered(collection_name);
    const where = buildWhere(filter ?? {});
    const direction = ascending ? "ASC" : "DESC";
    const sortPath = jsonPath(order_by ?? "date");
    const rowLimit = Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    const result = await db.execute({
      sql: `SELECT id, date, data, created_at, updated_at FROM ${collection_name}
            ${where.sql}
            ORDER BY ${sortPath} ${direction}, id ${direction}
            LIMIT ?`,
      args: [...where.args, rowLimit] as never,
    });

    return {
      collection_name,
      count: result.rows.length,
      limit: rowLimit,
      fields: fields ?? null,
      records: result.rows.map((row) => ({
        id: Number(row.id),
        date: String(row.date),
        ...projectRecord(JSON.parse(String(row.data)), fields, full),
        created_at: String(row.created_at),
        updated_at: String(row.updated_at),
      })),
    };
  },
};

export const queryTools: ToolDef[] = [queryRecords];
