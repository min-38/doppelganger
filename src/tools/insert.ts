import { z } from "zod";
import { assertTableName, db, META_TABLE } from "../db.js";
import { normalizeDateTime, normalizeRecordDates, now } from "../utils/date.js";
import { DUPLICATE_THRESHOLD, findDuplicates, type StoredRecord } from "../utils/duplicate.js";
import { readMeta } from "./meta.js";
import type { ToolDef } from "./index.js";

/** Records above this count must be split into several bulk calls. */
const MAX_BULK = 500;

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

/**
 * Shared validation for both insert paths: the event date belongs in its own
 * column, so refuse a second one hidden in `data` rather than dropping either.
 */
function prepare(date: string, data: Record<string, unknown>) {
  if (Object.keys(data).length === 0) throw new Error("`data` is empty — nothing to store.");
  if ("date" in data) throw new Error("Pass the event date as the `date` argument, not inside `data`.");
  return { date: normalizeDateTime(date), data: normalizeRecordDates(data) };
}

/** Existing records on the given dates, for duplicate detection. */
async function recordsOnDates(collectionName: string, dates: string[]): Promise<StoredRecord[]> {
  const unique = [...new Set(dates)];
  if (unique.length === 0) return [];
  const result = await db.execute({
    sql: `SELECT id, date, data FROM ${collectionName} WHERE date IN (${unique.map(() => "?").join(", ")})`,
    args: unique,
  });
  return result.rows.map((row) => ({
    id: Number(row.id),
    date: String(row.date),
    data: JSON.parse(String(row.data)) as Record<string, unknown>,
  }));
}

const DUPLICATE_HINT =
  "Looks like this was already recorded. Check the matches; call again with force: true if it really happened twice.";

const insertRecord: ToolDef = {
  name: "insert_record",
  config: {
    description:
      "Store one record in a registered collection. The collection must already exist — call create_category first if it does not. " +
      "`date` is required and means WHEN THE EVENT HAPPENED, not when it is being recorded — logging yesterday's dinner today means date is yesterday. " +
      "The remaining fields are free-form. Every date-ish value is normalized to 'YYYY-MM-DD HH:MM:SS' in KST; " +
      "pass concrete values, never '어제' or '오늘' — resolve those to real dates yourself. " +
      "If a near-identical record already exists on that date the write is refused; pass force: true once the user confirms it is a real second event. " +
      "To store many records at once, use insert_records_bulk instead.",
    inputSchema: {
      collection_name: z.string().describe("Target collection, as registered in _meta"),
      date: z.string().describe("When the event happened, e.g. '2026-08-05 19:30:00' or '2026-08-05'"),
      data: z.record(z.string(), z.unknown()).describe("The rest of the record, e.g. { food: '김치찌개', calories: 600 }"),
      force: z.boolean().optional().describe("Store even though a near-identical record exists on that date"),
    },
  },
  run: async ({
    collection_name,
    date,
    data,
    force,
  }: {
    collection_name: string;
    date: string;
    data: Record<string, unknown>;
    force?: boolean;
  }) => {
    const entry = await requireRegistered(collection_name);
    const prepared = prepare(date, data);

    if (!force) {
      const duplicates = findDuplicates(prepared, await recordsOnDates(collection_name, [prepared.date]));
      if (duplicates.length > 0) {
        return {
          inserted: false,
          reason: `a near-identical record already exists on that date (similarity >= ${DUPLICATE_THRESHOLD})`,
          duplicates,
          hint: DUPLICATE_HINT,
        };
      }
    }

    const timestamp = now();
    const result = await db.execute({
      sql: `INSERT INTO ${collection_name} (date, data, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      args: [prepared.date, JSON.stringify(prepared.data), timestamp, timestamp],
    });

    const sampleFields = await mergeSampleFields(collection_name, entry.sample_fields, [
      "date",
      ...Object.keys(prepared.data),
    ]);
    return {
      inserted: true,
      collection_name,
      id: Number(result.lastInsertRowid),
      date: prepared.date,
      record: prepared.data,
      created_at: timestamp,
      sample_fields: sampleFields,
    };
  },
};

const insertRecordsBulk: ToolDef = {
  name: "insert_records_bulk",
  config: {
    description:
      "Store many records in one collection at once — use this for importing past data instead of calling insert_record in a loop. " +
      "Every record needs its own `date` (when that event happened). Validation is all-or-nothing: if any record is malformed, " +
      "nothing is written and the offending index is reported. Records that duplicate an existing row (or another row in the same batch) " +
      "are reported and nothing is written; pass force: true once the user confirms.",
    inputSchema: {
      collection_name: z.string().describe("Target collection, as registered in _meta"),
      records: z
        .array(
          z.object({
            date: z.string().describe("When this event happened"),
            data: z.record(z.string(), z.unknown()).describe("The rest of this record"),
          }),
        )
        .min(1)
        .max(MAX_BULK)
        .describe(`Records to store (max ${MAX_BULK} per call — split larger imports)`),
      force: z.boolean().optional().describe("Store even though duplicates were detected"),
    },
  },
  run: async ({
    collection_name,
    records,
    force,
  }: {
    collection_name: string;
    records: { date: string; data: Record<string, unknown> }[];
    force?: boolean;
  }) => {
    const entry = await requireRegistered(collection_name);

    // Validate everything before writing anything, so a bad record at index 40
    // cannot leave 39 rows behind.
    const prepared = records.map((record, index) => {
      try {
        return prepare(record.date, record.data);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`record[${index}]: ${message} — nothing was stored.`);
      }
    });

    if (!force) {
      const existing = await recordsOnDates(collection_name, prepared.map((record) => record.date));
      const accepted: StoredRecord[] = [];
      const conflicts = [];
      for (const [index, record] of prepared.entries()) {
        const againstStored = findDuplicates(record, existing);
        const againstBatch = findDuplicates(record, accepted);
        if (againstStored.length > 0 || againstBatch.length > 0) {
          conflicts.push({
            index,
            date: record.date,
            record: record.data,
            existing_matches: againstStored,
            batch_matches: againstBatch.map((hit) => ({ ...hit, index: hit.id })),
          });
        }
        // Negative ids mark in-batch rows: they have no database id yet.
        accepted.push({ id: -index - 1, date: record.date, data: record.data });
      }
      if (conflicts.length > 0) {
        return {
          inserted: false,
          count: 0,
          reason: `${conflicts.length} of ${prepared.length} records look like duplicates (similarity >= ${DUPLICATE_THRESHOLD})`,
          conflicts,
          hint: DUPLICATE_HINT,
        };
      }
    }

    const timestamp = now();
    const result = await db.batch(
      prepared.map((record) => ({
        sql: `INSERT INTO ${collection_name} (date, data, created_at, updated_at) VALUES (?, ?, ?, ?)`,
        args: [record.date, JSON.stringify(record.data), timestamp, timestamp],
      })),
      "write",
    );

    const sampleFields = await mergeSampleFields(collection_name, entry.sample_fields, [
      "date",
      ...prepared.flatMap((record) => Object.keys(record.data)),
    ]);
    return {
      inserted: true,
      collection_name,
      count: prepared.length,
      ids: result.map((one) => Number(one.lastInsertRowid)),
      dates: prepared.map((record) => record.date),
      created_at: timestamp,
      sample_fields: sampleFields,
    };
  },
};

export const insertTools: ToolDef[] = [insertRecord, insertRecordsBulk];
