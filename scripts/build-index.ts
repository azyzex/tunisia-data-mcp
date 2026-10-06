// Builds the compact JSON catalog bundled into the Worker (src/data/*.json).
//
// Why at build time: the indicator dimension alone is ~2.2 MB of XML (7,000+
// nodes). Downloading and parsing it on every tool call would be slow and
// would hammer the INS server. The catalog changes rarely, so we snapshot it
// and re-run this script when we want fresh metadata.
//
// Usage:
//   npx tsx scripts/build-index.ts            # fetch live from INS
//   npx tsx scripts/build-index.ts --samples  # use the XML files in samples/

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeDate, parseXml, stripHtml } from "../src/ins/parse";
import { readCache, writeCache } from "./cache";
import type { Catalog, DatasetEntry, DimensionElement, DimensionEntry, IndicatorEntry, RegionEntry, RegionLevel } from "../src/catalog-types";

const BASE = "http://dataportal.ins.tn/WebApi/";
const useSamples = process.argv.includes("--samples");

async function fetchXml(endpoint: string, body: string, sampleFile: string): Promise<string> {
	if (useSamples) return readFileSync(join("samples", sampleFile), "utf8");
	const res = await fetch(BASE + endpoint, {
		method: "POST",
		headers: { "Content-Type": "text/xml; charset=UTF-8" },
		body,
		signal: AbortSignal.timeout(120_000),
	});
	if (!res.ok) throw new Error(`${endpoint}: HTTP ${res.status}`);
	const text = await res.text();
	writeFileSync(join("samples", sampleFile), text); // keep samples in sync
	return text;
}

const dimQuery = (id: string) =>
	`<QueryMessage><DataWhere><DimensionId WithData='true'>${id}</DimensionId></DataWhere></QueryMessage>`;

function buildDatasets(xml: string): DatasetEntry[] {
	const doc = parseXml(xml).Structure;
	if (doc?.Status !== "Success") throw new Error("GetStructure did not return Success");
	return doc.Sources.Source.map((s: any): DatasetEntry => ({
		id: s.Id,
		name: s.Name.trim(),
		description: stripHtml(typeof s.Description === "string" ? s.Description : ""),
		start_year: s.Period?.StartYear ? Number(s.Period.StartYear) : null,
		end_year: s.Period?.FinishYear ? Number(s.Period.FinishYear) : null,
		dimensions: (s.Dimensions?.Dimension ?? []).map((d: any) => ({
			id: d.Id,
			name: d.Name,
			type: d.DimensionType ?? null,
			// The UNITS dimension reports "now" as LastUpdated; that's not meaningful.
			last_updated: d.Id === "UNITS" ? null : normalizeDate(d.LastUpdated),
		})),
	}));
}

function buildIndicators(xml: string): IndicatorEntry[] {
	const root = parseXml(xml).Dimension[0]; // "Dimension" is in the isArray list
	const out: IndicatorEntry[] = [];
	// No breadcrumb is stored: the Worker rebuilds it from `parent` at startup,
	// which keeps the bundle ~900 KB smaller.
	const walk = (els: any[], parent: number | null) => {
		for (const e of els ?? []) {
			const children = e.Element ?? [];
			const entry: IndicatorEntry = {
				key: Number(e.KEY),
				name: e.NAME.trim(),
				parent,
				is_category: children.length > 0,
			};
			const full = (e.FULLNAME ?? "").trim();
			if (full && full !== entry.name) entry.full_name = full;
			if (e.UNIT?.trim()) entry.unit = e.UNIT.trim();
			const ts = normalizeDate(e.TIMESTAMP);
			if (ts) entry.last_updated = ts;
			if (e.SOURCES?.trim()) entry.source = e.SOURCES.trim().replace(/\s+/g, " ");
			// Some INS comments are placeholder numbers ("100000"); keep only real text.
			const isText = (s: string) => /[a-zA-ZÀ-ɏ؀-ۿ]{3}/.test(s);
			const note = stripHtml(e.COMMENT);
			if (isText(note)) entry.note = note;
			const meth = stripHtml(e.METHODOLOGY);
			if (isText(meth)) entry.methodology = meth;
			out.push(entry);
			walk(children, entry.key);
		}
	};
	walk(root.Elements.Element, null);
	return out;
}

const LEVELS: RegionLevel[] = ["country", "region", "governorate", "delegation", "sector"];

