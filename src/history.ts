import { db, HISTORY_TABLE } from "./db.js";
import { now } from "./utils/date.js";

export type Snapshot = { date: string; data: Record<string, unknown> };

/** Snapshots a record before it is changed, so the previous value survives. */
export async function recordHistory(
  collectionName: string,
  id: number,
  operation: "update" | "delete",
  before: Snapshot,
  reason?: string,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO ${HISTORY_TABLE}
            (collection_name, record_id, operation, before_date, before_data, changed_at, reason)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [collectionName, id, operation, before.date, JSON.stringify(before.data), now(), reason ?? null],
  });
  await trimHistory(collectionName, id);
}

/** Batched form of recordHistory — one round trip for a whole bulk upsert. */
export function historyStatements(
  collectionName: string,
  entries: { id: number; before: Snapshot }[],
  operation: "update" | "delete" = "update",
) {
  const changedAt = now();
  return entries.map(({ id, before }) => ({
    sql: `INSERT INTO ${HISTORY_TABLE}
            (collection_name, record_id, operation, before_date, before_data, changed_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [collectionName, id, operation, before.date, JSON.stringify(before.data), changedAt],
  }));
}

/**
 * How many revisions of one record are kept. Older ones are dropped as new
 * ones arrive: restore_record only ever reads the newest, and the full data
 * blob is expensive to keep (history outgrew the data itself 2:1 before this).
 */
export const HISTORY_PER_RECORD = 3;

/** Drops all but the newest HISTORY_PER_RECORD revisions of one record. */
export function trimStatement(collectionName: string, recordId: number) {
  return {
    sql: `DELETE FROM ${HISTORY_TABLE}
           WHERE collection_name = ? AND record_id = ?
             AND id NOT IN (
               SELECT id FROM ${HISTORY_TABLE}
                WHERE collection_name = ? AND record_id = ?
                ORDER BY id DESC LIMIT ?
             )`,
    args: [collectionName, recordId, collectionName, recordId, HISTORY_PER_RECORD],
  };
}

export async function trimHistory(collectionName: string, recordId: number): Promise<void> {
  await db.execute(trimStatement(collectionName, recordId));
}
