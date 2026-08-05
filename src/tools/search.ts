import { z } from "zod";
import { db } from "../db.js";
import { buildWhere } from "../utils/filter.js";
import { rankEntries, type MetaEntry } from "../utils/score.js";
import { readMeta } from "./meta.js";
import type { ToolDef } from "./index.js";

/** Hard ceiling on how many tables one call may touch — collections can grow into the hundreds. */
const MAX_TABLES = 10;
const MAX_PER_TABLE = 20;
const MAX_TOTAL = 100;

/** Which collections to search: the relevant ones when a keyword narrows it, else the newest few. */
function pickTargets(keyword: string | undefined, registry: MetaEntry[], maxTables: number): MetaEntry[] {
  if (!keyword) return registry.slice(0, maxTables);
  const ranked = rankEntries(keyword, registry, maxTables).map((hit) => hit.entry);
  // A keyword that matches no metadata may still appear inside the records
  // themselves, so fall back to scanning a bounded slice of the registry.
  return ranked.length > 0 ? ranked : registry.slice(0, maxTables);
}

const searchAcrossTables: ToolDef = {
  name: "search_across_tables",
  config: {
    description:
      "Search several collections at once and get one timeline back — for questions that do not name a category ('지난주에 뭐 했지', '8월에 있었던 일'). " +
      "date_from/date_to filter on the event date; keyword matches anywhere in a record's stored fields. " +
      `At most ${MAX_TABLES} collections are searched per call, chosen by relevance to the keyword. ` +
      "When you already know which collection holds the answer, use query_records instead — it is cheaper and can filter per field.",
    inputSchema: {
      keyword: z.string().min(1).optional().describe("Text to look for inside records, e.g. '스쿼트'"),
      date_from: z.string().optional().describe("Start of the period, e.g. '2026-08-01' (inclusive)"),
      date_to: z.string().optional().describe("End of the period, e.g. '2026-08-07' (inclusive, whole day)"),
      collections: z.array(z.string()).optional().describe("Restrict to these collections instead of picking by relevance"),
      limit: z.number().int().min(1).max(MAX_TOTAL).optional().describe(`Max records in total (default 50, max ${MAX_TOTAL})`),
    },
  },
  run: async ({
    keyword,
    date_from,
    date_to,
    collections,
    limit,
  }: {
    keyword?: string;
    date_from?: string;
    date_to?: string;
    collections?: string[];
    limit?: number;
  }) => {
    if (!keyword && !date_from && !date_to) {
      throw new Error("Pass a keyword, a date range, or both — an unbounded search would read every collection.");
    }
    const registry = await readMeta();
    const targets = collections
      ? registry.filter((entry) => collections.includes(entry.collection_name)).slice(0, MAX_TABLES)
      : pickTargets(keyword, registry, MAX_TABLES);

    const range: Record<string, unknown> = {};
    if (date_from !== undefined) range.gte = date_from;
    if (date_to !== undefined) range.lte = date_to;
    const where = buildWhere(Object.keys(range).length > 0 ? { date: range } : {});

    const total = Math.min(limit ?? 50, MAX_TOTAL);
    const hits = [];
    for (const entry of targets) {
      const conditions = [where.sql.replace(/^WHERE /, "")].filter(Boolean);
      const args = [...where.args];
      if (keyword) {
        // The blob holds every field, so one LIKE covers the whole record.
        conditions.push("data LIKE ?");
        args.push(`%${keyword}%`);
      }
      const result = await db.execute({
        sql: `SELECT id, date, data FROM ${entry.collection_name}
              ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
              ORDER BY date DESC, id DESC LIMIT ?`,
        args: [...args, MAX_PER_TABLE] as never,
      });
      for (const row of result.rows) {
        hits.push({
          collection_name: entry.collection_name,
          id: Number(row.id),
          date: String(row.date),
          ...(JSON.parse(String(row.data)) as Record<string, unknown>),
        });
      }
    }

    hits.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const truncated = hits.length > total;
    return {
      searched_collections: targets.map((entry) => entry.collection_name),
      skipped_collections: registry.length - targets.length,
      count: Math.min(hits.length, total),
      truncated,
      records: hits.slice(0, total),
    };
  },
};

export const searchTools: ToolDef[] = [searchAcrossTables];
