// Parsers for the INS (Prognoz) WebApi XML responses.
// Shared by the Worker (GetData / GetDataBorders at runtime) and by
// scripts/build-index.ts (GetStructure / GetDimensionElements at build time).

import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "",
	parseAttributeValue: false,
	parseTagValue: false,
	trimValues: true,
	// These tags can appear once or many times; always give us arrays.
	isArray: (name) => ["Element", "Set", "Source", "Dimension", "Attribute"].includes(name),
});

export class InsResponseError extends Error {}

/** Raw parse; exported for tests. */
export function parseXml(xml: string): any {
	// Some responses start with a UTF-8 BOM.
	return parser.parse(xml.replace(/^﻿/, ""));
}

// ---------- GetData ----------

export interface RawObservation {
	period: string; // normalized: "1990", "2026-07", "2026-Q1", "2026-H1", "2026-07-15"
	frequency: "annual" | "monthly" | "quarterly" | "half-yearly" | "daily";
	value: number;
	dims: Record<string, string>; // e.g. { RDS_DICT_REGIONS_NSO: "11", UNITS: "1" }
}

/** "YEARS:1990" -> 1990, "MONTHS:7.2026" -> 2026-07, ... */
export function normalizePeriod(raw: string): Pick<RawObservation, "period" | "frequency"> {
	const [kind, rest = ""] = raw.split(":");
	const parts = rest.split(".");
	const pad = (s: string) => s.padStart(2, "0");
	switch (kind) {
		case "YEARS":
			return { period: rest, frequency: "annual" };
		case "MONTHS":
			return { period: `${parts[1]}-${pad(parts[0])}`, frequency: "monthly" };
		case "QUARTERS":
			return { period: `${parts[1]}-Q${parts[0]}`, frequency: "quarterly" };
		case "HALFYEARS":
			return { period: `${parts[1]}-H${parts[0]}`, frequency: "half-yearly" };
		case "DAYS":
			return { period: `${parts[2]}-${pad(parts[1])}-${pad(parts[0])}`, frequency: "daily" };
		default:
			throw new InsResponseError(`Unknown period format from INS: "${raw}"`);
	}
}

/**
 * Parse a GetData response. Note: INS answers State="Success" with zero
 * <Set> elements both for "no data" and for unknown SourceIds, so an empty
 * array is a normal result, not an error.
 */
export function parseGetData(xml: string): RawObservation[] {
	// GetData responses are a flat list of <Set attr="..">number</Set>, up to
	// ~1 MB for multi-indicator queries. A general XML parser needs ~50 ms for
	// that, far over the Workers free-plan CPU budget (10 ms per request), so
	// this endpoint gets a dedicated single-pass scanner (~10x faster). Values
	// and attributes are numeric codes, so no entity decoding is needed.
	const head = xml.slice(0, 300).match(/<Series\b([^>]*)>|<Series\b([^>]*)\/>/);
	if (!head) throw new InsResponseError("GetData: response has no <Series> element");
	const state = (head[1] ?? head[2]).match(/\bState="([^"]*)"/)?.[1] ?? "Unknown";
	if (state !== "Success") throw new InsResponseError(`GetData: INS returned State="${state}"`);

	const out: RawObservation[] = [];
	const setRe = /<Set\b([^>]*?)(?:\/>|>([^<]*)<\/Set>)/g;
	const attrRe = /([\w.:-]+)="([^"]*)"/g;
	const periodCache = new Map<string, Pick<RawObservation, "period" | "frequency">>();
	for (let m = setRe.exec(xml); m !== null; m = setRe.exec(xml)) {
		const text = m[2]?.trim();
		const value = Number(text);
		// Never invent values: skip anything that isn't a real number.
		if (!text || !Number.isFinite(value)) continue;
		const dims: Record<string, string> = {};
		let period: string | undefined;
		attrRe.lastIndex = 0;
		for (let a = attrRe.exec(m[1]); a !== null; a = attrRe.exec(m[1])) {
			if (a[1] === "Period") period = a[2];
			else dims[a[1]] = a[2];
		}
		if (period === undefined) continue;
		let p = periodCache.get(period);
		if (!p) periodCache.set(period, (p = normalizePeriod(period)));
		out.push({ period: p.period, frequency: p.frequency, value, dims });
	}
	return out;
}

// ---------- GetDataBorders ----------

export function parseGetDataBorders(xml: string): { start: string; finish: string } | null {
	const b = parseXml(xml)?.Borders;
	if (!b || b.Status !== "Success") return null;
	if (b.Start === undefined || b.Finish === undefined) return null;
	return { start: String(b.Start), finish: String(b.Finish) };
}

// ---------- Dates ----------

/** "21/04/2016 15:33:02" -> "2016-04-21" ; ISO strings -> date part. */
export function normalizeDate(raw: string | undefined): string | null {
	if (!raw) return null;
	const fr = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
	if (fr) return `${fr[3]}-${fr[2]}-${fr[1]}`;
	const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
	if (iso && !iso[1].startsWith("0001")) return iso[1];
	return null;
}

export function stripHtml(s: string | undefined): string {
	return (s ?? "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
