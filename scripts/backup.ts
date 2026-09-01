/**
 * Dumps every collection (including _meta) to one JSON file per run.
 *
 *   npm run backup                    -> backup/2026-08-05.json
 *   npm run backup -- /tmp            -> /tmp/2026-08-05.json
 *   npm run backup -- --no-history    -> current state only
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { db, HISTORY_TABLE, META_TABLE } from "../src/db.js";
import { readMeta } from "../src/tools/meta.js";
import { now, today } from "../src/utils/date.js";

const args = process.argv.slice(2);
const withHistory = !args.includes("--no-history");
const outDir = args.find((arg) => !arg.startsWith("--")) ?? "backup";

const collections = await readMeta();
const data: Record<string, unknown[]> = { [META_TABLE]: collections };

for (const entry of collections) {
  const rows = await db.execute(
    `SELECT id, date, data, created_at, updated_at FROM ${entry.collection_name} ORDER BY id`,
  );
  data[entry.collection_name] = rows.rows.map((row) => ({
    id: Number(row.id),
    date: String(row.date),
    ...JSON.parse(String(row.data)),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }));
}

// History is part of the snapshot by default: without it a restore would be
// impossible from a backup alone. --no-history skips it when only the current
// state matters and the dump would otherwise be dominated by old revisions.
if (withHistory) {
  const history = await db.execute(`SELECT * FROM ${HISTORY_TABLE} ORDER BY id`);
  data[HISTORY_TABLE] = history.rows.map((row) => ({ ...row }));
} else {
  data[HISTORY_TABLE] = [];
}

await mkdir(outDir, { recursive: true });
const file = join(outDir, `${today()}.json`);
await writeFile(file, JSON.stringify({ exported_at: now(), collections: data }, null, 2));

const total =
  Object.values(data).reduce((sum, rows) => sum + rows.length, 0) -
  collections.length -
  data[HISTORY_TABLE].length;
console.log(
  `Backed up ${collections.length} collections / ${total} records / ${data[HISTORY_TABLE].length} history rows -> ${file}`,
);
await db.close();
