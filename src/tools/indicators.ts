// Tools over the main INS socio-economic database (C_NSO): search, indicator
// details, time series, regional comparisons and governorate profiles.

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
	availabilityOf,
	catalog,
	COUNTRY_KEY,
	effectiveUnit,
	governorates,
	indicatorsByKey,
	MAIN_SOURCE,
	regionSummary,
	searchIndicators,
	subIndicators,
} from "../catalog";
import type { IndicatorEntry, RegionEntry } from "../catalog-types";
import { buildDataQuery, type InsClient } from "../ins/client";
import { InsResponseError, parseGetData, type RawObservation } from "../ins/parse";
import { buildSeries, freshnessWarnings, frequenciesOf, summarizeSeries, type Frequency } from "../series";
import {
	fail,
	guarded,
	indicatorDetails,
	indicatorSummary,
	isResult,
	lookupIndicator,
	lookupRegion,
	ok,
	OFFLINE,
	READ_ONLY,
	retrieval,
	type ToolResult,
} from "./common";

const regionOf = (o: RawObservation) => Number(o.dims[MAIN_SOURCE.regionDim]);
const indicatorOf = (o: RawObservation) => Number(o.dims[MAIN_SOURCE.indicatorDim]);

/**
 * One GetData call. Keys are sorted so equivalent requests share a cache entry.
 *
 * With `years`, INS filters server-side, which keeps responses small (a
 * 14-indicator x 25-region profile drops from ~790 KB to ~170 KB) and parsing
 * inside the Workers CPU budget. The filter only works with plain-year bounds
 * AND an explicit frequency list matching the data (e.g. "Y|Q"); INS rejects
 * some combinations, so on IncorrectRequest we fall back to the full series
 * and filter locally.
 */
export async function fetchObservations(
	client: InsClient,
	indicatorKeys: number[],
	regionKeys: number[],
	years?: { from: number; to: number; frequency?: string },
) {
	const where = {
		[MAIN_SOURCE.indicatorDim]: [...new Set(indicatorKeys)].sort((a, b) => a - b),
		[MAIN_SOURCE.regionDim]: [...new Set(regionKeys)].sort((a, b) => a - b),
	};
	const codes = [...new Set(indicatorKeys.flatMap((k) => [...(availabilityOf(k)?.f ?? "")]))].map((c) => (c === "A" ? "Y" : c));
	const frequency = years?.frequency ?? (codes.length > 0 && codes.length <= 2 ? codes.join("|") : undefined);
	if (years && frequency) {
		try {
			const res = await client.post("GetData", buildDataQuery(MAIN_SOURCE.id, where, { from: years.from, to: years.to, frequency }));
			return { res, obs: parseGetData(res.xml) };
		} catch (e) {
			if (!(e instanceof InsResponseError)) throw e;
		}
	}
	const res = await client.post("GetData", buildDataQuery(MAIN_SOURCE.id, where));
	return { res, obs: parseGetData(res.xml) };
}

const FREQUENCIES = ["annual", "monthly", "quarterly", "half-yearly", "daily"] as const;

function frequencyOfPeriod(period: string): Frequency {
	if (/^\d{4}$/.test(period)) return "annual";
	if (period.includes("Q")) return "quarterly";
	if (period.includes("H")) return "half-yearly";
	if (/^\d{4}-\d{2}-\d{2}$/.test(period)) return "daily";
	return "monthly";
}

function noDataResult(ind: IndicatorEntry, regions: RegionEntry[], res: Parameters<typeof retrieval>[0]): ToolResult {
	const children = subIndicators(ind);
	const av = availabilityOf(ind.key);
	const hints = [`INS has no data for this indicator in ${regions.map((r) => r.name).join(", ")}.`];
	if (children.length) hints.push("This indicator is a category; its values are published under the sub-indicators listed in try_sub_indicators.");
	if (av && !av.gov && regions.some((r) => r.key !== COUNTRY_KEY)) hints.push("According to the availability index this indicator is published at national level only.");
	return ok({
		indicator: indicatorDetails(ind),
		regions: regions.map(regionSummary),
		series: [],
		warnings: hints,
		...(children.length ? { try_sub_indicators: children.slice(0, 20).map(indicatorSummary) } : {}),
		retrieval: retrieval(res),
	});
}

