// Shared numeric and calendar-day helpers for the compute layer.
// Missing data is represented as null everywhere — never zero — so an empty
// input yields null rather than a fabricated 0.

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function stddev(values: number[]): number | null {
  if (values.length < 2) return null;
  const avg = mean(values);
  if (avg == null) return null;
  const variance = mean(values.map((v) => (v - avg) ** 2));
  return variance == null ? null : Math.sqrt(variance);
}

// Rounds to `decimals` places. Null in → null out (never a fabricated 0): a bare
// Math.round(null * factor) would silently coerce null to 0, so guard it here as a
// defensive backstop even though callers already null-check. Overloaded so a
// definitely-number argument keeps a `number` return (no call-site churn).
export function roundTo(value: number, decimals: number): number;
export function roundTo(value: number | null, decimals: number): number | null;
export function roundTo(value: number | null, decimals: number): number | null {
  if (value == null) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// Whole calendar days from `b` to `a` (a − b), both YYYY-MM-DD in UTC. Positive
// when `a` is the later day; 1 means `a` is the immediately-following calendar day.
export function dayDiff(a: string, b: string): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round(
    (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / MS_PER_DAY,
  );
}

// WHOOP reports energy in kilojoules; athletes think in kilocalories.
export const KJ_TO_KCAL = 0.239006;

export function kjToKcal(kilojoule: number): number {
  return Math.round(kilojoule * KJ_TO_KCAL);
}

// --- Calendar-day bucketing (all day boundaries are evaluated in UTC) ---

export interface DayBucket<T> {
  date: string; // YYYY-MM-DD (UTC)
  value: T;
}

// Reduce records to at most one per UTC calendar day, newest day first.
// Which record wins a shared day is decided solely by `order`: it sorts records
// so the intended winner comes first. Cycles pass a real timestamp tiebreak
// (latest `start` wins), so for them this is genuinely "latest-wins". Recovery and
// sleep carry only a YYYY-MM-DD `date` (no intra-day timestamp), so their `order`
// compares by day alone and same-day ties fall back to input order (a stable sort)
// — NOT a true latest-wins. The result is always re-sorted newest-day-first.
export function dedupeByDay<T>(
  records: T[],
  getDay: (r: T) => string,
  order: (a: T, b: T) => number,
): DayBucket<T>[] {
  const sorted = [...records].sort(order);
  const seen = new Set<string>();
  const out: DayBucket<T>[] = [];
  for (const r of sorted) {
    const date = getDay(r);
    if (seen.has(date)) continue;
    seen.add(date);
    out.push({ date, value: r });
  }
  out.sort((a, b) => b.date.localeCompare(a.date));
  return out;
}

function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().split("T")[0];
}

// Entries (newest-first) falling within a calendar window anchored at the newest
// entry present: [anchor - offset - (n - 1) .. anchor - offset]. Missing days are
// simply absent — they are never zero-filled.
export function windowByDays<E extends { date: string }>(
  entries: E[],
  n: number,
  offset = 0,
): E[] {
  if (entries.length === 0) return [];
  const anchor = entries[0].date;
  const hi = shiftDay(anchor, -offset);
  const lo = shiftDay(anchor, -(offset + n - 1));
  return entries.filter((e) => e.date >= lo && e.date <= hi);
}
