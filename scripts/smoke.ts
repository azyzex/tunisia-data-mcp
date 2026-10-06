export {};

// End-to-end smoke test against a running server (wrangler dev or deployed).
//   npx tsx scripts/smoke.ts [http://localhost:8787/mcp]
// Calls every tool and prompt over real MCP JSON-RPC, prints a short summary
// per call and exits non-zero if any check fails.

const URL_ = process.argv[2] ?? "http://localhost:8787/mcp";
let id = 0;
let failures = 0;

async function rpc(method: string, params: unknown = {}) {
	const res = await fetch(URL_, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": "2025-06-18",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
	});
	const text = await res.text();
	// Responses may be plain JSON or a single SSE "data:" event.
	const json = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))?.slice(5);
	if (!res.ok || !json) throw new Error(`${method}: HTTP ${res.status} ${text.slice(0, 300)}`);
	const msg = JSON.parse(json);
	if (msg.error) throw new Error(`${method}: ${JSON.stringify(msg.error)}`);
	return msg.result;
}

async function call(name: string, args: Record<string, unknown>, check: (d: any) => string | true) {
	const t = Date.now();
	let line = `${name} ${JSON.stringify(args)}`;
	try {
		const r = await rpc("tools/call", { name, arguments: args });
		const data = JSON.parse(r.content[0].text);
		const verdict = check(data);
		line += ` — ${Date.now() - t} ms${r.isError ? " (isError)" : ""}`;
		if (verdict === true) console.log(`  ok   ${line}`);
		else {
			failures++;
			console.log(`  FAIL ${line}\n       ${verdict}\n       ${JSON.stringify(data).slice(0, 400)}`);
		}
		return data;
	} catch (e) {
		failures++;
		console.log(`  FAIL ${line}\n       ${(e as Error).message}`);
		return null;
	}
}

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
console.log("server:", init.serverInfo.name, init.serverInfo.version);
const tools = (await rpc("tools/list")).tools.map((t: { name: string }) => t.name);
console.log("tools:", tools.join(", "));
const prompts = (await rpc("prompts/list")).prompts.map((p: { name: string }) => p.name);
console.log("prompts:", prompts.join(", "));

console.log("\nINS indicators");
await call("search_indicators", { query: "unemployment women", limit: 3 }, (d) => (d.results?.length ? true : "no results"));
await call("search_indicators", { query: "médecins", level: "governorate", limit: 3 }, (d) => (d.results?.[0]?.availability?.levels?.includes("governorate") ? true : "no governorate-level result"));
await call("get_indicator", { indicator_key: 28270769 }, (d) => (d.sub_indicators?.length ? true : "no sub-indicators"));
await call("get_series", { indicator_key: 27545539, from_year: 2000, to_year: 2012 }, (d) =>
	d.series?.[0]?.missing_periods?.join() === "2005,2008,2009" ? true : "gaps not reported",
);
await call("get_series", { indicator_key: 28228379, from_year: 2025 }, (d) => (d.series?.[0]?.summary?.pct_change_year_on_year != null ? true : "no YoY"));
await call("get_series", { indicator_key: 11922316, regions: ["Tunis", "صفاقس", "TN-42"], from_year: 2020 }, (d) =>
	d.series?.length === 3 ? true : `expected 3 series, got ${d.series?.length}`,
);
await call("compare_regions", { indicator_key: 22300416 }, (d) => (d.ranking?.length >= 20 ? true : "ranking too short"));
await call("compare_regions", { indicator_key: 40008000, level: "region" }, (d) => (d.ranking?.length >= 6 ? true : "region ranking too short"));
await call("region_profile", { region: "Kasserine" }, (d) => (d.figures?.filter((f: any) => f.value !== null).length >= 10 && d.per_capita?.length ? true : "profile incomplete"));
await call("region_profile", { region: "Tunisie" }, (d) => (d.figures?.[0]?.value > 10_000_000 ? true : "national population missing"));

console.log("\nINS datasets");
await call("list_datasets", { query: "projection" }, (d) => (d.count >= 1 ? true : "no dataset"));
await call("describe_dataset", { dataset: "OBJ6958089" }, (d) => (d.dimensions?.length === 3 ? true : "dimensions missing"));
await call("query_dataset", { dataset: "OBJ6943049", filters: { Genre: ["*"] }, regions: ["Tunisie"], from_year: 2030, to_year: 2034 }, (d) =>
	d.series?.length === 3 ? true : `expected 3 series, got ${d.series?.length}`,
);
await call("query_dataset", { dataset: "OBJ6958089", filters: { Indicateurs: ["Taux de chômage"], Sexe: ["*"] }, regions: ["Kasserine"] }, (d) =>
	d.series?.length ? true : "no census series",
);
await call("list_regions", { level: "delegation", within: "Sfax" }, (d) => (d.count === 16 ? true : `expected 16, got ${d.count}`));

console.log("\ndata.gov.tn");
const od = await call("search_open_data", { query: "pharmacies de garde", limit: 3 }, (d) => (d.total > 0 ? true : "no results"));
const csvDs = await call("search_open_data", { query: "station climatique", format: "CSV", limit: 1 }, (d) => (d.total > 0 ? true : "no CSV dataset"));
if (csvDs?.results?.[0]) {
	await call("preview_open_data", { dataset: csvDs.results[0].id, max_rows: 3 }, (d) => (d.preview?.rows?.length ? true : d.error ?? "no rows"));
}
const xlsxDs = await call("search_open_data", { query: "budget", format: "XLSX", limit: 1 }, (d) => (d.total > 0 ? true : "no XLSX dataset"));
if (xlsxDs?.results?.[0]) {
	await call("preview_open_data", { dataset: xlsxDs.results[0].id, max_rows: 3 }, (d) => (d.preview?.columns?.length ? true : d.error ?? "no columns"));
}
void od;

console.log("\nErrors are explained, not thrown");
await call("get_series", { indicator_key: 1 }, (d) => (d.error ? true : "expected error"));
await call("get_series", { indicator_key: 11922316, region: "Atlantis" }, (d) => (d.error ? true : "expected error"));
await call("query_dataset", { dataset: "OBJ6943049", filters: { Couleur: ["bleu"] } }, (d) => (d.error && d.dimensions ? true : "expected dimension list"));

const p = await rpc("prompts/get", { name: "governorate_report", arguments: { governorate: "Sfax" } });
console.log(`\nprompt governorate_report: ${p.messages[0].content.text.split("\n")[0]}`);

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
