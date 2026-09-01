/**
 * One-off cleanup: keeps only the newest HISTORY_PER_RECORD revisions per record.
 *
 *   npm run trim:history                          (dry run — prints what would go)
 *   npm run trim:history -- --apply
 *   npm run trim:history -- --older-than=30 --apply   (also drop revisions older than N days)
 *
 * Run `npm run backup` first.
 */
import { db, HISTORY_TABLE } from "../src/db.js";
import { HISTORY_PER_RECORD, trimStatement } from "../src/history.js";

const apply = process.argv.includes("--apply");
const olderThanArg = process.argv.find((arg) => arg.startsWith("--older-than="));
const olderThanDays = olderThanArg ? Number(olderThanArg.split("=")[1]) : null;
if (olderThanDays !== null && !Number.isFinite(olderThanDays)) {
  throw new Error("--older-than expects a number of days, e.g. --older-than=30");
}
// changed_at is stored as 'YYYY-MM-DD HH:MM:SS', which SQLite compares directly.
const cutoff = olderThanDays === null ? null : new Date(Date.now() - olderThanDays * 86_400_000)
  .toISOString().slice(0, 19).replace("T", " ");

const before = await db.execute(
  `SELECT count(*) AS rows, coalesce(sum(length(before_data)), 0) AS bytes FROM ${HISTORY_TABLE}`,
);
const records = await db.execute(
  `SELECT collection_name, record_id, count(*) AS n FROM ${HISTORY_TABLE}
    GROUP BY collection_name, record_id HAVING n > ${HISTORY_PER_RECORD} ORDER BY n DESC`,
);
const excess = records.rows.reduce((sum, row) => sum + (Number(row.n) - HISTORY_PER_RECORD), 0);

console.log(
  `history: ${before.rows[0].rows} rows / ${Number(before.rows[0].bytes).toLocaleString()} bytes`,
);
console.log(`records over the limit: ${records.rows.length}, rows to drop: ${excess}`);
for (const row of records.rows.slice(0, 5)) {
  console.log(`  ${row.collection_name}#${row.record_id}: ${row.n} revisions`);
}

if (cutoff) {
  const aged = await db.execute({
    sql: `SELECT count(*) AS n FROM ${HISTORY_TABLE} WHERE changed_at < ?`,
    args: [cutoff],
  });
  console.log(`revisions older than ${olderThanDays} days (before ${cutoff}): ${aged.rows[0].n}`);
}

if (!apply) {
  console.log(`\nDry run — nothing changed. Re-run with --apply (keeps ${HISTORY_PER_RECORD} per record).`);
} else {
  for (const row of records.rows) {
    await db.execute(trimStatement(String(row.collection_name), Number(row.record_id)));
  }
  if (cutoff) {
    await db.execute({ sql: `DELETE FROM ${HISTORY_TABLE} WHERE changed_at < ?`, args: [cutoff] });
  }
  const after = await db.execute(
    `SELECT count(*) AS rows, coalesce(sum(length(before_data)), 0) AS bytes FROM ${HISTORY_TABLE}`,
  );
  console.log(
    `\nTrimmed -> ${after.rows[0].rows} rows / ${Number(after.rows[0].bytes).toLocaleString()} bytes`,
  );
}
await db.close();
