import { strictEqual, deepStrictEqual } from "node:assert";

/** Strings longer than this are cut in query results unless `full` is set. */
export const MAX_VALUE_CHARS = 500;

/**
 * Arrays longer than this are cut too. Chat logs are the reason: one row holds
 * hundreds of short messages, so no single string is long while the record is
 * enormous.
 */
export const MAX_ARRAY_ITEMS = 20;

/**
 * Shrinks a record for transport: keeps only the requested fields and cuts
 * long strings. Reading the row costs the same either way — this exists so a
 * 38 KB chat log does not land in the answer when only the title was wanted.
 */
export function projectRecord(
  record: Record<string, unknown>,
  fields?: string[],
  full = false,
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  const wanted = fields && fields.length > 0 ? fields : Object.keys(record);
  for (const key of wanted) {
    if (!(key in record)) continue;
    picked[key] = full ? record[key] : truncate(record[key]);
  }
  return picked;
}

/** Cuts long strings, recursing into arrays and objects. */
function truncate(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > MAX_VALUE_CHARS
      ? `${value.slice(0, MAX_VALUE_CHARS)}… (truncated, ${value.length} chars — pass full: true for all of it)`
      : value;
  }
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_ARRAY_ITEMS).map(truncate);
    return value.length > MAX_ARRAY_ITEMS
      ? [...kept, `… (truncated, ${value.length} items total — pass full: true for all of them)`]
      : kept;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, truncate(v)]));
  }
  return value;
}

if (import.meta.main) {
  const eq: typeof strictEqual = strictEqual;
  const deepEq: typeof deepStrictEqual = deepStrictEqual;
  const long = "가".repeat(MAX_VALUE_CHARS + 100);

  deepEq(projectRecord({ a: 1, b: 2 }, ["a"]), { a: 1 });
  deepEq(projectRecord({ a: 1, b: 2 }), { a: 1, b: 2 });
  deepEq(projectRecord({ a: 1 }, []), { a: 1 }); // empty list means "everything"
  deepEq(projectRecord({ a: 1 }, ["missing"]), {}); // absent fields are skipped, not null
  eq(String(projectRecord({ t: long }).t).includes("truncated"), true);
  eq(String(projectRecord({ t: long }).t).length < long.length, true);
  eq(projectRecord({ t: long }, undefined, true).t, long); // full: true keeps it
  eq(String((projectRecord({ n: { deep: long } }).n as any).deep).includes("truncated"), true);
  eq(String((projectRecord({ list: [long] }).list as string[])[0]).includes("truncated"), true);

  // long arrays are the real shape of chat logs: many short items, no long string
  const many = Array.from({ length: MAX_ARRAY_ITEMS + 30 }, (_, i) => ({ text: `m${i}` }));
  const cut = projectRecord({ messages: many }).messages as unknown[];
  eq(cut.length, MAX_ARRAY_ITEMS + 1);
  eq(String(cut.at(-1)).includes(`${many.length} items total`), true);
  eq((projectRecord({ messages: many }, undefined, true).messages as unknown[]).length, many.length);
  deepEq(projectRecord({ few: [1, 2, 3] }).few, [1, 2, 3]);
  deepEq(projectRecord({ n: 5, b: true, z: null }), { n: 5, b: true, z: null });
  console.log("project.ts self-check OK");
}
