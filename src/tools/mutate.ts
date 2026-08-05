import { z } from "zod";
import { db } from "../db.js";
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
      "Delete one record permanently. This cannot be undone, so call query_records first, confirm the id belongs to the record the user means, " +
      "and delete only that one. The deleted record is returned so it can be re-inserted if this was a mistake.",
    inputSchema: {
      collection_name: z.string().describe("Collection holding the record"),
      id: z.number().int().positive().describe("Record id from query_records"),
    },
  },
  run: async ({ collection_name, id }: { collection_name: string; id: number }) => {
    await requireRegistered(collection_name);
    const current = await readRecord(collection_name, id);
    await db.execute({ sql: `DELETE FROM ${collection_name} WHERE id = ?`, args: [id] });
    return { deleted: true, collection_name, id, date: current.date, record: current.data };
  },
};

export const mutateTools: ToolDef[] = [updateRecord, deleteRecord];
