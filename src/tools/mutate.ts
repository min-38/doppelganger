import { z } from "zod";
import { db, HISTORY_TABLE } from "../db.js";
import { recordHistory } from "../history.js";
import { normalizeDateTime, normalizeRecordDates, now } from "../utils/date.js";
import { requireRegistered } from "./insert.js";
import type { ToolDef } from "./index.js";

async function readRecord(collectionName: string, id: number) {
  const result = await db.execute({
    sql: `SELECT id, date, data, created_at, updated_at FROM ${collectionName} WHERE id = ?`,
    args: [id],
  });
  const row = result.rows[0];
  if (!row) throw new Error(`No record with id ${id} in "${collectionName}". Find it with query_records first.`);
  return {
    date: String(row.date),
    data: JSON.parse(String(row.data)) as Record<string, unknown>,
    created_at: String(row.created_at),
  };
}

const updateRecord: ToolDef = {
  name: "update_record",
  config: {
    description:
      "Patch one existing record. Call query_records first to get the id — never guess it. " +
      "Only the fields you pass are changed; the rest stay as they are. Pass null to remove a field. " +
      "Pass `date` to correct when the event happened (it is a column, not part of data). " +
      "Date-ish fields are re-normalized to 'YYYY-MM-DD HH:MM:SS' (KST) and updated_at is refreshed.",
    inputSchema: {
      collection_name: z.string().describe("Collection holding the record"),
      id: z.number().int().positive().describe("Record id from query_records"),
      date: z.string().optional().describe("Corrected event date, e.g. '2026-08-04 23:00:00'"),
      data: z.record(z.string(), z.unknown()).describe("Fields to change, e.g. { hours: 7 } or { note: null } to drop a field"),
    },
  },
  run: async ({
    collection_name,
    id,
    date,
    data,
  }: {
    collection_name: string;
    id: number;
    date?: string;
    data: Record<string, unknown>;
  }) => {
    await requireRegistered(collection_name);
    const { date: dateInData, ...rest } = data;
    const newDate = date ?? dateInData;
    if (Object.keys(rest).length === 0 && newDate === undefined) {
      throw new Error("nothing to update — pass `date`, `data`, or both.");
    }

    const current = await readRecord(collection_name, id);
    const patch = normalizeRecordDates(rest);
    const merged = { ...current.data, ...patch };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete merged[key];
    }

    const eventDate = newDate === undefined ? current.date : normalizeDateTime(newDate);
    await recordHistory(collection_name, id, "update", current);
    const timestamp = now();
    await db.execute({
      sql: `UPDATE ${collection_name} SET date = ?, data = ?, updated_at = ? WHERE id = ?`,
      args: [eventDate, JSON.stringify(merged), timestamp, id],
    });

    return { updated: true, collection_name, id, date: eventDate, record: merged, updated_at: timestamp };
  },
};

const deleteRecord: ToolDef = {
  name: "delete_record",
  config: {
    description:
      "Delete one record. Call query_records first and confirm the id belongs to the record the user means — delete only that one. " +
      "The deleted values are returned and also kept in the history, so restore_record can bring the record back.",
    inputSchema: {
      collection_name: z.string().describe("Collection holding the record"),
      id: z.number().int().positive().describe("Record id from query_records"),
    },
  },
  run: async ({ collection_name, id }: { collection_name: string; id: number }) => {
    await requireRegistered(collection_name);
    const current = await readRecord(collection_name, id);
    await recordHistory(collection_name, id, "delete", current);
    await db.execute({ sql: `DELETE FROM ${collection_name} WHERE id = ?`, args: [id] });
    return { deleted: true, collection_name, id, date: current.date, record: current.data };
  },
};

const restoreRecord: ToolDef = {
  name: "restore_record",
  config: {
    description:
      "Undo the last update or delete on a record. Give it the collection and the record id shown by update_record / delete_record; " +
      "a deleted record comes back with its original id, an updated one goes back to its previous values.",
    inputSchema: {
      collection_name: z.string().describe("Collection the record belongs to"),
      id: z.number().int().positive().describe("Record id as it was before the change"),
    },
  },
  run: async ({ collection_name, id }: { collection_name: string; id: number }) => {
    await requireRegistered(collection_name);
    const history = await db.execute({
      sql: `SELECT id, operation, before_date, before_data, changed_at FROM ${HISTORY_TABLE}
             WHERE collection_name = ? AND record_id = ? ORDER BY id DESC LIMIT 1`,
      args: [collection_name, id],
    });
    const entry = history.rows[0];
    if (!entry) throw new Error(`No history for record ${id} in "${collection_name}".`);

    const before = {
      date: String(entry.before_date),
      data: JSON.parse(String(entry.before_data)) as Record<string, unknown>,
    };
    const timestamp = now();
    const exists = await db.execute({ sql: `SELECT id FROM ${collection_name} WHERE id = ?`, args: [id] });
    if (exists.rows.length > 0) {
      await db.execute({
        sql: `UPDATE ${collection_name} SET date = ?, data = ?, updated_at = ? WHERE id = ?`,
        args: [before.date, JSON.stringify(before.data), timestamp, id],
      });
    } else {
      // Reinsert with the original id so earlier references still resolve.
      await db.execute({
        sql: `INSERT INTO ${collection_name} (id, date, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        args: [id, before.date, JSON.stringify(before.data), timestamp, timestamp],
      });
    }
    // The restore itself is not pushed onto the history: re-running it would
    // only toggle between the same two states.
    await db.execute({ sql: `DELETE FROM ${HISTORY_TABLE} WHERE id = ?`, args: [Number(entry.id)] });

    return {
      restored: true,
      collection_name,
      id,
      undone: String(entry.operation),
      changed_at: String(entry.changed_at),
      date: before.date,
      record: before.data,
    };
  },
};

export const mutateTools: ToolDef[] = [updateRecord, deleteRecord, restoreRecord];
