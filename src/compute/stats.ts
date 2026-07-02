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

export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
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
// `order` sorts records so the record that should win a shared day sorts first
// (e.g. latest start); the result is always re-sorted newest-day-first.
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
