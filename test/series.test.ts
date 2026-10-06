import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseGetData } from "../src/ins/parse";
import { buildSeries, freshnessWarnings, summarizeSeries } from "../src/series";

const bank = parseGetData(readFileSync("samples/GetData_bank_tunisie.xml", "utf8"));
const now = new Date("2026-10-06T00:00:00Z");

describe("buildSeries", () => {
	it("inserts gaps as null and lists them", () => {
		const s = buildSeries(bank, "annual");
		expect(s.first_period).toBe("1990");
		expect(s.last_period).toBe("2022");
		expect(s.missing_periods).toEqual(["2005", "2008", "2009"]);
		expect(s.observations.find((o) => o.period === "2008")).toEqual({ period: "2008", value: null });
		expect(s.observation_count).toBe(30); // real values only
		expect(s.observations).toHaveLength(33);
		expect(s.scale).toMatch(/^×1/);
	});

	it("filters by year range and only reports gaps inside it", () => {
		const s = buildSeries(bank, "annual", 2010, 2015);
		expect(s.observations.map((o) => o.period)).toEqual(["2010", "2011", "2012", "2013", "2014", "2015"]);
		expect(s.missing_periods).toEqual([]);
	});

	it("detects monthly gaps across year boundaries", () => {
		const obs = [
			{ period: "2025-11", frequency: "monthly" as const, value: 1, dims: {} },
			{ period: "2026-02", frequency: "monthly" as const, value: 2, dims: {} },
		];
		expect(buildSeries(obs, "monthly").missing_periods).toEqual(["2025-12", "2026-01"]);
	});

	it("flags mixed scale codes", () => {
		const obs = [
			{ period: "2020", frequency: "annual" as const, value: 1, dims: { UNITS: "1" } },
			{ period: "2021", frequency: "annual" as const, value: 2, dims: { UNITS: "3" } },
		];
		expect(buildSeries(obs, "annual").scale).toMatch(/mixed/);
	});
});

describe("freshnessWarnings", () => {
	it("warns when the latest value is old", () => {
		const w = freshnessWarnings({ last_period: "2014", missing_periods: [] }, "2015-06-01", now);
		expect(w.join(" ")).toMatch(/2014.*not current/);
		expect(w.join(" ")).toMatch(/last updated this indicator on 2015-06-01/);
	});

	it("warns about projections beyond the current year", () => {
		expect(freshnessWarnings({ last_period: "2044", missing_periods: [] }, undefined, now).join(" ")).toMatch(/projections/);
	});

	it("is quiet for current data without gaps", () => {
		expect(freshnessWarnings({ last_period: "2026-09", missing_periods: [] }, "2026-10-05", now)).toEqual([]);
	});

	it("mentions gaps", () => {
		expect(freshnessWarnings({ last_period: "2022", missing_periods: ["2005", "2008"] }, undefined, now).join(" ")).toMatch(/2005, 2008/);
	});
});

describe("summarizeSeries", () => {
	it("computes changes from real values only", () => {
		const sum = summarizeSeries(buildSeries(bank, "annual", 2006, 2011));
		expect(sum.latest).toEqual({ period: "2011", value: 3577.1 });
		expect(sum.previous).toEqual({ period: "2010", value: 319.9 }); // 2008-2009 are gaps, skipped
		expect(sum.pct_change_from_previous).toBe(1018.19);
		expect(sum.min).toEqual({ period: "2007", value: 80.9 });
		expect(sum.cagr_pct).toBeCloseTo(((3577.1 / 108.6) ** (1 / 5) - 1) * 100, 1);
	});

	it("computes year-on-year for monthly series", () => {
		const obs = ["2025-08", "2025-09", "2026-08", "2026-09"].map((p, i) => ({ period: p, frequency: "monthly" as const, value: [100, 101, 105, 110][i], dims: {} }));
		const sum = summarizeSeries(buildSeries(obs, "monthly"));
		expect(sum.same_period_last_year).toEqual({ period: "2025-09", value: 101 });
		expect(sum.pct_change_year_on_year).toBe(8.91);
	});
});
