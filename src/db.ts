import { config as loadEnv } from "dotenv";
import { createClient, type Client } from "@libsql/client";

// An MCP client can hand us an empty or unexpanded variable ("${TURSO_...}"),
// and dotenv leaves anything already present in the environment alone. Drop
// those first so .env still wins.
for (const key of ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"]) {
  const value = process.env[key];
  if (!value?.trim() || value.startsWith("${")) delete process.env[key];
}
loadEnv();

const url = process.env.TURSO_DATABASE_URL?.trim() || undefined;
if (!url) {
  console.error("TURSO_DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

export const META_TABLE = "_meta";

// libSQL client is lazy and manages its own connections — one per process.
export const db: Client = createClient({
  url,
  authToken: process.env.TURSO_AUTH_TOKEN?.trim() || undefined,
});

/**
 * Table names come from tool arguments and get interpolated into DDL/DML, so
 * they are a trust boundary: only [a-z0-9_] and never the reserved _meta name.
 */
export function assertTableName(name: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(
      `Invalid collection name "${name}". Use lowercase letters, digits and underscores, starting with a letter.`,
    );
  }
  if (name === META_TABLE) throw new Error(`"${META_TABLE}" is reserved.`);
  return name;
}

let initialized: Promise<void> | null = null;

/** Creates the _meta registry if missing. Safe to call on every tool run. */
export function initSchema(): Promise<void> {
  initialized ??= db
    .execute(
      `CREATE TABLE IF NOT EXISTS ${META_TABLE} (
         collection_name TEXT PRIMARY KEY,
         description     TEXT NOT NULL,
         category_group  TEXT NOT NULL,
         keywords        TEXT NOT NULL DEFAULT '[]',
         sample_fields   TEXT NOT NULL DEFAULT '[]',
         created_at      TEXT NOT NULL,
         updated_at      TEXT NOT NULL
       )`,
    )
    .then(() => undefined);
  return initialized;
}

/**
 * Every data table has the same shape. `date` is when the event happened and
 * is a real indexed column; `created_at`/`updated_at` are system timestamps
 * (recording yesterday's meal today must not collapse the two). Everything
 * else lives in the `data` JSON blob.
 */
export async function createDataTable(name: string): Promise<void> {
  assertTableName(name);
  await initSchema();
  await db.execute(
    `CREATE TABLE IF NOT EXISTS ${name} (
       id         INTEGER PRIMARY KEY AUTOINCREMENT,
       date       TEXT NOT NULL,
       data       TEXT NOT NULL,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`,
  );
  await ensureDateIndex(name);
}

/** Index on the date column — every period query and the default sort use it. */
export async function ensureDateIndex(table: string): Promise<void> {
  assertTableName(table);
  await db.execute(`CREATE INDEX IF NOT EXISTS ${table}_date_idx ON ${table} (date)`);
}

/**
 * Expression index on one JSON field. Only date-ish fields get one: those are
 * what range queries and the default sort hit, and every extra index costs
 * write time and space on a free-tier database.
 */
export async function ensureFieldIndex(table: string, field: string): Promise<void> {
  assertTableName(table);
  if (!/^[a-z][a-z0-9_]{0,62}$/i.test(field)) throw new Error(`Invalid field name: "${field}"`);
  await db.execute(
    `CREATE INDEX IF NOT EXISTS ${table}_${field.toLowerCase()}_idx ON ${table} (json_extract(data, '$.${field}'))`,
  );
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    db.close();
    process.exit(0);
  });
}
process.once("beforeExit", () => db.close());
