/**
 * Dumps every collection (including _meta) to one JSON file per run.
 *
 *   npm run backup            -> backup/2026-08-05.json
 *   npm run backup -- /tmp    -> /tmp/2026-08-05.json
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { db, META_TABLE } from "../src/db.js";
import { readMeta } from "../src/tools/meta.js";
import { now, today } from "../src/utils/date.js";

const outDir = process.argv[2] ?? "backup";

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

await mkdir(outDir, { recursive: true });
const file = join(outDir, `${today()}.json`);
await writeFile(file, JSON.stringify({ exported_at: now(), collections: data }, null, 2));

const total = Object.values(data).reduce((sum, rows) => sum + rows.length, 0) - collections.length;
console.log(`Backed up ${collections.length} collections / ${total} records -> ${file}`);
await db.close();