// Indicators shown by region_profile. Chosen from the availability index:
// published for every governorate, still updated, and covering demography,
// labour, health, business and safety.
const PROFILE: { key: number; label: string; kind: "count" | "rate" }[] = [
	{ key: 11922316, label: "Population (1 January estimate)", kind: "count" },
	{ key: 27529859, label: "Crude birth rate (per 1,000)", kind: "rate" },
	{ key: 27529869, label: "Crude death rate (per 1,000)", kind: "rate" },
	{ key: 27529909, label: "Total fertility rate", kind: "rate" },
	{ key: 40008000, label: "Unemployment rate (%)", kind: "rate" },
	{ key: 40008002, label: "Unemployment rate, women (%)", kind: "rate" },
	{ key: 40003000, label: "Employed population (thousands)", kind: "count" },
	{ key: 22314916, label: "Job applications registered at employment offices", kind: "count" },
	{ key: 22300416, label: "Doctors", kind: "count" },
	{ key: 22301116, label: "Public hospital beds per 1,000 inhabitants", kind: "rate" },
	{ key: 22199216, label: "Private enterprises", kind: "count" },
	{ key: 27544679, label: "Bank branches", kind: "count" },
	{ key: 22357616, label: "Road accidents", kind: "count" },
	{ key: 22365916, label: "Road deaths", kind: "count" },
];
const POPULATION_KEY = 11922316;
const PER_CAPITA: { key: number; label: string; per: number }[] = [
	{ key: 22300416, label: "Doctors per 10,000 inhabitants", per: 10_000 },
	{ key: 22199216, label: "Private enterprises per 1,000 inhabitants", per: 1_000 },
	{ key: 27544679, label: "Bank branches per 100,000 inhabitants", per: 100_000 },
	{ key: 22365916, label: "Road deaths per 100,000 inhabitants", per: 100_000 },
];

