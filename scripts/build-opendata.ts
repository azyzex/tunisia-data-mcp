// Builds src/data/opendata.json: a searchable snapshot of the national open
// data portal catalog (catalog.data.gov.tn, CKAN 2.9).
//
// Why a snapshot: searching ~3,000 datasets locally is instant and keeps
// working when the portal is down; the catalog changes slowly. Only actual
// files (previews) are downloaded live. (Note: curl on Windows makes this API
// look very slow because of certificate revocation checks; with Node it
// answers in ~1-2 s.)
//
// TLS quirk: catalog.data.gov.tn serves the wrong intermediate certificate,
// so strict clients (Node, and likely Workers) reject it. We ship the missing
// Sectigo intermediate in certs/ and re-launch Node with it trusted.
//
// Usage: npx tsx scripts/build-opendata.ts

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

if (!process.env.NODE_EXTRA_CA_CERTS) {
	const r = spawnSync(process.execPath, process.execArgv.concat(process.argv.slice(1)), {
		stdio: "inherit",
		env: { ...process.env, NODE_EXTRA_CA_CERTS: resolve("certs/sectigo-dv-r36.pem") },
	});
	process.exit(r.status ?? 1);
}
import type { OpenDataset, OpenDataSnapshot } from "../src/catalog-types";
import { readCache, writeCache } from "./cache";

const API = "https://catalog.data.gov.tn/fr/api/3/action/package_search";
const PAGE = 500;
const CACHE_DIR = ".cache/opendata";

async function fetchPage(start: number, attempt = 0): Promise<any> {
	const file = join(CACHE_DIR, `page-${start}.json`);
	const cached = readCache(file);
	if (cached) return JSON.parse(cached);
	try {
		const t = Date.now();
		const res = await fetch(`${API}?q=&rows=${PAGE}&start=${start}&sort=metadata_modified%20desc`, {
			signal: AbortSignal.timeout(300_000),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const json = (await res.json()) as any;
		if (!json.success) throw new Error("CKAN success=false");
		writeCache(file, JSON.stringify(json.result));
		console.log(`page start=${start}: ${json.result.results.length} datasets (${Date.now() - t} ms)`);
		return json.result;
	} catch (e) {
		if (attempt >= 3) throw e;
		console.warn(`  retry (${(e as Error).message})`);
		await new Promise((r) => setTimeout(r, 10_000 * (attempt + 1)));
		return fetchPage(start, attempt + 1);
	}
}

const clip = (s: unknown, n: number) => {
	const t = String(s ?? "")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function compact(p: any): OpenDataset {
	return {
		id: p.name,
		title: clip(p.title, 200),
		...(p.notes && clip(p.notes, 400) !== clip(p.title, 200) ? { notes: clip(p.notes, 400) } : {}),
		org: p.organization?.title ?? null,
		tags: (p.tags ?? []).map((t: any) => t.display_name ?? t.name).slice(0, 10),
		modified: String(p.metadata_modified ?? "").slice(0, 10),
		...(p.temporal_startDate || p.temporal_endDate ? { period: `${p.temporal_startDate || "?"}..${p.temporal_endDate || "?"}` } : {}),
		...(p.spatial_geoName ? { place: p.spatial_geoName } : {}),
		license: p.license_title ?? null,
		resources: (p.resources ?? []).slice(0, 8).map((r: any) => ({
			id: r.id,
			name: clip(r.name || r.description || r.format, 120),
			format: String(r.format ?? "").toUpperCase(),
			url: r.url,
			datastore: !!r.datastore_active,
		})),
	};
}

async function main() {
	const first = await fetchPage(0);
	const total: number = first.count;
	const all = [...first.results];
	for (let start = PAGE; start < total; start += PAGE) {
		all.push(...(await fetchPage(start)).results);
	}
	const snapshot: OpenDataSnapshot = {
		built_at: new Date().toISOString(),
		total_on_portal: total,
		datasets: all.filter((p) => p.state === "active" && !p.private).map(compact),
	};
	writeFileSync("src/data/opendata.json", JSON.stringify(snapshot));
	console.log(`opendata.json: ${snapshot.datasets.length} datasets, ${(JSON.stringify(snapshot).length / 1024).toFixed(0)} KB`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
