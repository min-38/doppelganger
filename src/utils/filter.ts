import { strictEqual, throws, deepStrictEqual } from "node:assert";
import { z } from "zod";
import { isDateField, normalizeDateTime } from "./date.js";

/** One field's condition: a plain value (equality) or a set of operators. */
export const conditionSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z
    .object({
      eq: z.unknown().optional(),
      ne: z.unknown().optional(),
      gte: z.union([z.string(), z.number()]).optional(),
      lte: z.union([z.string(), z.number()]).optional(),
      gt: z.union([z.string(), z.number()]).optional(),
      lt: z.union([z.string(), z.number()]).optional(),
      contains: z.string().optional(),
      in: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
    })
    .strict(),
]);

/** Field names go into a JSON path, so they are a trust boundary like table names. */
export function jsonPath(field: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(field)) {
    throw new Error(`Invalid field name in filter: "${field}"`);
  }
  // date / created_at / updated_at are real columns; everything else is JSON.
  if (field === "date" || field === "created_at" || field === "updated_at") return field;
  return `json_extract(data, '$.${field}')`;
}

/**
 * Date bounds are normalized so that string comparison works, and a bare
 * `YYYY-MM-DD` upper bound covers the whole day instead of just midnight.
 */
function bound(field: string, value: unknown, op: "gte" | "lte" | "gt" | "lt"): unknown {
  if (!isDateField(field) || typeof value !== "string") return value;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
  if (dateOnly && (op === "lte" || op === "gt")) return `${value.trim()} 23:59:59`;
  return normalizeDateTime(value);
}

/** Turns the filter object into a WHERE clause plus bound parameters. */
export function buildWhere(filter: Record<string, unknown>): { sql: string; args: unknown[] } {
  const clauses: string[] = [];
  const args: unknown[] = [];

  for (const [field, condition] of Object.entries(filter)) {
    const path = jsonPath(field);
    if (condition === null || typeof condition !== "object" || Array.isArray(condition)) {
      clauses.push(`${path} = ?`);
      args.push(condition);
      continue;
    }
    for (const [op, raw] of Object.entries(condition as Record<string, unknown>)) {
      if (raw === undefined) continue;
      switch (op) {
        case "eq":
          clauses.push(`${path} = ?`);
          args.push(raw);
          break;
        case "ne":
          clauses.push(`${path} != ?`);
          args.push(raw);
          break;
        case "gte":
        case "lte":
        case "gt":
        case "lt": {
          const sign = { gte: ">=", lte: "<=", gt: ">", lt: "<" }[op];
          clauses.push(`${path} ${sign} ?`);
          args.push(bound(field, raw, op));
          break;
        }
        case "contains":
          clauses.push(`${path} LIKE ?`);
          args.push(`%${raw}%`);
          break;
        case "in": {
          const values = raw as unknown[];
          if (values.length === 0) {
            clauses.push("0 = 1");
            break;
          }
          clauses.push(`${path} IN (${values.map(() => "?").join(", ")})`);
          args.push(...values);
          break;
        }
        default:
          throw new Error(`Unsupported operator "${op}" on field "${field}"`);
      }
    }
  }

  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", args };
}

if (import.meta.main) {
  const eq: typeof strictEqual = strictEqual;
  const deepEq: typeof deepStrictEqual = deepStrictEqual;
  eq(buildWhere({}).sql, "");
  deepEq(buildWhere({ food: "라면" }), { sql: "WHERE json_extract(data, '$.food') = ?", args: ["라면"] });
  eq(buildWhere({ date: { gte: "2026-08-01" } }).sql, "WHERE date >= ?"); // real column, not a JSON path
  deepEq(buildWhere({ calories: { gte: 700 } }).args, [700]);
  deepEq(buildWhere({ food: { contains: "김치" } }).args, ["%김치%"]);
  deepEq(buildWhere({ food: { in: ["라면", "치킨"] } }), {
    sql: "WHERE json_extract(data, '$.food') IN (?, ?)",
    args: ["라면", "치킨"],
  });
  eq(buildWhere({ food: { in: [] } }).sql, "WHERE 0 = 1");
  // a bare date lower bound starts at midnight, an upper bound covers the day
  deepEq(buildWhere({ date: { gte: "2026-08-01", lte: "2026-08-05" } }).args, [
    "2026-08-01 00:00:00",
    "2026-08-05 23:59:59",
  ]);
  deepEq(buildWhere({ date: { gt: "2026-08-05" } }).args, ["2026-08-05 23:59:59"]);
  deepEq(buildWhere({ note: { gte: "2026-08-01" } }).args, ["2026-08-01"]); // not a date field
  eq(buildWhere({ a: 1, b: 2 }).sql.includes(" AND "), true);
  throws(() => buildWhere({ "food'; DROP TABLE _meta --": 1 }));
  throws(() => buildWhere({ food: { regex: "x" } as never }));
  console.log("filter.ts self-check OK");
}