function buildRegions(xml: string): RegionEntry[] {
	const root = parseXml(xml).Dimension[0]; // "Dimension" is in the isArray list
	const out: RegionEntry[] = [];
	const walk = (els: any[], depth: number, parent: number | null) => {
		for (const e of els ?? []) {
			const iso = e.ISO?.trim() || undefined;
			// Governorates are the only nodes carrying an ISO 3166-2 code (TN-xx).
			// "District de Tunis" sits at region depth but is a grouping of governorates.
			const level: RegionLevel = iso ? "governorate" : LEVELS[Math.min(depth, LEVELS.length - 1)];
			const entry: RegionEntry = { key: Number(e.KEY), name: e.NAME.trim(), level, parent };
			if (iso) entry.iso = iso;
			out.push(entry);
			walk(e.Element, depth + 1, entry.key);
		}
	};
	walk(root.Elements.Element, 0, null);
	return out;
}

// ---------- Dimensions of the other 77 datasets ----------
// Each INS dataset besides C_NSO has its own small dimensions (indicator list,
// sex, age group, milieu urbain/rural...). Only the region dimension is
// shared. We snapshot them all so query_dataset can resolve labels offline.

const SHARED_DIMS = new Set(["RDS_DICT_REGIONS_NSO", "RDS_DICT_INDICATORS_NSO", "UNITS"]);

async function fetchDimension(id: string): Promise<string> {
	const file = join(".cache/dims", `${id}.xml`);
	const cached = readCache(file, useSamples);
	if (cached) return cached;
	if (useSamples) throw new Error(`--samples: no cached dimension ${id}; run once without --samples`);
	const res = await fetch(BASE + "GetDimensionElements", {
		method: "POST",
		headers: { "Content-Type": "text/xml; charset=UTF-8" },
		body: dimQuery(id),
		signal: AbortSignal.timeout(120_000),
	});
	if (!res.ok) throw new Error(`GetDimensionElements ${id}: HTTP ${res.status}`);
	const text = await res.text();
	writeCache(file, text);
	await new Promise((r) => setTimeout(r, 300)); // be polite to INS
	return text;
}

function buildDimension(xml: string): DimensionEntry {
	const root = parseXml(xml).Dimension[0];
	if (root.Status !== "Success") throw new Error(`Dimension ${root.Id}: status ${root.Status}`);
	const elements: DimensionElement[] = [];
	const walk = (els: any[], parent: number | null) => {
		for (const e of els ?? []) {
			const el: DimensionElement = { key: Number(e.KEY), name: String(e.NAME ?? "").trim(), parent };
			const full = String(e.FULLNAME ?? "").trim();
			if (full && full !== el.name) el.full_name = full;
			const unit = String(e.UNIT ?? e.C_UNITE ?? "").trim();
			if (unit) el.unit = unit;
			elements.push(el);
			walk(e.Element, el.key);
		}
	};
	walk(root.Elements?.Element, null);
	return { id: root.Id, name: root.Name, last_updated: normalizeDate(root.LastUpdated), elements };
}

async function buildDimensions(datasets: DatasetEntry[]): Promise<Record<string, DimensionEntry>> {
	const ids = [...new Set(datasets.flatMap((d) => d.dimensions.map((x) => x.id)))].filter((id) => !SHARED_DIMS.has(id));
	const out: Record<string, DimensionEntry> = {};
	for (const id of ids) {
		try {
			out[id] = buildDimension(await fetchDimension(id));
		} catch (e) {
			console.warn(`  skipping dimension ${id}: ${(e as Error).message}`);
		}
	}
	return out;
}

async function main() {
	const [structureXml, indicatorsXml, regionsXml] = await Promise.all([
		fetchXml("GetStructure", "<QueryMessage></QueryMessage>", "GetStructure.xml"),
		fetchXml("GetDimensionElements", dimQuery("RDS_DICT_INDICATORS_NSO"), "GetDimensionElements_RDS_DICT_INDICATORS_NSO.xml"),
		fetchXml("GetDimensionElements", dimQuery("RDS_DICT_REGIONS_NSO"), "GetDimensionElements_regions.xml"),
	]);

	const datasets = buildDatasets(structureXml);
	const catalog: Catalog = {
		built_at: new Date().toISOString(),
		datasets,
		dimensions: await buildDimensions(datasets),
		indicators: buildIndicators(indicatorsXml),
		regions: buildRegions(regionsXml),
	};

	mkdirSync("src/data", { recursive: true });
	const json = JSON.stringify(catalog);
	writeFileSync("src/data/catalog.json", json);

	const govs = catalog.regions.filter((r) => r.level === "governorate").length;
	console.log(
		`catalog.json: ${(json.length / 1024).toFixed(0)} KB — ${catalog.datasets.length} datasets, ` +
			`${catalog.indicators.length} indicators, ${catalog.regions.length} regions (${govs} governorates), ` +
			`${Object.keys(catalog.dimensions).length} dataset dimensions`,
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
