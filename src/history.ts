import { db, HISTORY_TABLE } from "./db.js";
import { now } from "./utils/date.js";

export type Snapshot = { date: string; data: Record<string, unknown> };

/** Snapshots a record before it is changed, so the previous value survives. */
export async function recordHistory(
  collectionName: string,
  id: number,
  operation: "update" | "delete",
  before: Snapshot,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO ${HISTORY_TABLE}
            (collection_name, record_id, operation, before_date, before_data, changed_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [collectionName, id, operation, before.date, JSON.stringify(before.data), now()],
  });
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
