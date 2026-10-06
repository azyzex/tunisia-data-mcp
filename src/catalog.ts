// In-memory catalog: indicator search, data availability and region
// resolution. Everything here is built once per isolate at startup from the
// bundled snapshots, so search_indicators / list_regions / get_indicator
// never call the INS server.

import raw from "./data/catalog.json";
import rawAvailability from "./data/availability.json";
import type { Availability, AvailabilityEntry, Catalog, IndicatorEntry, RegionEntry, RegionLevel } from "./catalog-types";
import { EN_PHRASES, EN_WORDS, GOVERNORATE_NAMES, hasArabic, normalizeArabic } from "./lexicon";

export const catalog = raw as Catalog;
export const availability = rawAvailability as Availability;

/** The socio-economic database: the main, richest and most current INS dataset. */
export const MAIN_SOURCE = {
	id: "C_NSO",
	indicatorDim: "RDS_DICT_INDICATORS_NSO",
	regionDim: "RDS_DICT_REGIONS_NSO",
} as const;

/** Lowercase, strip accents and punctuation: "Bèja" -> "beja", "L'Ariana" -> "l ariana". */
export function normalize(s: string): string {
	return s
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

// ---------- Indicators ----------

export const indicatorsByKey = new Map<number, IndicatorEntry>(catalog.indicators.map((i) => [i.key, i]));

const childrenByParent = new Map<number, IndicatorEntry[]>();
for (const i of catalog.indicators) {
	if (i.parent === null) continue;
	if (!childrenByParent.has(i.parent)) childrenByParent.set(i.parent, []);
	childrenByParent.get(i.parent)!.push(i);
}

export const subIndicators = (ind: IndicatorEntry): IndicatorEntry[] => childrenByParent.get(ind.key) ?? [];

export function indicatorPath(ind: IndicatorEntry): string[] {
	const path: string[] = [];
	for (let p = ind.parent; p !== null; ) {
		const parent = indicatorsByKey.get(p);
		if (!parent) break;
		path.unshift(parent.name);
		p = parent.parent;
	}
	return path;
}

/**
 * Known errors in INS unit metadata, verified against the data. The labour
 * force survey indicators (keys 40xxxxxx) are labelled "Nombre" but published
 * in thousands: the working-age population reads 8884.7, i.e. 8.9 million.
 */
export function effectiveUnit(ind: IndicatorEntry): { unit: string | null; unit_note?: string } {
	if (ind.key >= 40_000_000 && ind.key < 41_000_000 && ind.unit === "Nombre") {
		return {
			unit: "Milliers (thousands)",
			unit_note: "INS metadata says 'Nombre', but these labour force survey values are in thousands (e.g. 3527.9 = 3.53 million employed).",
		};
	}
	return { unit: ind.unit ?? null };
}

/** Availability as probed at build time; undefined = no data found anywhere probed. */
export const availabilityOf = (key: number): AvailabilityEntry | undefined => availability.indicators[String(key)];

const FREQ_NAMES: Record<string, string> = { A: "annual", M: "monthly", Q: "quarterly", H: "half-yearly", D: "daily" };

/** Human-readable availability block used in tool outputs. */
export function describeAvailability(key: number) {
	const a = availabilityOf(key);
	if (!a) {
		return {
			has_data: false,
			hint: subIndicators(indicatorsByKey.get(key)!)?.length
				? "No values of its own: this is a category, use its sub-indicators."
				: "No values found at national, governorate or delegation level when the index was built.",
		};
	}
	return {
		has_data: true,
		frequency: [...a.f].map((c) => FREQ_NAMES[c] ?? c),
		first_period: a.first,
		latest_period: a.last,
		levels: [a.nat && "national", a.gov > 0 && "governorate", a.del && "delegation"].filter(Boolean),
	};
}

// Very common French words that carry no meaning in a search.
const STOPWORDS = new Set([
	"de", "des", "du", "la", "le", "les", "l", "d", "et", "en", "par", "a", "au", "aux", "selon", "pour", "sur",
	"the", "of", "in", "and", "for", "by", "tunisia", "tunisie", "tunisian",
]);

/**
 * Turn a query into a list of terms; each term is a set of alternative word
 * prefixes (OR). English words are expanded to their French equivalents,
 * while keeping the original word, so French queries are unaffected.
 */
export function queryTerms(query: string): string[][] {
	let q = ` ${normalize(query)} `;
	for (const [en, fr] of EN_PHRASES) q = q.replace(` ${en} `, ` ${fr} `);
	return q
		.split(" ")
		.filter((w) => w && !STOPWORDS.has(w))
		.map((w) => [w, ...(EN_WORDS[w] ?? [])]);
}

interface SearchDoc {
	ind: IndicatorEntry;
	short: string; // normalized short name, e.g. "tabac"
	full: string; // normalized full name, often repeats the parent: "indice des prix ... tabac"
	context: string; // normalized category path
	exact: string; // short name keywords, for exact-match detection
	depth: number;
}

const searchDocs: SearchDoc[] = catalog.indicators.map((ind) => {
	const path = indicatorPath(ind);
	return {
		ind,
		short: normalize(ind.name),
		full: normalize(ind.full_name ?? ""),
		context: normalize(path.join(" ")),
		exact: normalize(ind.name)
			.split(" ")
			.filter((w) => w && !STOPWORDS.has(w))
			.join(" "),
		depth: path.length,
	};
});

export interface IndicatorHit {
	ind: IndicatorEntry;
	score: number;
}

export interface SearchOptions {
	limit: number;
	/** Only indicators with values at this level (from the availability index). */
	level?: "any" | "national" | "governorate" | "delegation";
	/** Keep indicators without any data (pure categories). */
	includeEmpty?: boolean;
	/** Only indicators whose category path contains this text. */
	category?: string;
}

/**
 * Keyword search. Every query term must appear (as a word prefix) in the
 * indicator's short name, full name or category path; matches in the short
 * name weigh most. Sub-indicators often repeat their parent's words in their
 * full name ("Tabac" = "Indice des prix ... Tabac"), so shallower indicators
 * get a bonus. Indicators with recent data rank above stale or empty ones.
 */
export function searchIndicators(query: string, opts: SearchOptions): { total: number; hits: IndicatorHit[] } {
	const terms = queryTerms(query);
	if (terms.length === 0) return { total: 0, hits: [] };
	const category = opts.category ? normalize(opts.category) : "";

	const hasWord = (text: string, w: string) => text.startsWith(w) || text.includes(` ${w}`);
	const hasAny = (text: string, alts: string[]) => alts.some((w) => hasWord(text, w));
	const thisYear = new Date().getFullYear();
	const exactQuery = terms.map((t) => t[0]).join(" ");
	const hits: IndicatorHit[] = [];

	for (const doc of searchDocs) {
		if (category && !doc.context.includes(category) && !doc.short.includes(category)) continue;
		const av = availabilityOf(doc.ind.key);
		if (!opts.includeEmpty && !av) continue;
		if (opts.level === "national" && !av?.nat) continue;
		if (opts.level === "governorate" && !(av && av.gov > 0)) continue;
		if (opts.level === "delegation" && !av?.del) continue;

		let score = 0;
		let ok = true;
		for (const alts of terms) {
			if (hasAny(doc.short, alts)) score += 3;
			else if (hasAny(doc.full, alts)) score += 2;
			else if (hasAny(doc.context, alts)) score += 1;
			else {
				ok = false;
				break;
			}
		}
		if (!ok) continue;
		if (doc.exact === exactQuery) score += 6;
		score -= 0.5 * doc.depth;
		const lastYear = Number(av?.last.slice(0, 4) ?? doc.ind.last_updated?.slice(0, 4) ?? 0);
		if (lastYear >= thisYear - 1) score += 2;
		else if (lastYear >= thisYear - 4) score += 1;
		if (!av) score -= 2;
		hits.push({ ind: doc.ind, score });
	}
	hits.sort((a, b) => b.score - a.score || a.ind.name.length - b.ind.name.length);
	return { total: hits.length, hits: hits.slice(0, opts.limit) };
}

// ---------- Regions ----------

export const regionsByKey = new Map<number, RegionEntry>(catalog.regions.map((r) => [r.key, r]));
export const COUNTRY_KEY = 0;

export const governorates = catalog.regions.filter((r) => r.level === "governorate");

export const arabicName = (r: RegionEntry): string | undefined => (r.iso ? GOVERNORATE_NAMES[r.iso]?.ar : undefined);

const LEVEL_PRIORITY: Record<RegionLevel, number> = { governorate: 0, country: 1, region: 2, delegation: 3, sector: 4 };

/** "Gouvernorat de Sfax" -> "sfax", "Gouvernorat du Kef" / "Le Kef" -> "kef", "L'Ariana" -> "ariana". */
function coreName(name: string): string {
	return normalize(name)
		.replace(/^(gouvernorat|delegation|district|governorate|wilaya|wilayet) (de |du |d |of )?/, "")
		.replace(/^(le|la|les|l|el) /, "");
}

const ALIASES = new Map<string, number>([
	["tunisia", COUNTRY_KEY],
	["tunisie", COUNTRY_KEY],
	["national", COUNTRY_KEY],
	["country", COUNTRY_KEY],
	["grand tunis", 28629509],
	["greater tunis", 28629509],
	["north east", 1],
	["north west", 2],
	["centre east", 3],
	["center east", 3],
	["centre west", 4],
	["center west", 4],
	["south east", 5],
	["south west", 6],
]);
const ARABIC = new Map<string, number>([[normalizeArabic("تونس الكبرى"), 28629509], [normalizeArabic("الجمهورية التونسية"), COUNTRY_KEY]]);
for (const g of governorates) {
	const names = GOVERNORATE_NAMES[g.iso!];
	if (!names) continue;
	for (const alt of names.alt) ALIASES.set(alt, g.key);
	ARABIC.set(normalizeArabic(names.ar), g.key);
}
ARABIC.set(normalizeArabic("تونس"), 11); // governorate rather than country, like "Tunis"

export type RegionResolution =
	| { ok: true; region: RegionEntry }
	| { ok: false; reason: string; candidates: RegionEntry[] };

/**
 * Resolve user input to one region. Accepts an INS key ("34"), an ISO code
 * ("TN-61"), or a name in French, English or Arabic, in any accent/case form
 * ("sfax", "Gouvernorat de Sfax", "صفاقس").
 * Careful: INS keys are NOT the ISO numbers. Sfax is INS key 34 but ISO
 * TN-61, and INS key 61 is Gafsa. Outputs always echo name + ISO for this reason.
 * When a name is ambiguous we prefer the governorate, but only on an exact
 * core-name match; otherwise we return candidates instead of guessing.
 */
export function resolveRegion(input: string): RegionResolution {
	const q = input.trim();
	if (/^\d+$/.test(q)) {
		const r = regionsByKey.get(Number(q));
		return r ? { ok: true, region: r } : { ok: false, reason: `No region with INS key ${q}.`, candidates: [] };
	}
	if (/^tn-\d{2}$/i.test(q)) {
		const r = governorates.find((g) => g.iso === q.toUpperCase());
		return r ? { ok: true, region: r } : { ok: false, reason: `No governorate with ISO code ${q}.`, candidates: [] };
	}
	if (hasArabic(q)) {
		const key = ARABIC.get(normalizeArabic(q));
		if (key !== undefined) return { ok: true, region: regionsByKey.get(key)! };
		return { ok: false, reason: `No governorate matches "${input}". Arabic names are supported for governorates only; use list_regions.`, candidates: [] };
	}
	const n = normalize(q);
	const alias = ALIASES.get(n) ?? ALIASES.get(coreName(q));
	if (alias !== undefined) return { ok: true, region: regionsByKey.get(alias)! };
	const core = coreName(q);

	const byPriority = (a: RegionEntry, b: RegionEntry) => LEVEL_PRIORITY[a.level] - LEVEL_PRIORITY[b.level];
	const exact = catalog.regions.filter((r) => normalize(r.name) === n || coreName(r.name) === core).sort(byPriority);
	if (exact.length === 1 || (exact.length > 1 && LEVEL_PRIORITY[exact[0].level] < LEVEL_PRIORITY[exact[1].level])) {
		return { ok: true, region: exact[0] };
	}
	if (exact.length > 1) {
		return { ok: false, reason: `"${input}" matches several regions; pass one of the keys below.`, candidates: exact.slice(0, 10) };
	}
	const partial = catalog.regions.filter((r) => normalize(r.name).includes(n)).sort(byPriority);
	if (partial.length === 1) return { ok: true, region: partial[0] };
	return {
		ok: false,
		reason: partial.length ? `"${input}" is ambiguous; pass one of the keys below.` : `No region matches "${input}". Use list_regions.`,
		candidates: partial.slice(0, 10),
	};
}

export function isInside(r: RegionEntry, ancestorKey: number): boolean {
	for (let k = r.parent; k !== null; k = regionsByKey.get(k)?.parent ?? null) if (k === ancestorKey) return true;
	return false;
}

export function regionSummary(r: RegionEntry) {
	const parent = r.parent !== null ? regionsByKey.get(r.parent) : undefined;
	const ar = arabicName(r);
	return {
		key: r.key,
		name: r.name,
		level: r.level,
		...(r.iso ? { iso: r.iso } : {}),
		...(ar ? { name_ar: ar } : {}),
		...(parent ? { parent: parent.name } : {}),
	};
}
