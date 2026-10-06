import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeDate, normalizePeriod, parseGetData, parseGetDataBorders, InsResponseError } from "../src/ins/parse";

const sample = (f: string) => readFileSync(`samples/${f}`, "utf8");

describe("parseGetData", () => {
	it("parses the central-bank series exactly as shown on the portal", () => {
		const obs = parseGetData(sample("GetData_bank_tunisie.xml"));
		const byYear = Object.fromEntries(obs.map((o) => [o.period, o.value]));
		expect(byYear["1990"]).toBe(905.7);
		expect(byYear["2022"]).toBe(9452);
		expect(obs.every((o) => o.frequency === "annual")).toBe(true);
		expect(obs[0].dims).toEqual({ UNITS: "1", RDS_DICT_INDICATORS_NSO: "27545539", RDS_DICT_REGIONS_NSO: "0" });
	});

	it("does not invent the years INS leaves out", () => {
		const periods = parseGetData(sample("GetData_bank_tunisie.xml")).map((o) => o.period);
		for (const y of ["2005", "2008", "2009"]) expect(periods).not.toContain(y);
	});

	it("parses monthly data with attributes in a different order", () => {
		const obs = parseGetData(sample("GetData_ipc_noperiod.xml"));
		expect(obs.at(-1)).toMatchObject({ period: "2026-09", frequency: "monthly", value: 198.9 });
	});

	it("treats an empty Success response as no data", () => {
		expect(parseGetData(`<?xml version="1.0" encoding="utf-8"?><Series State="Success"/>`)).toEqual([]);
	});

	it("throws on IncorrectRequest", () => {
		expect(() => parseGetData(`<?xml version="1.0"  encoding="utf-8"?><Series State="IncorrectRequest" />`)).toThrow(InsResponseError);
	});

	it("skips non-numeric values instead of turning them into numbers", () => {
		const xml = `<Series State="Success"><Set Period="YEARS:2000" UNITS="1">12.5</Set><Set Period="YEARS:2001" UNITS="1"></Set><Set Period="YEARS:2002" UNITS="1">n/a</Set></Series>`;
		expect(parseGetData(xml).map((o) => o.period)).toEqual(["2000"]);
	});
});

describe("normalizers", () => {
	it("normalizes all period kinds", () => {
		expect(normalizePeriod("YEARS:1990")).toEqual({ period: "1990", frequency: "annual" });
		expect(normalizePeriod("MONTHS:7.2026")).toEqual({ period: "2026-07", frequency: "monthly" });
		expect(normalizePeriod("QUARTERS:3.2020")).toEqual({ period: "2020-Q3", frequency: "quarterly" });
		expect(normalizePeriod("HALFYEARS:1.2020")).toEqual({ period: "2020-H1", frequency: "half-yearly" });
		expect(() => normalizePeriod("WEEKS:3.2020")).toThrow();
	});

	it("normalizes INS dates", () => {
		expect(normalizeDate("21/04/2016 15:33:02")).toBe("2016-04-21");
		expect(normalizeDate("2024-02-26T17:09:44.997")).toBe("2024-02-26");
		expect(normalizeDate("0001-01-01T00:00:00")).toBeNull();
		expect(normalizeDate("")).toBeNull();
	});

	it("parses data borders", () => {
		expect(parseGetDataBorders(sample("GetDataBorders_bank_tunisie.xml"))).toEqual({ start: "1990", finish: "2022" });
	});
});
