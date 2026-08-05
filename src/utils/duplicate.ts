import { strictEqual } from "node:assert";

export type StoredRecord = { id: number; date: string; data: Record<string, unknown> };

/**
 * How much two records overlap: fields present in both with an equal value,
 * over the union of their fields. 1 means identical, 0 means nothing in common.
 * ponytail: exact value equality — near-equal numbers (69.2 vs 69.3) do not
 * count as a match. Loosen only if real duplicates start slipping through.
 */
export function recordSimilarity(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  if (keys.size === 0) return 1;
  let equal = 0;
  for (const key of keys) {
    if (key in a && key in b && JSON.stringify(a[key]) === JSON.stringify(b[key])) equal++;
  }
  return equal / keys.size;
}

export const DUPLICATE_THRESHOLD = 0.8;

/**
 * Duplicate candidates are looked for among records that share the event date;
 * a different date means a different event, however similar the fields look.
 */
export function findDuplicates(
  candidate: { date: string; data: Record<string, unknown> },
  existing: StoredRecord[],
  threshold = DUPLICATE_THRESHOLD,
) {
  return existing
    .filter((row) => row.date === candidate.date)
    .map((row) => ({
      id: row.id,
      date: row.date,
      similarity: Number(recordSimilarity(candidate.data, row.data).toFixed(3)),
      record: row.data,
    }))
    .filter((hit) => hit.similarity >= threshold)
    .sort((x, y) => y.similarity - x.similarity);
}

if (import.meta.main) {
  const eq: typeof strictEqual = strictEqual;
  eq(recordSimilarity({ a: 1, b: 2 }, { a: 1, b: 2 }), 1);
  eq(recordSimilarity({ a: 1 }, { b: 1 }), 0);
  eq(recordSimilarity({ a: 1, b: 2 }, { a: 1, b: 3 }), 0.5);
  eq(recordSimilarity({}, {}), 1);
  eq(recordSimilarity({ a: [1, 2] }, { a: [1, 2] }), 1); // deep values compare by shape

  const existing: StoredRecord[] = [
    { id: 1, date: "2026-08-05 19:30:00", data: { food: "김치찌개", calories: 600 } },
    { id: 2, date: "2026-08-04 19:30:00", data: { food: "김치찌개", calories: 600 } },
  ];
  const hits = findDuplicates({ date: "2026-08-05 19:30:00", data: { food: "김치찌개", calories: 600 } }, existing);
  eq(hits.length, 1);
  eq(hits[0].id, 1); // same date only — id 2 is a different day
  eq(findDuplicates({ date: "2026-08-05 19:30:00", data: { food: "라면" } }, existing).length, 0);
  eq(
    findDuplicates({ date: "2026-08-05 19:30:00", data: { food: "김치찌개", calories: 700 } }, existing).length,
    0, // 0.5 similarity, below the threshold
  );
  console.log("duplicate.ts self-check OK");
}
