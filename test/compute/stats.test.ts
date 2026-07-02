import { describe, it, expect } from "vitest";
import {
  mean,
  stddev,
  roundTo,
  kjToKcal,
  KJ_TO_KCAL,
  dedupeByDay,
  windowByDays,
} from "../../src/compute/stats.js";

describe("mean", () => {
  it("returns null (never 0) on empty input", () => {
    expect(mean([])).toBeNull();
  });
  it("averages a single value", () => {
    expect(mean([7])).toBe(7);
  });
  it("averages multiple values", () => {
    expect(mean([2, 4])).toBe(3);
    expect(mean([1, 2, 3, 4])).toBe(2.5);
  });
  it("does not treat a genuine 0 average as missing", () => {
    expect(mean([0, 0, 0])).toBe(0);
  });
});

describe("stddev", () => {
  it("returns null on empty input", () => {
    expect(stddev([])).toBeNull();
  });
  it("returns null for fewer than 2 items (undefined spread)", () => {
    expect(stddev([5])).toBeNull();
  });
  it("computes population stddev for >= 2 items", () => {
    // mean 3; variance mean([1,1]) = 1; sqrt = 1
    expect(stddev([2, 4])).toBe(1);
    // all equal → 0 (a real zero, not null)
    expect(stddev([5, 5, 5])).toBe(0);
  });
});

describe("roundTo", () => {
  it("rounds to the requested number of decimals", () => {
    expect(roundTo(1.2345, 2)).toBe(1.23);
    expect(roundTo(1.2355, 2)).toBe(1.24);
    expect(roundTo(2.5, 0)).toBe(3);
    expect(roundTo(10 / 3, 1)).toBe(3.3);
  });
  it("leaves whole numbers untouched", () => {
    expect(roundTo(42, 2)).toBe(42);
  });
});

describe("kjToKcal / KJ_TO_KCAL", () => {
  it("exposes the documented conversion constant", () => {
    expect(KJ_TO_KCAL).toBe(0.239006);
  });
  it("converts kilojoules to rounded kilocalories", () => {
    expect(kjToKcal(1000)).toBe(239); // round(239.006)
    expect(kjToKcal(0)).toBe(0);
    expect(kjToKcal(8368)).toBe(Math.round(8368 * 0.239006));
  });
});

describe("dedupeByDay", () => {
  it("keeps one record per UTC day with latest-start winning, newest day first", () => {
    const records = [
      { day: "2026-01-01", start: "2026-01-01T08:00:00Z", id: "a-early" },
      { day: "2026-01-01", start: "2026-01-01T22:00:00Z", id: "a-late" },
      { day: "2026-01-02", start: "2026-01-02T07:00:00Z", id: "b" },
    ];
    const out = dedupeByDay(
      records,
      (r) => r.day,
      (x, y) => y.start.localeCompare(x.start), // latest start sorts first → wins the day
    );
    expect(out.map((o) => o.date)).toEqual(["2026-01-02", "2026-01-01"]);
    expect(out[1].value.id).toBe("a-late"); // latest wins for the shared day
  });

  it("returns an empty array for empty input", () => {
    expect(dedupeByDay([], (r: { day: string }) => r.day, () => 0)).toEqual([]);
  });
});

describe("windowByDays", () => {
  // entries are newest-first with gaps (missing calendar days).
  const entries = [
    { date: "2026-01-10", v: 10 },
    { date: "2026-01-09", v: 9 },
    { date: "2026-01-05", v: 5 },
    { date: "2026-01-03", v: 3 },
  ];

  it("anchors on the newest entry and excludes gaps (never zero-fills)", () => {
    // window [01-04 .. 01-10]: includes 10, 09, 05; excludes 03
    const w = windowByDays(entries, 7);
    expect(w.map((e) => e.date)).toEqual(["2026-01-10", "2026-01-09", "2026-01-05"]);
  });

  it("applies the offset for a trailing (previous) window", () => {
    // offset 7 → window [2025-12-28 .. 2026-01-03]: only 01-03
    const prev = windowByDays(entries, 7, 7);
    expect(prev.map((e) => e.date)).toEqual(["2026-01-03"]);
  });

  it("returns an empty array for empty input", () => {
    expect(windowByDays([], 7)).toEqual([]);
  });

  it("includes an exact single-day window boundary", () => {
    const w = windowByDays(entries, 1);
    expect(w.map((e) => e.date)).toEqual(["2026-01-10"]);
  });
});
