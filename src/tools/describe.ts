import { z } from "zod";
import { db } from "../db.js";
import { readRules } from "../rules.js";
import { categorySimilarity } from "../utils/score.js";
import { MAX_VALUE_CHARS } from "../utils/project.js";
import { requireRegistered } from "./insert.js";
import type { ToolDef } from "./index.js";

/** Rows scanned to build the field profile — enough to be representative, cheap to read. */
const SAMPLE_SIZE = 200;

/** Field names close enough to be the same thing recorded twice under different spellings. */
const DRIFT_THRESHOLD = 0.55;

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function shorten(value: unknown): unknown {
  if (typeof value !== "string") return Array.isArray(value) ? `array(${value.length})` : value;
  return value.length > 60 ? `${value.slice(0, 60)}…` : value;
}

/**
 * Two field names describing the same thing (body_water_l vs total_body_water_L).
 * Similar names alone are noisy — `publisher`/`published_at` are different
 * fields — so a pair only counts when the two never appear in the same record:
 * genuine drift is mutually exclusive, related fields are not.
 */
function driftPairs(
  fields: string[],
  coOccurs: (a: string, b: string) => boolean,
): { a: string; b: string; similarity: number }[] {
  const pairs = [];
  for (let i = 0; i < fields.length; i++) {
    for (let j = i + 1; j < fields.length; j++) {
      if (coOccurs(fields[i], fields[j])) continue;
      const normalize = (name: string) => name.toLowerCase().replace(/[_\s]/g, "");
      const a = normalize(fields[i]);
      const b = normalize(fields[j]);
      const similarity =
        a === b
          ? 1
          : categorySimilarity(
              { collection_name: a, description: "", keywords: [] },
              { collection_name: b, description: "", category_group: "", keywords: [], sample_fields: [], created_at: "", updated_at: "" },
            );
      if (similarity >= DRIFT_THRESHOLD) {
        pairs.push({ a: fields[i], b: fields[j], similarity: Number(similarity.toFixed(3)) });
      }
    }
  }
  return pairs.sort((x, y) => y.similarity - x.similarity);
}

const describeCollection: ToolDef = {
  name: "describe_collection",
  config: {
    description:
      "Show what a collection actually contains: row count, date range, and every field with how many records carry it plus a sample value. " +
      "Call this before get_stats or a field filter when you are not certain of the exact field name — _meta lists names only, and a wrong name " +
      "silently returns nothing. It also flags near-identical field names that likely mean the same thing recorded two different ways. " +
      "`rules` are the user's working rules for this collection (plus global ones) — follow them before writing to it.",
    inputSchema: {
      collection_name: z.string().describe("Collection to inspect"),
    },
  },
  run: async ({ collection_name }: { collection_name: string }) => {
    const entry = await requireRegistered(collection_name);
    const rules = await readRules(["global", collection_name]);
    const totals = await db.execute(
      `SELECT count(*) AS n, min(date) AS oldest, max(date) AS newest FROM ${collection_name}`,
    );
    const total = Number(totals.rows[0]?.n ?? 0);
    if (total === 0) {
      return { collection_name, description: entry.description, rules, record_count: 0, fields: [], note: "empty collection" };
    }

    const sample = await db.execute({
      sql: `SELECT data FROM ${collection_name} ORDER BY date DESC LIMIT ?`,
      args: [SAMPLE_SIZE],
    });
    const rows = sample.rows.map((row) => JSON.parse(String(row.data)) as Record<string, unknown>);
    const seen = new Map<string, { count: number; types: Set<string>; sample: unknown }>();
    for (const record of rows) {
      for (const [key, value] of Object.entries(record)) {
        const field = seen.get(key) ?? { count: 0, types: new Set<string>(), sample: undefined };
        field.count++;
        field.types.add(typeOf(value));
        if (field.sample === undefined && value !== null) field.sample = shorten(value);
        seen.set(key, field);
      }
    }

    const fields = [...seen.entries()]
      .map(([name, info]) => ({
        name,
        present_in: `${info.count}/${sample.rows.length}`,
        types: [...info.types],
        sample: info.sample ?? null,
      }))
      .sort((a, b) => Number(b.present_in.split("/")[0]) - Number(a.present_in.split("/")[0]));

    const drift = driftPairs(
      fields.map((field) => field.name),
      (a, b) => rows.some((row) => a in row && b in row),
    );
    return {
      collection_name,
      description: entry.description,
      rules,
      record_count: total,
      date_range: { oldest: totals.rows[0]?.oldest ?? null, newest: totals.rows[0]?.newest ?? null },
      sampled_rows: sample.rows.length,
      fields,
      ...(drift.length > 0
        ? {
            possible_field_drift: drift,
            drift_hint: "These field names look like the same thing spelled two ways — aggregates over either will miss the other half.",
          }
        : {}),
      note: `Values longer than ${MAX_VALUE_CHARS} chars are truncated in query_records unless full: true.`,
    };
  },
};

export const describeTools: ToolDef[] = [describeCollection];