export function registerIndicatorTools(server: McpServer, client: InsClient) {
	// ---------------------------------------------------------------- search_indicators
	server.registerTool(
		"search_indicators",
		{
			title: "Search INS indicators",
			description:
				"Search the ~7,000 indicators of Tunisia's main statistics database (INS socio-economic database). Labels are French; English keywords " +
				"are translated automatically (unemployment, inflation, births, exports, doctors...). Accents and case are ignored. " +
				"Each result says whether it has data, its frequency, latest period and at which levels (national/governorate). " +
				"By default only indicators that actually have data are returned. Use the key with get_series, compare_regions or get_indicator.",
			inputSchema: z.object({
				query: z.string().min(2).describe("Keywords in French or English, e.g. 'taux de chômage', 'inflation', 'naissances', 'doctors'."),
				level: z
					.enum(["any", "national", "governorate", "delegation"])
					.default("any")
					.describe("'governorate' returns only indicators published per governorate (needed for compare_regions)."),
				category: z.string().optional().describe("Restrict to a category, e.g. 'Santé', 'Emploi', 'Prix', 'Population', 'Transport'."),
				include_without_data: z.boolean().default(false).describe("Also return pure categories that have no values of their own."),
				limit: z.number().int().min(1).max(50).default(15),
			}),
			annotations: OFFLINE,
		},
		async ({ query, level, category, include_without_data, limit }) => {
			const { total, hits } = searchIndicators(query, { limit, level, category, includeEmpty: include_without_data });
			if (total === 0) {
				return ok({
					total: 0,
					results: [],
					hint:
						"No match. Try French terms, fewer or broader words, drop the level/category filter, or set include_without_data=true. " +
						"For census tables, projections or national accounts, use list_datasets; for ministry/municipal data, search_open_data.",
				});
			}
			return ok({ total, showing: hits.length, results: hits.map((h) => indicatorSummary(h.ind)) });
		},
	);

	// ---------------------------------------------------------------- get_indicator
	server.registerTool(
		"get_indicator",
		{
			title: "Indicator details",
			description:
				"Full description of one INS indicator: definition, methodology, source, unit, data availability, its parent category and sub-indicators " +
				"(e.g. breakdowns by sex or age). Use it to navigate the indicator tree or check coverage before fetching data.",
			inputSchema: z.object({ indicator_key: z.number().int() }),
			annotations: OFFLINE,
		},
		async ({ indicator_key }) => {
			const ind = lookupIndicator(indicator_key);
			if (isResult(ind)) return ind;
			const parent = ind.parent !== null ? indicatorsByKey.get(ind.parent) : undefined;
			const children = subIndicators(ind);
			const siblings = parent ? subIndicators(parent).filter((s) => s.key !== ind.key) : [];
			return ok({
				indicator: indicatorDetails(ind),
				parent: parent ? { key: parent.key, name: parent.name, has_data: !!availabilityOf(parent.key) } : null,
				sub_indicators: children.slice(0, 60).map((c) => ({ key: c.key, name: c.name, unit: c.unit ?? null, has_data: !!availabilityOf(c.key) })),
				...(children.length > 60 ? { sub_indicators_truncated: children.length } : {}),
				related: siblings.slice(0, 20).map((s) => ({ key: s.key, name: s.name, has_data: !!availabilityOf(s.key) })),
				note: "Availability comes from an index built at deploy time by probing national level and sample governorates/delegations.",
			});
		},
	);

	// ---------------------------------------------------------------- get_series
	server.registerTool(
		"get_series",
		{
			title: "Get a time series",
			description:
				"Fetch the values of one indicator from INS for one region, or up to 6 regions side by side. Returns observations with explicit unit, scale, " +
				"period covered, gaps (null, never filled), summary figures (latest value, change, year-on-year, min/max, CAGR) and freshness warnings " +
				"that must be relayed to the user.",
			inputSchema: z.object({
				indicator_key: z.number().int().describe("Indicator key from search_indicators."),
				region: z
					.string()
					.default("Tunisie")
					.describe("Region name (French/English/Arabic), ISO code ('TN-61') or INS key. Default: national."),
				regions: z.array(z.string()).max(6).optional().describe("Several regions at once (overrides 'region'), e.g. ['Tunis', 'Sfax', 'Sousse']."),
				from_year: z.number().int().min(1900).max(2100).optional(),
				to_year: z.number().int().min(1900).max(2100).optional(),
				frequency: z.enum(FREQUENCIES).optional().describe("Keep only this frequency when the indicator has several (e.g. annual and quarterly)."),
			}),
			annotations: READ_ONLY,
		},
		async ({ indicator_key, region, regions, from_year, to_year, frequency }) =>
			guarded(async () => {
				const ind = lookupIndicator(indicator_key);
				if (isResult(ind)) return ind;
				const targets: RegionEntry[] = [];
				for (const input of regions?.length ? regions : [region]) {
					const r = lookupRegion(input);
					if (isResult(r)) return r;
					if (!targets.some((t) => t.key === r.key)) targets.push(r);
				}

				// Server-side filter only on the lower bound: the upper bound is applied
				// locally so the latest available period (freshness) stays visible.
				const years = from_year !== undefined ? { from: from_year, to: new Date().getFullYear() + 30 } : undefined;
				const { res, obs } = await fetchObservations(client, [ind.key], targets.map((t) => t.key), years);
				const mine = obs.filter((o) => indicatorOf(o) === ind.key && targets.some((t) => t.key === regionOf(o)));
				if (mine.length === 0) return noDataResult(ind, targets, res);

				const series = targets.flatMap((t) => {
					const rObs = mine.filter((o) => regionOf(o) === t.key);
					return frequenciesOf(rObs)
						.filter((f) => !frequency || f === frequency)
						.map((f) => {
							const s = buildSeries(rObs, f, from_year, to_year);
							// Staleness is judged on the whole series, not on the requested
							// window: asking for 2000-2012 must not trigger "not current".
							const latest = buildSeries(rObs, f).last_period;
							return {
								region: regionSummary(t),
								...s,
								latest_available_period: latest,
								summary: s.observation_count ? summarizeSeries(s) : null,
								warnings: freshnessWarnings({ last_period: latest, missing_periods: s.missing_periods }, ind.last_updated),
							};
						});
				});
				const nonEmpty = series.filter((s) => s.observation_count > 0);
				const noData = targets.filter((t) => !mine.some((o) => regionOf(o) === t.key));
				const warnings: string[] = [];
				if (noData.length) warnings.push(`No data for: ${noData.map((t) => t.name).join(", ")}.`);
				if (nonEmpty.length === 0) {
					warnings.push(
						`No values in the requested range/frequency. Available: ${[...new Set(series.map((s) => `${s.frequency} ${s.region.name} up to ${s.latest_available_period}`))].join("; ")}.`,
					);
				}
				return ok({
					indicator: indicatorDetails(ind),
					series: nonEmpty,
					...(warnings.length ? { warnings } : {}),
					retrieval: retrieval(res),
				});
			}),
	);

	// ---------------------------------------------------------------- compare_regions
	server.registerTool(
		"compare_regions",
		{
			title: "Compare regions",
			description:
				"Compare one indicator across regions for the same period, ranked from highest to lowest, with the national value as reference " +
				"and each region's share of the national total for count indicators. Defaults to all 24 governorates and the most recent period " +
				"available for all of them. Set level='region' to compare the 7 large regions. Use search_indicators with level='governorate' to find suitable indicators.",
			inputSchema: z.object({
				indicator_key: z.number().int().describe("Indicator key from search_indicators."),
				regions: z.array(z.string()).max(40).optional().describe("Region names/keys/ISO codes. Omit to compare all governorates (or all regions with level='region')."),
				level: z.enum(["governorate", "region"]).default("governorate"),
				period: z
					.string()
					.regex(/^\d{4}(-(0[1-9]|1[0-2]|Q[1-4]|H[12]))?$/)
					.optional()
					.describe("'2023' for annual, '2024-06' monthly, '2025-Q2' quarterly. Default: latest period available for every compared region."),
			}),
			annotations: READ_ONLY,
		},
		async ({ indicator_key, regions, level, period }) =>
			guarded(async () => {
				const ind = lookupIndicator(indicator_key);
				if (isResult(ind)) return ind;

				let targets: RegionEntry[] = level === "region" ? catalog.regions.filter((r) => r.level === "region") : governorates;
				if (regions?.length) {
					targets = [];
					for (const name of regions) {
						const r = lookupRegion(name);
						if (isResult(r)) return r;
						if (!targets.some((t) => t.key === r.key)) targets.push(r);
					}
				}
				// Fetch a recent window only (CPU budget). The availability index knows
				// the national latest period; regional series can stop earlier, so if
				// most regions come back empty we retry with the full history.
				const regionKeys = [...targets.map((t) => t.key), COUNTRY_KEY];
				const last = Number((period ?? availabilityOf(ind.key)?.last ?? "").slice(0, 4));
				let { res, obs } = await fetchObservations(client, [ind.key], regionKeys, last ? { from: last - (period ? 0 : 4), to: last } : undefined);
				const covered = new Set(obs.map(regionOf));
				if (last && targets.filter((t) => covered.has(t.key)).length < targets.length / 2) {
					({ res, obs } = await fetchObservations(client, [ind.key], regionKeys));
				}

				// Compare on one frequency: the requested period's, else annual, the common denominator.
				const freqs = frequenciesOf(obs);
				const wanted: Frequency | undefined = period ? frequencyOfPeriod(period) : freqs.includes("annual") ? "annual" : freqs[0];
				const usable = obs.filter((o) => o.frequency === wanted);

				const perRegion = new Map<number, Map<string, number>>();
				for (const o of usable) {
					const k = regionOf(o);
					if (!perRegion.has(k)) perRegion.set(k, new Map());
					perRegion.get(k)!.set(o.period, o.value);
				}

				const withData = targets.filter((t) => perRegion.has(t.key));
				if (withData.length === 0) {
					return ok({
						indicator: indicatorDetails(ind),
						ranking: [],
						warnings: [
							subIndicators(ind).length
								? "No regional values for this indicator; it is a category, try its sub-indicators (get_indicator lists them)."
								: "INS has no regional data for this indicator. It is published at national level only; use get_series.",
						],
						retrieval: retrieval(res),
					});
				}

				let chosen = period;
				const warnings: string[] = [];
				if (!chosen) {
					const common = [...perRegion.get(withData[0].key)!.keys()].filter((p) => withData.every((t) => perRegion.get(t.key)!.has(p))).sort();
					if (common.length) chosen = common.at(-1)!;
					else {
						chosen = [...new Set(usable.filter((o) => regionOf(o) !== COUNTRY_KEY).map((o) => o.period))].sort().at(-1)!;
						warnings.push("No single period is available for every region; using the latest period overall, some regions are missing.");
					}
				}

				const national = perRegion.get(COUNTRY_KEY)?.get(chosen!) ?? null;
				const isRate = /%|taux|indice|pour 1000|par 1000|moyen|ratio/i.test(`${ind.unit ?? ""} ${ind.name} ${ind.full_name ?? ""}`);
				const rows = targets.map((t) => {
					const value = perRegion.get(t.key)?.get(chosen!) ?? null;
					return {
						...regionSummary(t),
						value,
						...(!isRate && national && value !== null ? { share_of_national_pct: Math.round((value / national) * 10000) / 100 } : {}),
						...(national && value !== null ? { vs_national_pct: Math.round(((value - national) / Math.abs(national)) * 10000) / 100 } : {}),
					};
				});
				const ranked = rows.filter((r) => r.value !== null).sort((a, b) => b.value! - a.value!);
				const missing = rows.filter((r) => r.value === null);
				if (missing.length) warnings.push(`No value for ${chosen} in: ${missing.map((m) => m.name).join(", ")}.`);
				warnings.push(...freshnessWarnings({ last_period: chosen!, missing_periods: [] }, ind.last_updated));
				if (isRate) warnings.push("This is a rate or index: regional values cannot be summed; vs_national_pct is relative to the national rate.");
				else warnings.push("vs_national_pct compares a region's total with the national total, so it is always strongly negative; use share_of_national_pct instead.");

				const values = ranked.map((r) => r.value!);
				const mean = values.reduce((a, b) => a + b, 0) / values.length;
				return ok({
					indicator: indicatorDetails(ind),
					period: chosen,
					frequency: wanted,
					...effectiveUnit(ind),
					national_value: national,
					statistics: {
						regions_with_data: values.length,
						highest: ranked[0] ? { name: ranked[0].name, value: ranked[0].value } : null,
						lowest: ranked.at(-1) ? { name: ranked.at(-1)!.name, value: ranked.at(-1)!.value } : null,
						max_to_min_ratio: values.length > 1 && values.at(-1)! > 0 ? Math.round((values[0] / values.at(-1)!) * 100) / 100 : null,
						unweighted_mean: Math.round(mean * 100) / 100,
					},
					ranking: ranked.map((r, i) => ({ rank: i + 1, ...r })),
					missing_regions: missing.map((m) => m.name),
					warnings,
					retrieval: retrieval(res),
				});
			}),
	);

	// ---------------------------------------------------------------- region_profile
	server.registerTool(
		"region_profile",
		{
			title: "Governorate profile",
			description:
				"Key figures for one governorate in a single call: population, birth/death/fertility rates, unemployment (total and women), employment, " +
				"doctors, hospital beds, enterprises, bank branches, road accidents, plus per-capita ratios. Each figure has its period, the national value " +
				"and the governorate's rank among the 24 governorates. Pass 'Tunisie' for the national profile.",
			inputSchema: z.object({
				region: z.string().describe("Governorate name (French/English/Arabic) or ISO code, e.g. 'Kasserine', 'TN-42', 'القصرين'."),
			}),
			annotations: READ_ONLY,
		},
		async ({ region }) =>
			guarded(async () => {
				const reg = lookupRegion(region);
				if (isResult(reg)) return reg;
				if (reg.level !== "governorate" && reg.key !== COUNTRY_KEY) {
					return fail(`region_profile works for governorates and the country; "${reg.name}" is a ${reg.level}. Use get_series for other levels.`);
				}
				const keys = PROFILE.map((p) => p.key);
				const thisYear = new Date().getFullYear();
				// Annual + quarterly over the last 12 years keeps the response small
				// (CPU budget) while still reaching series that stopped years ago.
				const { res, obs } = await fetchObservations(client, keys, [COUNTRY_KEY, ...governorates.map((g) => g.key)], {
					from: thisYear - 12,
					to: thisYear,
					frequency: "Y|Q",
				});

				// Most recent value per (indicator, region). Within the same year an
				// annual figure beats a quarter (it is the comprehensive measure), but a
				// 2026 quarter beats a 2016 annual value.
				const recency = (p: string) => Number(p.slice(0, 4)) * 10 + (frequencyOfPeriod(p) === "annual" ? 9 : Number(p.slice(-1)));
				const latest = new Map<string, { period: string; value: number }>();
				for (const o of obs) {
					if (o.frequency !== "annual" && o.frequency !== "quarterly") continue;
					const k = `${indicatorOf(o)}:${regionOf(o)}`;
					const cur = latest.get(k);
					if (!cur || recency(o.period) > recency(cur.period)) latest.set(k, { period: o.period, value: o.value });
				}
				const index = new Map(obs.map((o) => [`${indicatorOf(o)}:${regionOf(o)}:${o.period}`, o.value]));
				const valueAt = (ind: number, regKey: number, period: string) => index.get(`${ind}:${regKey}:${period}`) ?? null;

				const rankAmongGovernorates = (ind: number, period: string, value: number) => {
					const vals = governorates.map((g) => valueAt(ind, g.key, period)).filter((v): v is number => v !== null);
					return vals.length >= 20 ? { rank: 1 + vals.filter((v) => v > value).length, out_of: vals.length, order: "1 = highest" } : null;
				};

				const figures = PROFILE.map((p) => {
					const ind = indicatorsByKey.get(p.key)!;
					const mine = latest.get(`${p.key}:${reg.key}`);
					if (!mine) return { indicator_key: p.key, label: p.label, value: null, note: "not published for this region" };
					const national = reg.key === COUNTRY_KEY ? null : valueAt(p.key, COUNTRY_KEY, mine.period);
					return {
						indicator_key: p.key,
						label: p.label,
						ins_name: ind.full_name ?? ind.name,
						...effectiveUnit(ind),
						period: mine.period,
						value: mine.value,
						...(national !== null ? { national_value: national } : {}),
						...(reg.key !== COUNTRY_KEY ? { rank: rankAmongGovernorates(p.key, mine.period, mine.value) } : {}),
					};
				});

				const ratios = PER_CAPITA.flatMap((r) => {
					const v = latest.get(`${r.key}:${reg.key}`);
					const pop = v ? valueAt(POPULATION_KEY, reg.key, v.period) : null;
					if (!v || !pop) return [];
					const ratio = (x: number, p: number) => Math.round((x / p) * r.per * 100) / 100;
					const natV = valueAt(r.key, COUNTRY_KEY, v.period);
					const natPop = valueAt(POPULATION_KEY, COUNTRY_KEY, v.period);
					const all = governorates
						.map((g) => {
							const gv = valueAt(r.key, g.key, v.period);
							const gp = valueAt(POPULATION_KEY, g.key, v.period);
							return gv !== null && gp ? ratio(gv, gp) : null;
						})
						.filter((x): x is number => x !== null);
					const mineRatio = ratio(v.value, pop);
					return [
						{
							label: r.label,
							period: v.period,
							value: mineRatio,
							...(natV !== null && natPop ? { national_value: ratio(natV, natPop) } : {}),
							...(reg.key !== COUNTRY_KEY && all.length >= 20
								? { rank: { rank: 1 + all.filter((x) => x > mineRatio).length, out_of: all.length, order: "1 = highest" } }
								: {}),
							computed: "by this server from INS counts and the 1 January population estimate of the same year",
						},
					];
				});

				const periods = figures.map((f) => ("period" in f ? f.period : undefined)).filter((p): p is string => !!p);
				const oldest = periods.sort()[0];
				return ok({
					region: regionSummary(reg),
					figures,
					per_capita: ratios,
					warnings: [
						"Figures have different reference periods; always cite the period with each value.",
						...(oldest && Number(oldest.slice(0, 4)) <= new Date().getFullYear() - 3 ? [`Some figures are old (earliest: ${oldest}).`] : []),
					],
					related_tools: "Use get_series with an indicator_key for the history, compare_regions for the full ranking.",
					retrieval: retrieval(res),
				});
			}),
	);
}
