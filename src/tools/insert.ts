import { z } from "zod";
import { assertTableName, db, META_TABLE } from "../db.js";
import { normalizeRecordDates, now } from "../utils/date.js";
import { readMeta } from "./meta.js";
import type { ToolDef } from "./index.js";

/** Throws unless the collection is registered — unregistered tables are invisible to search. */
export async function requireRegistered(collectionName: string) {
  assertTableName(collectionName);
  const entry = (await readMeta()).find((e) => e.collection_name === collectionName);
  if (!entry) {
    throw new Error(
      `Collection "${collectionName}" is not registered. Call create_category first (or list_collections to find the right one).`,
    );
  }
  return entry;
}

/** Keeps _meta.sample_fields in sync with what is actually being stored. */
async function mergeSampleFields(collectionName: string, known: string[], incoming: string[]) {
  const merged = [...new Set([...known, ...incoming])];
  if (merged.length === known.length) return known;
  await db.execute({
    sql: `UPDATE ${META_TABLE} SET sample_fields = ?, updated_at = ? WHERE collection_name = ?`,
    args: [JSON.stringify(merged), now(), collectionName],
  });
  return merged;
}

const insertRecord: ToolDef = {
  name: "insert_record",
  config: {
    description:
      "Store one record in a registered collection. The collection must already exist — call create_category first if it does not. " +
      "Fields are free-form: put whatever the user reported into `data`. Date-ish fields (date, time, created_at, *_at, *_date, *_time) " +
      "are normalized to 'YYYY-MM-DD HH:MM:SS' in KST; pass concrete values, never '어제' or '오늘' — resolve those to real dates yourself.",
    inputSchema: {
      collection_name: z.string().describe("Target collection, as registered in _meta"),
      data: z.record(z.string(), z.unknown()).describe("The record, e.g. { date: '2026-08-05 19:30:00', food: '김치찌개' }"),
    },
  },
  run: async ({ collection_name, data }: { collection_name: string; data: Record<string, unknown> }) => {
    const entry = await requireRegistered(collection_name);
    if (Object.keys(data).length === 0) throw new Error("`data` is empty — nothing to store.");

    const record = normalizeRecordDates(data);
    const timestamp = now();
    const result = await db.execute({
      sql: `INSERT INTO ${collection_name} (data, created_at, updated_at) VALUES (?, ?, ?)`,
      args: [JSON.stringify(record), timestamp, timestamp],
    });

    const sampleFields = await mergeSampleFields(collection_name, entry.sample_fields, Object.keys(record));
    return {
      inserted: true,
      collection_name,
      id: Number(result.lastInsertRowid),
      record,
      created_at: timestamp,
      sample_fields: sampleFields,
    };
  },
};

export const insertTools: ToolDef[] = [insertRecord];
