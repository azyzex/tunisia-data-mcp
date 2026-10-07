// Worker entry point. Stateless Streamable HTTP MCP endpoint at /mcp:
// each request builds a fresh McpServer (cheap — the catalogs are loaded once
// per isolate), so no Durable Objects or sessions are needed. The same Worker
// serves the public website (/, /privacy, /icon.svg).

import { createMcpHandler } from "agents/mcp/server";
import { arabicName, availability, catalog, COUNTRY_KEY, governorates } from "./catalog";
import { InsClient } from "./ins/client";
import { iconSvg, landingPage, privacyPage, type MapData } from "./landing";
import { openData } from "./opendata";
import { createServer } from "./tools";
import { fetchObservations } from "./tools/indicators";

export interface Env {
	CACHE?: KVNamespace;
}

const DOCTORS = 22300416;
const POPULATION = 11922316;

/**
 * Data for the landing page map: doctors per 10,000 inhabitants by
 * governorate, computed live (KV-cached) from INS counts. Returns null rather
 * than failing the page when INS is unreachable.
 */
async function doctorsMap(client: InsClient): Promise<MapData | null> {
	try {
		const year = new Date().getFullYear();
		const { obs } = await fetchObservations(client, [DOCTORS, POPULATION], [COUNTRY_KEY, ...governorates.map((g) => g.key)], {
			from: year - 6,
			to: year,
			frequency: "Y",
		});
		const v = new Map(obs.map((o) => [`${o.dims.RDS_DICT_INDICATORS_NSO}:${o.dims.RDS_DICT_REGIONS_NSO}:${o.period}`, o.value]));
		const ratio = (region: number, p: string) => {
			const d = v.get(`${DOCTORS}:${region}:${p}`);
			const pop = v.get(`${POPULATION}:${region}:${p}`);
			return d !== undefined && pop ? Math.round((d / pop) * 100000) / 10 : null;
		};
		for (let y = year; y >= year - 6; y--) {
			const p = String(y);
			const data = governorates.flatMap((g) => {
				const value = ratio(g.key, p);
				return value === null ? [] : [{ key: g.key, name: g.name.replace(/^Gouvernorat (de |du |d')/, ""), ar: arabicName(g) ?? "", iso: g.iso!, value }];
			});
			if (data.length >= 20) {
				return { title: "Doctors per 10,000 inhabitants", unit: "doctors per 10,000 people", period: p, national: ratio(COUNTRY_KEY, p), data };
			}
		}
		return null;
	} catch {
		return null;
	}
}

const html = (body: string, cacheSeconds: number) =>
	new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": `public, max-age=${cacheSeconds}` } });

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const client = new InsClient(env.CACHE, fetch, (p) => ctx.waitUntil(p));

		switch (url.pathname) {
			case "/mcp":
				return createMcpHandler(() => createServer(client), { route: "/mcp" })(request, env, ctx);
			case "/":
				return html(landingPage(`${url.origin}/mcp`, await doctorsMap(client)), 3600);
			case "/privacy":
				return html(privacyPage(), 86400);
			case "/icon.svg":
				return new Response(iconSvg(), { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=604800" } });
			case "/health":
				return Response.json({
					name: "tunisia-data MCP server",
					mcp_endpoint: `${url.origin}/mcp`,
					sources: {
						ins: { url: "http://dataportal.ins.tn", catalog_snapshot: catalog.built_at, availability_snapshot: availability.built_at },
						open_data: { url: "https://data.gov.tn", catalog_snapshot: openData.built_at, datasets: openData.datasets.length },
					},
					cache: env.CACHE ? "kv" : "disabled",
				});
			default:
				return new Response("Not found", { status: 404 });
		}
	},
} satisfies ExportedHandler<Env>;
