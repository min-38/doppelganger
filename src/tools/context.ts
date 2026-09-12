import { z } from "zod";
import { db } from "../db.js";
import { readRules, RULES_COLLECTION } from "../rules.js";
import { projectRecord } from "../utils/project.js";
import { rankEntries } from "../utils/score.js";
import { readMeta } from "./meta.js";
import type { ToolDef } from "./index.js";

export const ADVICE_COLLECTION = "advice_log";
const ADVICE_LIMIT = 15;
const HABITS_LIMIT = 30;
const REVIEWS_LIMIT = 2;

type Row = { id: number; date: string; data: Record<string, unknown> };

/** Rows from a known collection, or none if it was never created. */
async function rows(sql: string, args: (string | number)[] = []): Promise<Row[]> {
  try {
    const result = await db.execute({ sql, args });
    return result.rows.map((row) => ({ id: Number(row.id), date: String(row.date), data: JSON.parse(String(row.data)) }));
  } catch (error) {
    if (String(error).includes("no such table")) return [];
    throw error;
  }
}

const flat = (row: Row, fields?: string[]) => ({ id: row.id, date: row.date, ...projectRecord(row.data, fields) });

const getContext: ToolDef = {
  name: "get_context",
  config: {
    description:
      "Call BEFORE giving advice, a plan or an evaluation about the user's life (training, diet, money, career, habits …). " +
      "One call returns what keeps advice consistent across conversations and models: the collections for the topic, the user's rules for them, " +
      "earlier advice on those collections (active first), lasting habits and preferences, and the 'improve' notes of the latest period reviews. " +
      "It does not return the records themselves — read those with query_records / get_stats for the numbers behind the advice.",
    inputSchema: {
      topic: z.string().min(1).describe("What the advice is about, as the user said it, e.g. '오늘 운동 평가' or '이번 달 식비 줄이기'"),
    },
  },
  run: async ({ topic }: { topic: string }) => {
    const registry = (await readMeta()).filter(
      (entry) => entry.collection_name !== RULES_COLLECTION && entry.collection_name !== ADVICE_COLLECTION,
    );
    const names = rankEntries(topic, registry, 3).map(({ entry }) => entry.collection_name);

    // Advice is filed under a collection name. With no matching collection,
    // fall back to whatever advice is still active anywhere.
    const statusOrder = `CASE json_extract(data, '$.status') WHEN 'active' THEN 0 ELSE 1 END`;
    const advice =
      names.length > 0
        ? await rows(
            `SELECT id, date, data FROM ${ADVICE_COLLECTION}
              WHERE json_extract(data, '$.domain') IN (${names.map(() => "?").join(", ")})
              ORDER BY ${statusOrder}, date DESC, id DESC LIMIT ?`,
            [...names, ADVICE_LIMIT],
          )
        : await rows(
            `SELECT id, date, data FROM ${ADVICE_COLLECTION}
              WHERE json_extract(data, '$.status') = 'active' ORDER BY date DESC, id DESC LIMIT ?`,
            [ADVICE_LIMIT],
          );

    const [rules, habits, reviews] = await Promise.all([
      readRules(["global", ...names]),
      // habits.domain is free text (both '운동' and 'workout' occur), so every habit comes back — there are few.
      rows(`SELECT id, date, data FROM habits ORDER BY date DESC, id DESC LIMIT ?`, [HABITS_LIMIT]),
      rows(`SELECT id, date, data FROM reviews ORDER BY date DESC, id DESC LIMIT ?`, [REVIEWS_LIMIT]),
    ]);

    return {
      topic,
      collections: names,
      rules,
      advice: advice.map((row) => flat(row)),
      habits: habits.map((row) => flat(row)),
      recent_reviews: reviews.map((row) => flat(row, ["kind", "key", "improve"])),
      guidance: [
        "Stay consistent with advice whose status is active. If you now recommend something different, first say what changed and why.",
        `Record new advice or plans in ${ADVICE_COLLECTION} with domain set to the collection it concerns${names.length > 0 ? ` (here: ${names.join(", ")})` : ""}.`,
        `When new advice replaces active advice, insert a new row with supersedes = the old id, then set only the old row's status to superseded.`,
      ],
    };
  },
};

export const contextTools: ToolDef[] = [getContext];
