import { z } from "zod";
import { assertTableName, db, ensureFieldIndex, META_TABLE } from "../db.js";
import { normalizeDateTime, normalizeRecordDates, now } from "../utils/date.js";
import { historyStatements, trimStatement } from "../history.js";
import { DUPLICATE_THRESHOLD, findDuplicates, type StoredRecord } from "../utils/duplicate.js";
import { readRules } from "../rules.js";
import { findViolations, refusal } from "../utils/guard.js";
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


/** Field names reach SQL through a JSON path, so they are validated like table names. */
function uniquePath(field: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(field)) throw new Error(`Invalid unique_by field: "${field}"`);
  return `json_extract(data, '$.${field}')`;
}

/** Joins the unique_by values into one comparable key. \u0000 cannot appear in JSON text. */
function uniqueKeyOf(record: Record<string, unknown>, uniqueBy: string[], index?: number): string {
  return uniqueBy
    .map((field) => {
      const value = record[field];
      if (value === undefined || value === null) {
        const where = index === undefined ? "record" : `record[${index}]`;
        throw new Error(`${where} has no value for unique_by field "${field}".`);
      }
      return String(value);
    })
    .join("\u0000");
}

type Existing = { id: number; date: string; data: Record<string, unknown>; key: string };

/** Loads the rows whose unique_by key matches any of the incoming records. */
async function existingByKey(
  collectionName: string,
  uniqueBy: string[],
  keys: string[],
): Promise<Map<string, Existing>> {
  const unique = [...new Set(keys)];
  const keyExpr = uniqueBy.map(uniquePath).join(` || char(0) || `);
  const found = new Map<string, Existing>();
  if (unique.length === 0) return found;
  const result = await db.execute({
    sql: `SELECT id, date, data FROM ${collectionName} WHERE ${keyExpr} IN (${unique.map(() => "?").join(", ")})`,
    args: unique,
  });
  for (const row of result.rows) {
    const data = JSON.parse(String(row.data)) as Record<string, unknown>;
    const key = uniqueKeyOf(data, uniqueBy);
    found.set(key, { id: Number(row.id), date: String(row.date), data, key });
  }
  return found;
}

/** An upsert only writes when something actually differs — a no-op leaves no history. */
function isUnchanged(existing: Existing, incoming: { date: string; data: Record<string, unknown> }): boolean {
  return existing.date === incoming.date && JSON.stringify(existing.data) === JSON.stringify(incoming.data);
}

type Prepared = { date: string; data: Record<string, unknown> };

/**
 * Insert-or-update keyed on `unique_by`. Records whose stored values already
 * match are left completely alone: no write, no history row. That is what keeps
 * re-imports from filling _history with thousands of identical revisions.
 */
