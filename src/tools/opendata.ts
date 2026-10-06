// Tools over the national open data portal (catalog.data.gov.tn).

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { datasetsBySlug, openData, openDatasetSummary, PORTAL_URL, previewability, previewResource, searchOpenData } from "../opendata";
import { fail, guarded, ok, OFFLINE, READ_ONLY } from "./common";

const ATTRIBUTION = "Portail national des données ouvertes — data.gov.tn";

export function registerOpenDataTools(server: McpServer, fetchImpl: typeof fetch) {
	server.registerTool(
		"search_open_data",
		{
			title: "Search data.gov.tn",
			description:
				"Search Tunisia's national open data portal (data.gov.tn, ~2,900 datasets from ministries, municipalities and public bodies): agriculture, " +
				"municipal budgets, transport, culture, education, weather stations, health facilities, etc. Complements INS statistics with administrative " +
				"and local data. French or English keywords. Returns dataset ids and their files; use preview_open_data to read a file.",
			inputSchema: z.object({
				query: z.string().min(2).describe("Keywords, e.g. 'budget commune', 'pharmacies', 'olive', 'écoles Sfax'."),
				organization: z.string().optional().describe("Filter by publisher, e.g. 'agriculture', 'commune de Sousse', 'transport'."),
				format: z.string().optional().describe("Only datasets with a file in this format: CSV, XLSX, JSON, GEOJSON, PDF..."),
				limit: z.number().int().min(1).max(30).default(10),
			}),
			annotations: OFFLINE,
		},
		async ({ query, organization, format, limit }) => {
			const { total, hits } = searchOpenData(query, { limit, organization, format });
			return ok({
				total,
				showing: hits.length,
				results: hits.map(openDatasetSummary),
				snapshot: { built_at: openData.built_at, note: "Search runs on a snapshot of the portal catalog; newer datasets may be missing." },
				attribution: ATTRIBUTION,
				...(total === 0 ? { hint: "Try French keywords or broader words. For official statistics (population, prices, employment), use search_indicators." } : {}),
			});
		},
	);

	server.registerTool(
		"preview_open_data",
		{
			title: "Preview a data.gov.tn file",
			description:
				"Download a CSV, XLSX, JSON or GeoJSON file from a data.gov.tn dataset and return its columns and first rows (up to 3 MB read). " +
				"Pass the dataset id (first previewable file is used) or a specific resource id from search_open_data.",
			inputSchema: z.object({
				dataset: z.string().describe("Dataset id from search_open_data."),
				resource_id: z.string().optional().describe("A specific file of that dataset; default: first CSV/XLSX/JSON/GeoJSON file."),
				max_rows: z.number().int().min(1).max(200).default(30),
			}),
			annotations: READ_ONLY,
		},
		async ({ dataset, resource_id, max_rows }) =>
			guarded(async () => {
				const ds = datasetsBySlug.get(dataset.trim());
				if (!ds) return fail(`Unknown dataset id "${dataset}". Use search_open_data to find ids.`);
				const res = resource_id ? ds.resources.find((r) => r.id === resource_id) : ds.resources.find((r) => previewability(r).previewable);
				const files = ds.resources.map((r) => ({ id: r.id, name: r.name, format: r.format, url: r.url, ...previewability(r) }));
				if (!res) {
					return fail(
						resource_id ? `Dataset ${dataset} has no resource ${resource_id}.` : "None of this dataset's files can be previewed; share the links below with the user.",
						{ resources: files, dataset_url: PORTAL_URL + ds.id },
					);
				}
				const check = previewability(res);
				if (!check.previewable) {
					return fail(`This file cannot be previewed: ${check.reason}.`, { download_url: res.url, dataset_url: PORTAL_URL + ds.id, resources: files });
				}
				const preview = await previewResource(res.url, res.format, max_rows, fetchImpl);
				return ok({
					dataset: { id: ds.id, title: ds.title, organization: ds.org, last_modified: ds.modified, url: PORTAL_URL + ds.id },
					resource: { id: res.id, name: res.name, format: res.format, download_url: res.url },
					preview,
					warnings: [
						"Only a preview: rows beyond max_rows are not shown. Files are published as-is by each administration; check units and dates in the columns.",
						...(Number(ds.modified.slice(0, 4)) <= new Date().getFullYear() - 3 ? [`Dataset metadata last modified ${ds.modified}; data may be old.`] : []),
					],
					attribution: ATTRIBUTION,
				});
			}),
	);
}
