/**
 * Moves the event date out of the `data` JSON into its own indexed column.
 *
 *   npm run migrate:date -- --dry-run   (default: prints the plan, changes nothing)
 *   npm run migrate:date -- --apply
 *
 * Run `npm run backup` first. Safe to re-run: tables that already have the
 * column are skipped.
 */
import { db, ensureDateIndex } from "../src/db.js";
import { readMeta } from "../src/tools/meta.js";
import { normalizeDateTime } from "../src/utils/date.js";

const apply = process.argv.includes("--apply");

async function hasDateColumn(table: string): Promise<boolean> {
  const info = await db.execute(`PRAGMA table_info(${table})`);
  return info.rows.some((row) => String(row.name) === "date");
}

for (const entry of await readMeta()) {
  const table = entry.collection_name;
  if (await hasDateColumn(table)) {
    console.log(`${table}: already migrated, skipping`);
    continue;
  }

  const rows = (await db.execute(`SELECT id, data, created_at FROM ${table} ORDER BY id`)).rows;
  // Fall back to created_at for rows that never carried an event date.
  const moves = rows.map((row) => {
    const data = JSON.parse(String(row.data)) as Record<string, unknown>;
    const raw = data.date ?? row.created_at;
    const { date: _dropped, ...rest } = data;
    return { id: Number(row.id), date: normalizeDateTime(raw), data: rest, fallback: data.date == null };
  });
  const fallbacks = moves.filter((move) => move.fallback).length;
  console.log(`${table}: ${moves.length} rows, ${fallbacks} without a date (using created_at)`);

  if (!apply) continue;

  // SQLite cannot add a NOT NULL column without a default, so the migrated
  // tables keep `DEFAULT ''` while freshly created ones do not. Functionally
  // identical — every write goes through insert_record, which always sets it.
  await db.execute(`ALTER TABLE ${table} ADD COLUMN date TEXT NOT NULL DEFAULT ''`);
  for (const move of moves) {
    await db.execute({
      sql: `UPDATE ${table} SET date = ?, data = ? WHERE id = ?`,
      args: [move.date, JSON.stringify(move.data), move.id],
    });
  }
  await db.execute(`DROP INDEX IF EXISTS ${table}_date_idx`);
  await ensureDateIndex(table);
  console.log(`${table}: migrated`);
}

if (!apply) console.log("\nDry run — nothing changed. Re-run with --apply to migrate.");
await db.close();