async function upsertMany(collectionName: string, records: Prepared[], uniqueBy: string[]) {
  const keys = records.map((record, index) => uniqueKeyOf(record.data, uniqueBy, index));
  const existing = await existingByKey(collectionName, uniqueBy, keys);

  // An upsert replaces the whole record, so it must not become a way around protected fields.
  const enforce = (await readRules([collectionName])).flatMap((rule) => rule.enforce ?? []);
  if (enforce.length > 0) {
    const violations = records.flatMap((record, index) => {
      const previous = existing.get(keys[index]);
      return previous ? findViolations(previous.data, record.data, enforce).map((v) => ({ ...v, field: `record[${index}] ${v.field}` })) : [];
    });
    if (violations.length > 0) {
      throw new Error(refusal(violations, "change those records one at a time with update_record, confirm: true and a reason."));
    }
  }

  const timestamp = now();
  const statements = [];
  const histories = [];
  const outcomes: { operation: "inserted" | "updated" | "unchanged"; id: number | null }[] = [];

  // Two records in one batch sharing a key would otherwise both be inserted.
  // The last one wins, exactly as it would if they arrived in separate calls.
  const lastIndexForKey = new Map<string, number>();
  keys.forEach((key, index) => lastIndexForKey.set(key, index));

  for (const [index, record] of records.entries()) {
    const key = keys[index];
    if (lastIndexForKey.get(key) !== index) {
      outcomes.push({ operation: "unchanged", id: null });
      continue;
    }
    const previous = existing.get(key);
    if (!previous) {
      statements.push({
        sql: `INSERT INTO ${collectionName} (date, data, created_at, updated_at) VALUES (?, ?, ?, ?)`,
        args: [record.date, JSON.stringify(record.data), timestamp, timestamp],
      });
      outcomes.push({ operation: "inserted", id: null });
      continue;
    }
    if (isUnchanged(previous, record)) {
      outcomes.push({ operation: "unchanged", id: previous.id });
      continue;
    }
    histories.push({ id: previous.id, before: { date: previous.date, data: previous.data } });
    statements.push({
      sql: `UPDATE ${collectionName} SET date = ?, data = ?, updated_at = ? WHERE id = ?`,
      args: [record.date, JSON.stringify(record.data), timestamp, previous.id],
    });
    outcomes.push({ operation: "updated", id: previous.id });
  }

  if (histories.length > 0) {
    await db.batch(
      [
        ...historyStatements(collectionName, histories),
        ...histories.map((entry) => trimStatement(collectionName, entry.id)),
      ],
      "write",
    );
  }
  if (statements.length > 0) {
    const written = await db.batch(statements, "write");
    // Fill in the ids the inserts just produced, in statement order.
    let cursor = 0;
    for (const outcome of outcomes) {
      if (outcome.operation === "unchanged") continue;
      const one = written[cursor++];
      if (outcome.operation === "inserted") outcome.id = Number(one.lastInsertRowid);
    }
  }
  // An index on the lookup field keeps re-imports from scanning the table.
  for (const field of uniqueBy) await ensureFieldIndex(collectionName, field);

  return {
    outcomes,
    inserted: outcomes.filter((o) => o.operation === "inserted").length,
    updated: outcomes.filter((o) => o.operation === "updated").length,
    unchanged: outcomes.filter((o) => o.operation === "unchanged").length,
  };
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
      "For re-importing data that carries its own identifier, pass unique_by (e.g. ['id']): a matching record is updated instead of duplicated, " +
      "and an identical one is left untouched. To store many records at once, use insert_records_bulk instead.",
    inputSchema: {
      collection_name: z.string().describe("Target collection, as registered in _meta"),
      date: z.string().describe("When the event happened, e.g. '2026-08-05 19:30:00' or '2026-08-05'"),
      data: z.record(z.string(), z.unknown()).describe("The rest of the record, e.g. { food: '김치찌개', calories: 600 }"),
      force: z.boolean().optional().describe("Store even though a near-identical record exists on that date"),
      unique_by: z
        .array(z.string())
        .min(1)
        .optional()
        .describe("Fields identifying the record across imports, e.g. ['id'] — matching rows are updated, not duplicated"),
    },
  },
  run: async ({
    collection_name,
    date,
    data,
    force,
    unique_by,
  }: {
    collection_name: string;
    date: string;
    data: Record<string, unknown>;
    force?: boolean;
    unique_by?: string[];
  }) => {
    const entry = await requireRegistered(collection_name);
    const prepared = prepare(date, data);

    if (unique_by) {
      const result = await upsertMany(collection_name, [prepared], unique_by);
      const outcome = result.outcomes[0];
      await mergeSampleFields(collection_name, entry.sample_fields, ["date", ...Object.keys(prepared.data)]);
      return {
        collection_name,
        unique_by,
        ...outcome,
        date: prepared.date,
        record: prepared.data,
      };
    }

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
      unique_by: z
        .array(z.string())
        .min(1)
        .optional()
        .describe("Fields identifying each record across imports, e.g. ['id'] — matching rows are updated, not duplicated"),
    },
  },
  run: async ({
    collection_name,
    records,
    force,
    unique_by,
  }: {
    collection_name: string;
    records: { date: string; data: Record<string, unknown> }[];
    force?: boolean;
    unique_by?: string[];
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

    if (unique_by) {
      const result = await upsertMany(collection_name, prepared, unique_by);
      const sampleFields = await mergeSampleFields(collection_name, entry.sample_fields, [
        "date",
        ...prepared.flatMap((record) => Object.keys(record.data)),
      ]);
      return {
        collection_name,
        unique_by,
        count: prepared.length,
        inserted: result.inserted,
        updated: result.updated,
        unchanged: result.unchanged,
        ids: result.outcomes.map((outcome) => outcome.id),
        sample_fields: sampleFields,
      };
    }

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
