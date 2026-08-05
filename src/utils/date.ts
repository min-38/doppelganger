import { strictEqual, throws } from "node:assert";

/**
 * All date/time values are stored as `YYYY-MM-DD HH:MM:SS` wall-clock time in
 * KST (Asia/Seoul). Naive input strings are assumed to already be KST; only
 * values carrying an explicit instant (ISO with Z/offset, Date, epoch ms) are
 * converted.
 */
export const TIME_ZONE = "Asia/Seoul";
export const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

// "sv-SE" formats as YYYY-MM-DD HH:MM:SS, which is exactly the target shape.
const kst = new Intl.DateTimeFormat("sv-SE", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** Format check plus a real-calendar check (rejects 2026-02-30, 25:00:00, ...). */
export function isValidDateTime(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_TIME_RE.test(value)) return false;
  const [date, time] = value.split(" ");
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi, s] = time.split(":").map(Number);
  if (h > 23 || mi > 59 || s > 59) return false;
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

/** Fields whose values get normalized: date, time, created_at, start_date, ... */
export function isDateField(name: string): boolean {
  return /^(date|time|datetime)$/.test(name) || /(_at|_date|_time)$/.test(name);
}

/**
 * Converts supported inputs to `YYYY-MM-DD HH:MM:SS` (KST). Throws on anything
 * it cannot interpret — better a loud failure than a silently wrong timestamp.
 *
 * A date without a time becomes 00:00:00; a time without seconds becomes :00;
 * a time without a date becomes today (KST).
 */
export function normalizeDateTime(input: unknown): string {
  if (input instanceof Date || typeof input === "number") {
    const date = input instanceof Date ? input : new Date(input);
    if (Number.isNaN(date.getTime())) throw new Error(`Invalid date value: ${String(input)}`);
    return kst.format(date);
  }

  if (typeof input !== "string" || input.trim() === "") {
    throw new Error(`Cannot normalize date value: ${JSON.stringify(input)}`);
  }
  const value = input.trim();

  // Naive local (KST) forms — no conversion, just padding and validation.
  const naive = value.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(:\d{2})?)?$/);
  if (naive) {
    const result = `${naive[1]} ${naive[2] ?? "00:00"}${naive[3] ?? ":00"}`;
    if (!isValidDateTime(result)) throw new Error(`Invalid date value: ${value}`);
    return result;
  }

  // Time-only ("19:30", "19:30:00") — the AI usually means today in KST.
  const timeOnly = value.match(/^(\d{1,2}):(\d{2})(:\d{2})?$/);
  if (timeOnly) {
    const hhmm = `${timeOnly[1].padStart(2, "0")}:${timeOnly[2]}`;
    const result = `${today()} ${hhmm}${timeOnly[3] ?? ":00"}`;
    if (!isValidDateTime(result)) throw new Error(`Invalid time value: ${value}`);
    return result;
  }

  // Anything with an explicit instant (Z or ±hh:mm) is converted to KST.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error(`Invalid date value: ${value}`);
    return kst.format(date);
  }

  throw new Error(
    `Cannot normalize date value: ${value}. Use YYYY-MM-DD HH:MM:SS, YYYY-MM-DD, HH:MM:SS, or an ISO 8601 string.`,
  );
}

/** Normalizes every date-ish field of a record in place-free fashion. */
export function normalizeRecordDates(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = isDateField(key) && value != null ? normalizeDateTime(value) : value;
  }
  return out;
}

/** Current time in the storage format. */
export function now(): string {
  return kst.format(new Date());
}

/** Today's date in KST, as YYYY-MM-DD. */
export function today(): string {
  return now().slice(0, 10);
}

if (import.meta.main) {
  const eq: typeof strictEqual = strictEqual;
  eq(normalizeDateTime("2026-08-05 19:30:00"), "2026-08-05 19:30:00");
  eq(normalizeDateTime("2026-08-05"), "2026-08-05 00:00:00");
  eq(normalizeDateTime("2026-08-05 19:30"), "2026-08-05 19:30:00");
  eq(normalizeDateTime("2026-08-05T19:30"), "2026-08-05 19:30:00");
  eq(normalizeDateTime("19:30:00"), `${today()} 19:30:00`);
  eq(normalizeDateTime("19:30"), `${today()} 19:30:00`);
  eq(normalizeDateTime("9:05"), `${today()} 09:05:00`);
  eq(normalizeDateTime("2026-08-05T10:30:00Z"), "2026-08-05 19:30:00"); // UTC -> KST
  eq(normalizeDateTime("2026-08-05T19:30:00+09:00"), "2026-08-05 19:30:00");
  eq(normalizeDateTime("2026-08-05T00:30:00+09:00"), "2026-08-05 00:30:00");
  eq(normalizeDateTime(new Date("2026-08-05T10:30:00Z")), "2026-08-05 19:30:00");
  eq(normalizeDateTime(Date.UTC(2026, 7, 5, 10, 30, 0)), "2026-08-05 19:30:00");
  for (const bad of ["", "어제", "2026-02-30", "08/05/2026", "25:00", "19:5", null, undefined, {}, "2026-08-05 25:00:00"]) {
    throws(() => normalizeDateTime(bad as never), `should reject ${JSON.stringify(bad)}`);
  }
  eq(isValidDateTime("2026-08-05 19:30:00"), true);
  eq(isValidDateTime("2026-08-05"), false);
  eq(isValidDateTime("2026-13-01 00:00:00"), false);
  eq([isDateField("date"), isDateField("created_at"), isDateField("food")].join(), "true,true,false");
  eq(
    JSON.stringify(normalizeRecordDates({ date: "2026-08-05", food: "김치찌개", note: null })),
    '{"date":"2026-08-05 00:00:00","food":"김치찌개","note":null}',
  );
  console.log("date.ts self-check OK");
}
