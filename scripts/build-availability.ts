// Builds src/data/availability.json: for every C_NSO indicator, does INS
// actually publish values, at which levels, with which frequency, and up to
// when? This lets search rank indicators that have data above empty
// categories, and lets tools say "national only" without a network call.
//
// INS accepts many indicators per GetData call, so we probe in batches of 50
// (larger batches make the server drop the connection) against the national
// level plus a few sample governorates and delegations. ~140 sequential
// requests with a pause between them, about 15 minutes. Batches are cached
// in .cache/availability/ so an interrupted run resumes where it stopped.
//
// Usage: npx tsx scripts/build-availability.ts

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Availability, AvailabilityEntry, Catalog } from "../src/catalog-types";
import { parseGetData, type RawObservation } from "../src/ins/parse";
import { readCache, writeCache } from "./cache";

const BASE = "http://dataportal.ins.tn/WebApi/GetData";
const BATCH = 50;
const PAUSE_MS = 1000;
const CACHE_DIR = ".cache/availability";

// National, four governorates from different regions, two delegations.
const NATIONAL = 0;
const GOVERNORATES = [11, 34, 42, 51]; // Tunis, Sfax, Kasserine, Gabès
const DELEGATIONS = [1151, 3451]; // Carthage, Sfax Ville
const PROBED = [NATIONAL, ...GOVERNORATES, ...DELEGATIONS];

const FREQ_CODE: Record<RawObservation["frequency"], string> = {
	annual: "A",
	monthly: "M",
	quarterly: "Q",
	"half-yearly": "H",
	daily: "D",
};

const catalog: Catalog = JSON.parse(readFileSync("src/data/catalog.json", "utf8"));

async function fetchBatch(keys: number[], attempt = 0): Promise<RawObservation[]> {
	const body =
		`<QueryMessage SourceId='C_NSO'><DataWhere>` +
		`<Dimension Id='RDS_DICT_INDICATORS_NSO'>${keys.map((k) => `<Element>${k}</Element>`).join("")}</Dimension>` +
		`<Dimension Id='RDS_DICT_REGIONS_NSO'>${PROBED.map((k) => `<Element>${k}</Element>`).join("")}</Dimension>` +
		`</DataWhere></QueryMessage>`;
	try {
		const res = await fetch(BASE, {
			method: "POST",
			headers: { "Content-Type": "text/xml; charset=UTF-8" },
			body,
			signal: AbortSignal.timeout(90_000),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return parseGetData(await res.text());
	} catch (e) {
		if (attempt >= 3) throw e;
		const wait = 5000 * (attempt + 1);
		console.warn(`  retry in ${wait / 1000}s (${(e as Error).message})`);
		await new Promise((r) => setTimeout(r, wait));
		return fetchBatch(keys, attempt + 1);
	}
}

function summarize(keys: number[], obs: RawObservation[]): Record<number, AvailabilityEntry> {
	const out: Record<number, AvailabilityEntry> = {};
	for (const key of keys) {
		const mine = obs.filter((o) => Number(o.dims.RDS_DICT_INDICATORS_NSO) === key);
		if (mine.length === 0) continue; // absent = no data anywhere we probed
		const nat = mine.filter((o) => Number(o.dims.RDS_DICT_REGIONS_NSO) === NATIONAL);
		const base = nat.length ? nat : mine;
		const periods = base.map((o) => o.period).sort();
		const regionsWith = new Set(mine.map((o) => Number(o.dims.RDS_DICT_REGIONS_NSO)));
		out[key] = {
			f: [...new Set(base.map((o) => FREQ_CODE[o.frequency]))].join(""),
			first: periods[0],
			last: periods.at(-1)!,
			nat: nat.length > 0,
			gov: GOVERNORATES.filter((g) => regionsWith.has(g)).length,
			del: DELEGATIONS.some((d) => regionsWith.has(d)),
		};
	}
	return out;
}

async function main() {
	const keys = catalog.indicators.map((i) => i.key);
	const batches = Math.ceil(keys.length / BATCH);
	const all: Record<number, AvailabilityEntry> = {};
	for (let b = 0; b < batches; b++) {
		const file = join(CACHE_DIR, `batch-${b}.json`);
		const slice = keys.slice(b * BATCH, (b + 1) * BATCH);
		let part: Record<number, AvailabilityEntry>;
		const cached = readCache(file);
		if (cached) {
			part = JSON.parse(cached);
		} else {
			const t = Date.now();
			part = summarize(slice, await fetchBatch(slice));
			writeCache(file, JSON.stringify(part));
			console.log(`batch ${b + 1}/${batches}: ${Object.keys(part).length}/${slice.length} with data (${Date.now() - t} ms)`);
			await new Promise((r) => setTimeout(r, PAUSE_MS));
		}
		Object.assign(all, part);
	}
	const result: Availability = {
		built_at: new Date().toISOString(),
		probed: { national: NATIONAL, governorates: GOVERNORATES, delegations: DELEGATIONS },
		indicators: all,
	};
	writeFileSync("src/data/availability.json", JSON.stringify(result));
	const vals = Object.values(all);
	console.log(
		`availability.json: ${vals.length}/${keys.length} indicators have data; ` +
			`${vals.filter((v) => v.gov > 0).length} with governorate data, ${vals.filter((v) => v.del).length} with delegation data`,
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
