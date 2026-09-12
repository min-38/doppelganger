import { deepStrictEqual, strictEqual } from "node:assert";
import type { Enforce } from "../rules.js";

/**
 * Protected fields (ai_rules.enforce). The point is not to forbid edits but to
 * stop an AI from overwriting what the user wrote without noticing — e.g.
 * round-tripping a whole `exercises` array and clobbering the pre-workout plan.
 * A real correction goes through with confirm + reason after the user agrees.
 */

export type Violation = { field: string; mode: Enforce["mode"]; before: unknown; after: unknown };

/** Sorted-key JSON, so an object round-tripped with its keys reordered still compares equal. */
function canonical(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, inner) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  );
}

const isEmpty = (value: unknown) => value === undefined || value === null || value === "";

/** Values a field path points at, keyed by a readable label. `a` is top-level, `a[].b` is `b` in every element of array `a`. */
function pick(record: Record<string, unknown>, field: string): Map<string, unknown> {
  const [head, tail] = field.split("[].");
  const out = new Map<string, unknown>();
  if (tail === undefined) return out.set(field, record[field]);
  const list = Array.isArray(record[head]) ? (record[head] as unknown[]) : [];
  list.forEach((item, index) => {
    out.set(`${head}[${index}].${tail}`, item && typeof item === "object" ? (item as Record<string, unknown>)[tail] : undefined);
  });
  return out;
}

/** Protected values that differ between the stored record and the one about to be written. */
export function findViolations(before: Record<string, unknown>, after: Record<string, unknown>, enforce: Enforce[]): Violation[] {
  const out: Violation[] = [];
  for (const { field, mode } of enforce) {
    const was = pick(before, field);
    const will = pick(after, field);
    for (const label of new Set([...was.keys(), ...will.keys()])) {
      const a = was.get(label);
      const b = will.get(label);
      if (canonical(a) === canonical(b)) continue;
      if (mode === "write_once" && isEmpty(a)) continue; // filling an empty slot is what write_once allows
      out.push({ field: label, mode, before: a, after: b });
    }
  }
  return out;
}

const brief = (value: unknown) => {
  const text = JSON.stringify(value) ?? "(absent)";
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
};

/** The refusal an AI client sees — says what was caught and exactly how to proceed. */
export function refusal(violations: Violation[], retry: string): string {
  const lines = violations.slice(0, 20).map((v) => `- ${v.field} (${v.mode}): ${brief(v.before)} → ${brief(v.after)}`);
  if (violations.length > 20) lines.push(`- …and ${violations.length - 20} more`);
  return [
    "Refused — nothing was written. This change touches values protected by the user's ai_rules:",
    ...lines,
    "If you did not mean to change these (for example you sent back truncated values), re-read the record with query_records full: true and keep them exactly as stored.",
    `If the change is intended, show the user what would change and ask. Only after they agree, ${retry}`,
  ].join("\n");
}

if (import.meta.main) {
  const eq: typeof strictEqual = strictEqual;
  const deepEq: typeof deepStrictEqual = deepStrictEqual;
  const plan: Enforce = { field: "exercises[].coach_note", mode: "write_once" };
  const sets: Enforce = { field: "exercises[].sets", mode: "user_input" };
  const note: Enforce = { field: "note", mode: "user_input" };
  const stored = { note: "왼팔 버거움", exercises: [{ name: "벤치", coach_note: "60kg 3x8", sets: [{ weight_kg: 60, reps: 8 }] }, { name: "딥스", sets: [] }] };

  // adding a review next to the plan is fine; key order does not matter
  const reviewed = { note: "왼팔 버거움", exercises: [{ sets: [{ reps: 8, weight_kg: 60 }], coach_note: "60kg 3x8", name: "벤치", coach_review: "좋음" }, { name: "딥스", sets: [] }] };
  deepEq(findViolations(stored, reviewed, [plan, sets, note]), []);

  // write_once: filling an empty plan is allowed, overwriting one is not
  const filled = { ...stored, exercises: [stored.exercises[0], { name: "딥스", sets: [], coach_note: "보조 30kg" }] };
  deepEq(findViolations(stored, filled, [plan]), []);
  const clobbered = { ...stored, exercises: [{ ...stored.exercises[0], coach_note: "평가문" }, stored.exercises[1]] };
  deepEq(findViolations(stored, clobbered, [plan]).map((v) => v.field), ["exercises[0].coach_note"]);

  // user_input: changing, removing or adding a value all count
  eq(findViolations(stored, { ...stored, note: "고침" }, [note]).length, 1);
  eq(findViolations(stored, { exercises: stored.exercises }, [note]).length, 1);
  eq(findViolations({ exercises: [] }, { exercises: [], note: "새로" }, [note]).length, 1);
  const moreWeight = { ...stored, exercises: [{ ...stored.exercises[0], sets: [{ weight_kg: 65, reps: 8 }] }, stored.exercises[1]] };
  deepEq(findViolations(stored, moreWeight, [sets]).map((v) => v.field), ["exercises[0].sets"]);

  // dropping an exercise removes its protected values
  eq(findViolations(stored, { ...stored, exercises: [stored.exercises[0]] }, [sets]).length, 1);
  // unprotected fields are free
  deepEq(findViolations(stored, { ...stored, coach_score: 4 }, [plan, sets, note]), []);

  eq(refusal(findViolations(stored, { ...stored, note: "x" }, [note]), "retry.").includes("note (user_input)"), true);
  console.log("guard.ts self-check OK");
}
