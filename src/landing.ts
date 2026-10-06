// Minimal human-readable page at "/" so people who open the server URL in a
// browser learn what it is and how to connect it.

const TOOLS: [string, string][] = [
	["search_indicators", "Find among ~7,000 INS indicators (French or English keywords)"],
	["get_series", "Time series with gaps, units, summary figures and freshness warnings"],
	["compare_regions", "Rank the 24 governorates or 7 regions on an indicator"],
	["region_profile", "Key figures and ranks for one governorate"],
	["get_indicator", "Definition, methodology, sub-indicators, coverage"],
	["list_datasets / describe_dataset / query_dataset", "Census 2014 tables, projections 2014-2044, national accounts"],
	["list_regions", "Governorates (ISO codes, Arabic names), delegations, sectors"],
	["search_open_data / preview_open_data", "~2,900 datasets of data.gov.tn, with CSV/XLSX/JSON previews"],
];

export function landingPage(mcpUrl: string): string {
	const rows = TOOLS.map(([n, d]) => `<tr><td><code>${n}</code></td><td>${d}</td></tr>`).join("");
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tunisia Data MCP</title>
<style>
:root{--bg:#fff;--fg:#1d1d1f;--muted:#5f6368;--line:#e3e3e3;--accent:#c8102e;--code:#f4f4f5}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececec;--muted:#a0a0a6;--line:#2c2c30;--code:#202024}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:40px 16px}
h1{margin:0 0 4px;font-size:28px}h1 span{color:var(--accent)}
p.lead{color:var(--muted);margin:0 0 28px}
code{background:var(--code);padding:2px 6px;border-radius:4px;font-size:14px}
.url{display:block;padding:12px;border:1px solid var(--line);border-radius:8px;word-break:break-all;margin:8px 0 24px}
table{width:100%;border-collapse:collapse;font-size:15px}td{padding:8px 6px;border-top:1px solid var(--line);vertical-align:top}
small{color:var(--muted)}
</style></head><body><main>
<h1><span>■</span> Tunisia Data</h1>
<p class="lead">MCP connector for official Tunisian statistics (INS) and the national open data portal (data.gov.tn).</p>
<h2>Connect</h2>
<p>In Claude: <b>Settings → Connectors → Add custom connector</b>, then paste:</p>
<code class="url">${mcpUrl}</code>
<h2>Tools</h2>
<table>${rows}</table>
<p><small>Data © Institut National de la Statistique and the publishing administrations. Not affiliated with INS or data.gov.tn. Read-only, no account needed.
Status: <a href="/health">/health</a></small></p>
</main></body></html>`;
}
