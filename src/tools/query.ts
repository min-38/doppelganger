import { z } from "zod";
import { db } from "../db.js";
import { buildWhere, jsonPath } from "../utils/filter.js";
import { requireRegistered } from "./insert.js";
import type { ToolDef } from "./index.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

const conditionSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z
    .object({
      eq: z.unknown().optional(),
      ne: z.unknown().optional(),
      gte: z.union([z.string(), z.number()]).optional(),
      lte: z.union([z.string(), z.number()]).optional(),
      gt: z.union([z.string(), z.number()]).optional(),
      lt: z.union([z.string(), z.number()]).optional(),
      contains: z.string().optional(),
      in: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
    })
    .strict(),
]);

const queryRecords: ToolDef = {
  name: "query_records",
  config: {
    description:
      "Read records from ONE collection. Call find_relevant_collections first and query only the collections it returned — never loop over every collection. " +
      "Filter values are matched against fields inside the stored record. Supported per-field conditions: a plain value (equality) or " +
      "{ eq, ne, gte, lte, gt, lt, contains, in }. Date fields are compared as 'YYYY-MM-DD HH:MM:SS' strings, so a range is " +
      "{ date: { gte: '2026-08-01', lte: '2026-08-07' } } — an end bound given as a bare date covers that whole day. Newest first.",
    inputSchema: {
      collection_name: z.string().describe("A collection returned by find_relevant_collections"),
      filter: z.record(z.string(), conditionSchema).optional().describe("Field conditions, e.g. { food: { contains: '김치' } }"),
      limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Max rows (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`),
      order_by: z.string().optional().describe("Record field to sort by (default: date, falling back to insertion order)"),
      ascending: z.boolean().optional().describe("Sort oldest first (default false)"),
    },
  },
  run: async ({
    collection_name,
    filter,
    limit,
    order_by,
    ascending,
  }: {
    collection_name: string;
    filter?: Record<string, unknown>;
    limit?: number;
    order_by?: string;
    ascending?: boolean;
  }) => {
    await requireRegistered(collection_name);
    const where = buildWhere(filter ?? {});
    const direction = ascending ? "ASC" : "DESC";
    const sortPath = jsonPath(order_by ?? "date");
    const rowLimit = Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    const result = await db.execute({
      sql: `SELECT id, data, created_at, updated_at FROM ${collection_name}
            ${where.sql}
            ORDER BY ${sortPath} ${direction}, id ${direction}
            LIMIT ?`,
      args: [...where.args, rowLimit] as never,
    });

    return {
      collection_name,
      count: result.rows.length,
      limit: rowLimit,
      records: result.rows.map((row) => ({
        id: Number(row.id),
        ...JSON.parse(String(row.data)),
        created_at: String(row.created_at),
        updated_at: String(row.updated_at),
      })),
    };
  },
};

export const queryTools: ToolDef[] = [queryRecords];
