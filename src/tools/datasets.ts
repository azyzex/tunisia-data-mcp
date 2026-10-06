// Tools over all 78 INS datasets (generic access) and the administrative
// geography.

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { catalog, isInside, MAIN_SOURCE, normalize, regionsByKey, regionSummary } from "../catalog";
import type { RegionEntry, RegionLevel } from "../catalog-types";
import { describeDataset, findDataset, planDatasetQuery, REGION_DIM } from "../datasets";
import { buildDataQuery, type InsClient } from "../ins/client";
import { parseGetData } from "../ins/parse";
import { buildSeries, freshnessWarnings, frequenciesOf, summarizeSeries } from "../series";
import { fail, guarded, isResult, lookupRegion, ok, OFFLINE, READ_ONLY, retrieval } from "./common";

export function registerDatasetTools(server: McpServer, client: InsClient) {
	// ---------------------------------------------------------------- list_datasets
	server.registerTool(
		"list_datasets",
		{
			title: "List INS datasets",
			description:
				"List the 78 databases of the INS data portal: the main socio-economic database (C_NSO, use search_indicators/get_series for it) and 77 thematic " +
				"tables such as the 2014 census (population, households, housing, education, employment by sector), population projections 2014-2044 and " +
				"national accounts. Query any of them with describe_dataset + query_dataset.",
			inputSchema: z.object({
				query: z.string().optional().describe("Optional keyword filter on name/description, e.g. 'logement', 'projection', 'PIB', 'recensement'."),
			}),
			annotations: OFFLINE,
		},
		async ({ query }) => {
			const q = query ? normalize(query) : "";
			const datasets = catalog.datasets
				.filter((d) => !q || normalize(`${d.name} ${d.description}`).includes(q))
				.map((d) => {
					const dates = d.dimensions.map((x) => x.last_updated).filter((x): x is string => !!x).sort();
					return {
						id: d.id,
						name: d.name,
						...(d.description && d.description !== d.name ? { description: d.description } : {}),
						declared_years: d.start_year && d.end_year ? (d.start_year === d.end_year ? `${d.start_year}` : `${d.start_year}-${d.end_year}`) : null,
						last_updated: dates.at(-1) ?? null,
						dimensions: d.dimensions.map((x) => x.name),
						how_to_query: d.id === MAIN_SOURCE.id ? "search_indicators + get_series" : "describe_dataset + query_dataset",
					};
				});
			return ok({
				count: datasets.length,
				note: "declared_years is the range the database is configured for, not proof that every year has data (C_NSO declares 1970-2050).",
				catalog_snapshot: catalog.built_at,
				datasets,
			});
		},
	);

	// ---------------------------------------------------------------- describe_dataset
	server.registerTool(
		"describe_dataset",
		{
			title: "Describe an INS dataset",
			description:
				"Show the dimensions of one INS dataset (e.g. Indicateurs, Sexe, Milieu, Tranche d'âge) and all their elements, plus which element is used " +
				"by default when a dimension is not filtered. Call this before query_dataset.",
			inputSchema: z.object({ dataset: z.string().describe("Dataset id from list_datasets (e.g. 'OBJ6943049') or part of its name.") }),
			annotations: OFFLINE,
		},
		async ({ dataset }) => {
			const ds = findDataset(dataset);
			if ("error" in ds) return fail(ds.error, { candidates: ds.candidates });
			if (ds.id === MAIN_SOURCE.id) {
				return ok({
					id: ds.id,
					name: ds.name,
					note: "This is the main socio-economic database with ~7,000 indicators: use search_indicators, get_indicator, get_series and compare_regions.",
				});
			}
			return ok(describeDataset(ds));
		},
	);

	// ---------------------------------------------------------------- query_dataset
	server.registerTool(
		"query_dataset",
		{
			title: "Query an INS dataset",
			description:
				"Fetch data from any INS dataset (census 2014 tables, population projections, national accounts...). Filter each dimension by element " +
				"names or keys as shown by describe_dataset, e.g. {\"Sexe\": [\"Féminin\"], \"Milieu\": [\"Rural\", \"Communal\"]}; use [\"*\"] for all " +
				"elements. Unfiltered dimensions default to their top-level element (usually 'Total'). Returns one labelled series per combination.",
			inputSchema: z.object({
				dataset: z.string().describe("Dataset id from list_datasets, e.g. 'OBJ6943049'."),
				filters: z
					.record(z.string(), z.array(z.string()).min(1))
					.default({})
					.describe("Dimension name or id -> element names/keys. Example: {\"Indicateurs\": [\"Taux de chômage\"], \"Sexe\": [\"*\"]}."),
				regions: z.array(z.string()).max(30).optional().describe("Region names/ISO codes. Default: national. Many census tables also have delegation-level data."),
				from_year: z.number().int().min(1900).max(2100).optional(),
				to_year: z.number().int().min(1900).max(2100).optional(),
			}),
			annotations: READ_ONLY,
		},
		async ({ dataset, filters, regions, from_year, to_year }) =>
			guarded(async () => {
				const ds = findDataset(dataset);
				if ("error" in ds) return fail(ds.error, { candidates: ds.candidates });
				const planned = planDatasetQuery(ds, filters, regions ?? []);
				if (!planned.ok) return fail(planned.error, planned.details ?? {});
				const { plan } = planned;

				const res = await client.post("GetData", buildDataQuery(ds.id, plan.where));
				const obs = parseGetData(res.xml);

				// Group observations into series by their full dimension combination.
				const groups = new Map<string, typeof obs>();
				for (const o of obs) {
					const id = Object.entries(o.dims)
						.filter(([k]) => k !== "UNITS")
						.sort()
						.map(([k, v]) => `${k}=${v}`)
						.join("|");
					if (!groups.has(id)) groups.set(id, []);
					groups.get(id)!.push(o);
				}

				const labelOf = (dimId: string, key: string) => {
					if (dimId === REGION_DIM) return regionsByKey.get(Number(key))?.name ?? key;
					const sel = plan.selections.find((s) => s.dim.id === dimId);
					return sel?.elements.find((e) => e.key === Number(key))?.name ?? key;
				};
				const unitOf = (dims: Record<string, string>) => {
					for (const s of plan.selections) {
						const el = s.elements.find((e) => e.key === Number(dims[s.dim.id]));
						if (el?.unit) return el.unit;
					}
					return null;
				};

				const series = [...groups.values()].flatMap((g) => {
					const dims = g[0].dims;
					const labels = Object.fromEntries(
						Object.entries(dims)
							.filter(([k]) => k !== "UNITS")
							.map(([k, v]) => [k === REGION_DIM ? "Région" : (plan.selections.find((s) => s.dim.id === k)?.dim.name ?? k), labelOf(k, v)]),
					);
					return frequenciesOf(g).map((f) => {
						const s = buildSeries(g, f, from_year, to_year);
						const latest = buildSeries(g, f).last_period;
						return {
							labels,
							unit: unitOf(dims),
							...s,
							latest_available_period: latest,
							summary: s.observation_count > 1 ? summarizeSeries(s) : null,
							warnings: freshnessWarnings({ last_period: latest, missing_periods: s.missing_periods }, undefined),
						};
					});
				});

				const defaulted = plan.selections.filter((s) => s.defaulted).map((s) => `${s.dim.name} = ${s.elements.map((e) => e.name).join(", ")}`);
				const warnings: string[] = [];
				if (series.length === 0) {
					warnings.push(
						"INS returned no data for this selection. Check that the elements exist for these regions (census tables often start at governorate level), or try other filters.",
					);
				}
				if (ds.end_year && ds.end_year < new Date().getFullYear() - 3) {
					warnings.push(`This dataset covers up to ${ds.end_year}; it is not current data.`);
				}
				return ok({
					dataset: { id: ds.id, name: ds.name },
					...(defaulted.length ? { defaults_applied: defaulted } : {}),
					...(plan.regions.length ? { regions: plan.regions.map(regionSummary) } : {}),
					series_count: series.length,
					series: series.filter((s) => s.observation_count > 0),
					warnings,
					retrieval: retrieval(res),
				});
			}),
	);

	// ---------------------------------------------------------------- list_regions
	server.registerTool(
		"list_regions",
		{
			title: "List Tunisian regions",
			description:
				"Official administrative divisions as used by INS: the country, 7 regions (Nord Est, ...), the 24 governorates (with ISO 3166-2 codes and " +
				"Arabic names), 264 delegations and 2,000+ sectors (imadas). Use it to get region keys, or to list the delegations of a governorate. " +
				"Note: INS keys are not ISO numbers (Sfax is INS 34 / ISO TN-61; INS 61 is Gafsa).",
			inputSchema: z.object({
				level: z.enum(["country", "region", "governorate", "delegation", "sector"]).default("governorate"),
				within: z.string().optional().describe("Only list divisions inside this region (name, key or ISO code), e.g. 'Sfax' to get its delegations."),
				query: z.string().optional().describe("Optional name filter."),
			}),
			annotations: OFFLINE,
		},
		async ({ level, within, query }) => {
			let parent: RegionEntry | undefined;
			if (within) {
				const p = lookupRegion(within);
				if (isResult(p)) return p;
				parent = p;
			}
			const q = query ? normalize(query) : "";
			const regions = catalog.regions
				.filter((r) => r.level === (level as RegionLevel))
				.filter((r) => !parent || isInside(r, parent.key))
				.filter((r) => !q || normalize(r.name).includes(q));
			const LIMIT = 300;
			return ok({
				level,
				...(parent ? { within: regionSummary(parent) } : {}),
				count: regions.length,
				...(regions.length > LIMIT ? { truncated_to: LIMIT, hint: "Use 'within' or 'query' to narrow the list." } : {}),
				regions: regions.slice(0, LIMIT).map(regionSummary),
			});
		},
	);

}
