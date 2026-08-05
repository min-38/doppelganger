import { z } from "zod";
import { db, META_TABLE, initSchema } from "../db.js";
import { categorySimilarity, rankEntries, SIMILARITY_THRESHOLD, type MetaEntry } from "../utils/score.js";
import type { ToolDef } from "./index.js";

/** Reads the whole registry. It stays small (one row per category), so no paging. */
export async function readMeta(): Promise<MetaEntry[]> {
  await initSchema();
  const result = await db.execute(
    `SELECT collection_name, description, category_group, keywords, sample_fields, created_at, updated_at
       FROM ${META_TABLE} ORDER BY collection_name`,
  );
  return result.rows.map((row) => ({
    collection_name: String(row.collection_name),
    description: String(row.description),
    category_group: String(row.category_group),
    keywords: JSON.parse(String(row.keywords ?? "[]")),
    sample_fields: JSON.parse(String(row.sample_fields ?? "[]")),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }));
}

const listCollections: ToolDef = {
  name: "list_collections",
  config: {
    description:
      "List every registered collection with its metadata (description, category_group, keywords, sample_fields). " +
      "Use before create_category to check whether a suitable collection already exists.",
  },
  run: async () => {
    const collections = await readMeta();
    return { count: collections.length, collections };
  },
};

const findRelevantCollections: ToolDef = {
  name: "find_relevant_collections",
  config: {
    description:
      "Search the _meta registry (description / keywords / category_group / name) and return the most relevant collections for a question. " +
      "ALWAYS call this before query_records — never scan every collection. Pass the user's question as-is; Korean is fine. " +
      "If it returns nothing, the data has not been recorded yet.",
    inputSchema: {
      query: z.string().min(1).describe("The user's question or topic, e.g. '오늘 뭐 먹을까'"),
      limit: z.number().int().min(1).max(10).optional().describe("Max candidates to return (default 3)"),
    },
  },
  run: async ({ query, limit }: { query: string; limit?: number }) => {
    const matches = rankEntries(query, await readMeta(), limit ?? 3);
    return {
      query,
      count: matches.length,
      matches: matches.map(({ entry, score }) => ({ score, ...entry })),
    };
  },
};

async function countRecords(collectionName: string): Promise<number> {
  const result = await db.execute(`SELECT count(*) AS n FROM ${collectionName}`);
  return Number(result.rows[0]?.n ?? 0);
}

const suggestMergeCandidates: ToolDef = {
  name: "suggest_merge_candidates",
  config: {
    description:
      "Maintenance: list pairs of collections that look like duplicates of each other, with a similarity score and each side's record count. " +
      "Suggestion only — merging is manual: re-insert the smaller side's records into the larger one, then delete the leftovers. " +
      "Worth running once there are more than ~20 collections.",
    inputSchema: {
      threshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe(`Minimum similarity to report (default ${SIMILARITY_THRESHOLD})`),
    },
  },
  run: async ({ threshold }: { threshold?: number }) => {
    const entries = await readMeta();
    const minimum = threshold ?? SIMILARITY_THRESHOLD;
    const counts = new Map<string, number>();
    for (const entry of entries) counts.set(entry.collection_name, await countRecords(entry.collection_name));

    const pairs = [];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const similarity = Number(categorySimilarity(entries[i], entries[j]).toFixed(3));
        if (similarity < minimum) continue;
        const side = (entry: MetaEntry) => ({
          collection_name: entry.collection_name,
          description: entry.description,
          keywords: entry.keywords,
          record_count: counts.get(entry.collection_name) ?? 0,
        });
        pairs.push({ similarity, a: side(entries[i]), b: side(entries[j]) });
      }
    }
    pairs.sort((x, y) => y.similarity - x.similarity);

    return { threshold: minimum, collection_count: entries.length, count: pairs.length, candidates: pairs };
  },
};

export const metaTools: ToolDef[] = [listCollections, findRelevantCollections, suggestMergeCandidates];
