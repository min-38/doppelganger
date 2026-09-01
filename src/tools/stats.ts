import { z } from "zod";
import { db } from "../db.js";
import { buildWhere, conditionSchema, jsonPath } from "../utils/filter.js";
import { requireRegistered } from "./insert.js";
import type { ToolDef } from "./index.js";

const AGGREGATIONS = ["avg", "sum", "min", "max", "count"] as const;
type Aggregation = (typeof AGGREGATIONS)[number];

const BUCKETS = {
  day: 10, // YYYY-MM-DD
  month: 7, // YYYY-MM
  year: 4, // YYYY
} as const;

const getStats: ToolDef = {
  name: "get_stats",
  config: {
    description:
      "Aggregate one numeric field server-side instead of reading every row and adding it up yourself — use this for '평균 체중', '총 운동 시간', '이번 달 합계' style questions. " +
      "Restrict the period with from/to (matched against the event date) and narrow further with filter, which takes the same conditions as query_records " +
      "(e.g. { type: 'expense', categoryName: '식비' }). group_by buckets the result by day / month / year, or by a record field for a per-category breakdown. " +
      "Non-numeric values are skipped and reported as skipped_count; count counts rows where the field is present.",
    inputSchema: {
      collection_name: z.string().describe("A collection returned by find_relevant_collections"),
      field: z.string().describe("Record field to aggregate, e.g. 'weight_kg'"),
      agg_type: z.enum(AGGREGATIONS).describe("avg | sum | min | max | count"),
      from: z.string().optional().describe("Start of the period, e.g. '2026-08-01' (inclusive)"),
      to: z.string().optional().describe("End of the period, e.g. '2026-08-31' (inclusive, covers the whole day)"),
      filter: z
        .record(z.string(), conditionSchema)
        .optional()
        .describe("Extra conditions, same shape as query_records, e.g. { type: 'expense' }"),
      group_by: z
        .string()
        .optional()
        .describe("'day' | 'month' | 'year' for a trend, or a record field name for a breakdown (e.g. 'categoryName')"),
    },
  },
  run: async ({
    collection_name,
    field,
    agg_type,
    from,
    to,
    filter,
    group_by,
  }: {
    collection_name: string;
    field: string;
    agg_type: Aggregation;
    from?: string;
    to?: string;
    filter?: Record<string, unknown>;
    group_by?: string;
  }) => {
    await requireRegistered(collection_name);
    const value = jsonPath(field);

    const range: Record<string, unknown> = {};
    if (from !== undefined) range.gte = from;
    if (to !== undefined) range.lte = to;
    const where = buildWhere({
      ...(filter ?? {}),
      ...(Object.keys(range).length > 0 ? { date: range } : {}),
    });

    // Only rows where the field is numeric take part in a numeric aggregate;
    // everything else would silently distort the result.
    const numericOnly = agg_type !== "count";
    const conditions = [where.sql.replace(/^WHERE /, "")].filter(Boolean);
    conditions.push(numericOnly ? `typeof(${value}) IN ('integer','real')` : `${value} IS NOT NULL`);
    const whereSql = `WHERE ${conditions.join(" AND ")}`;

    // day/month/year cut the date column; anything else groups by a record field.
    const bucket = group_by
      ? group_by in BUCKETS
        ? `substr(date, 1, ${BUCKETS[group_by as keyof typeof BUCKETS]})`
        : jsonPath(group_by)
      : null;
    const aggSql = agg_type === "count" ? `count(${value})` : `${agg_type}(CAST(${value} AS REAL))`;

    const result = await db.execute({
      sql: `SELECT ${bucket ? `${bucket} AS bucket, ` : ""}${aggSql} AS value, count(*) AS row_count
              FROM ${collection_name}
              ${whereSql}
              ${bucket ? `GROUP BY bucket ORDER BY bucket ASC` : ""}`,
      args: where.args as never,
    });

    // How many rows fell in the period but carried no usable value.
    const total = await db.execute({
      sql: `SELECT count(*) AS n FROM ${collection_name} ${where.sql}`,
      args: where.args as never,
    });
    const considered = result.rows.reduce((sum, row) => sum + Number(row.row_count), 0);

    const shared = {
      collection_name,
      field,
      agg_type,
      period: { from: from ?? null, to: to ?? null },
      matched_rows: Number(total.rows[0]?.n ?? 0),
      used_rows: considered,
      skipped_count: Number(total.rows[0]?.n ?? 0) - considered,
    };

    if (bucket) {
      return {
        ...shared,
        group_by,
        buckets: result.rows.map((row) => ({
          bucket: row.bucket === null ? null : String(row.bucket),
          value: row.value === null ? null : Number(row.value),
          row_count: Number(row.row_count),
        })),
      };
    }
    const only = result.rows[0];
    return { ...shared, value: only?.value == null ? null : Number(only.value) };
  },
};

export const statsTools: ToolDef[] = [getStats];
