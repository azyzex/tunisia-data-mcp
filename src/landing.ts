// Public website served by the Worker: landing page (with a live tile map of
// the 24 governorates), privacy policy and icon.

export interface MapDatum {
	key: number;
	name: string; // short French name, e.g. "Sfax"
	ar: string;
	iso: string;
	value: number;
}

export interface MapData {
	title: string; // what the colours show
	unit: string;
	period: string;
	national: number | null;
	data: MapDatum[];
}

export const REPO_URL = "https://github.com/azyzex/tunisia-data-mcp";

// Tile cartogram of Tunisia: [column, row] per INS governorate key. North at
// the top, the coast on the right; every governorate gets the same area.
const GRID: Record<number, [number, number]> = {
	22: [0, 0], 17: [1, 0], 12: [2, 0], 11: [3, 0],
	21: [0, 1], 14: [1, 1], 13: [2, 1], 15: [3, 1],
	23: [0, 2], 24: [1, 2], 16: [2, 2], 31: [3, 2],
	42: [0, 3], 41: [1, 3], 32: [2, 3], 33: [3, 3],
	61: [0, 4], 43: [1, 4], 34: [2, 4],
	62: [0, 5], 63: [1, 5], 51: [2, 5], 52: [3, 5],
	53: [3, 6],
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 1 });

const FONTS =
	'<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
	'<link href="https://fonts.googleapis.com/css2?family=Readex+Pro:wght@300;400;500;700&display=swap" rel="stylesheet">';

const BASE_CSS = `
:root{
	--paper:#F6F8F9; --ink:#14212E; --muted:#56657A; --rule:#D9E0E7;
	--b1:#E2EDF6; --b2:#B6D1E8; --b3:#79A9D2; --b4:#3B7DB8; --b5:#174F86;
	--red:#E70013; --field:#FFFFFF; --focus:#174F86;
}
@media (prefers-color-scheme: dark){
	:root{ --paper:#0F1923; --ink:#E7EDF3; --muted:#9AA8B8; --rule:#24313F;
	--b1:#1B2D40; --b2:#20456B; --b3:#2F6798; --b4:#4F8DC5; --b5:#8DBDE6; --field:#152230; --focus:#8DBDE6; }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:400 17px/1.6 "Readex Pro",system-ui,sans-serif;font-feature-settings:"tnum" 1}
a{color:inherit;text-decoration-color:var(--b3);text-underline-offset:3px}
a:hover{text-decoration-color:currentColor}
:focus-visible{outline:2px solid var(--focus);outline-offset:3px;border-radius:2px}
.wrap{max-width:1120px;margin:0 auto;padding:0 24px}
@media (max-width:600px){.wrap{padding:0 16px}}
`;

function tileMap(map: MapData | null): string {
	if (!map || map.data.length < 20) {
		return `<figure class="map map-empty"><p>The live map could not load figures from INS right now. The connector itself still works; try again in a few minutes.</p></figure>`;
	}
	const sorted = [...map.data].sort((a, b) => a.value - b.value);
	// Quintile classes so the colours read as "lowest fifth ... highest fifth".
	const cls = new Map(sorted.map((d, i) => [d.key, 1 + Math.floor((i / sorted.length) * 5)]));
	const rank = new Map([...sorted].reverse().map((d, i) => [d.key, i + 1]));
	const tiles = map.data
		.filter((d) => GRID[d.key])
		.map((d) => {
			const [c, r] = GRID[d.key];
			return `<button class="tile c${cls.get(d.key)}" style="grid-column:${c + 1};grid-row:${r + 1}" data-name="${esc(d.name)}" data-ar="${esc(d.ar)}" data-iso="${d.iso}" data-value="${d.value}" data-rank="${rank.get(d.key)}" aria-label="${esc(d.name)}: ${fmt(d.value)}, rank ${rank.get(d.key)} of ${map.data.length}"><span>${esc(d.name)}</span></button>`;
		})
		.join("");
	const hi = sorted.at(-1)!;
	const lo = sorted[0];
	const rows = [...sorted]
		.reverse()
		.map((d) => `<tr><td>${rank.get(d.key)}</td><td>${esc(d.name)} <span lang="ar">${esc(d.ar)}</span></td><td>${fmt(d.value)}</td></tr>`)
		.join("");
	return `<figure class="map">
	<div class="grid" role="group" aria-label="${esc(map.title)} by governorate">${tiles}</div>
	<figcaption>
		<p class="readout" aria-live="polite"><strong>${esc(hi.name)}</strong> has ${fmt(hi.value)} ${esc(map.unit)}, <strong>${esc(lo.name)}</strong> ${fmt(lo.value)}. Select a governorate to compare it with the national figure${map.national !== null ? ` of ${fmt(map.national)}` : ""}.</p>
		<div class="legend" aria-hidden="true"><span>Fewer</span><i class="c1"></i><i class="c2"></i><i class="c3"></i><i class="c4"></i><i class="c5"></i><span>More</span></div>
		<p class="source">${esc(map.title)}, ${esc(map.period)}. Source: INS, computed live by this connector.</p>
		<details><summary>All 24 values</summary><table><thead><tr><th>Rank</th><th>Governorate</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table></details>
	</figcaption>
</figure>`;
}

export function landingPage(mcpUrl: string, map: MapData | null): string {
	const examples: [string, string][] = [
		["Give me a profile of Kasserine and how it ranks among the governorates.", "region_profile"],
		["How has inflation moved over the last twelve months?", "get_series"],
		["Which governorates have the fewest doctors per inhabitant?", "compare_regions"],
		["What did the 2014 census say about rural unemployment in Sidi Bouzid?", "query_dataset"],
		["Is there open data on the pharmacies on duty this weekend?", "search_open_data"],
		["ما هو عدد سكان صفاقس؟", "get_series"],
	];
	const exampleList = examples
		.map(([q, tool]) => `<li><q${/[؀-ۿ]/.test(q) ? ' lang="ar" dir="rtl"' : ""}>${esc(q)}</q><span class="tool">${tool}</span></li>`)
		.join("");

	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tunisia Data for Claude</title>
<meta name="description" content="A free connector that lets Claude answer questions with Tunisia's official statistics (INS) and open data (data.gov.tn), with sources and dates.">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
${FONTS}
<style>${BASE_CSS}
header.top{display:flex;justify-content:space-between;align-items:center;padding:20px 0;font-size:15px}
header.top .brand{display:flex;gap:10px;align-items:center;font-weight:500;text-decoration:none}
header.top nav{display:flex;gap:20px}
.hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,440px);gap:56px;align-items:start;padding:40px 0 72px}
@media (max-width:900px){.hero{grid-template-columns:1fr;gap:40px;padding-top:16px}}
h1{font-weight:700;font-size:clamp(40px,6vw,68px);line-height:1.02;letter-spacing:-0.025em;margin:0 0 24px;max-width:12ch}
.lead{font-size:20px;line-height:1.55;color:var(--muted);max-width:34em;margin:0 0 32px;font-weight:300}
.connect{max-width:520px}
.connect label{display:block;font-weight:500;margin-bottom:8px}
.copy{display:flex;border:1px solid var(--rule);background:var(--field);border-radius:10px;overflow:hidden}
.copy input{flex:1;min-width:0;border:0;background:transparent;color:var(--ink);font:inherit;font-size:15px;padding:12px 14px}
.copy button{border:0;border-left:1px solid var(--rule);background:var(--b5);color:var(--paper);font:inherit;font-weight:500;padding:0 18px;cursor:pointer}
.connect p{font-size:15px;color:var(--muted);margin:10px 0 0}
.map{margin:0}
.grid{display:grid;grid-template-columns:repeat(4,1fr);grid-template-rows:repeat(7,auto);gap:6px;max-width:440px}
.tile{aspect-ratio:1.35;border:0;border-radius:6px;font:inherit;font-size:12px;line-height:1.15;padding:6px;text-align:left;display:flex;align-items:flex-end;cursor:pointer;color:var(--ink);transition:transform .15s ease, box-shadow .15s ease}
.tile span{overflow:hidden;text-overflow:ellipsis}
.tile.c1,.legend .c1{background:var(--b1)} .tile.c2,.legend .c2{background:var(--b2)} .tile.c3,.legend .c3{background:var(--b3)}
.tile.c4,.legend .c4{background:var(--b4)} .tile.c5,.legend .c5{background:var(--b5)}
.tile.c4,.tile.c5{color:var(--paper)}
@media (prefers-color-scheme: dark){.tile.c4,.tile.c5{color:#0F1923}.tile.c1,.tile.c2,.tile.c3{color:var(--ink)}}
.tile[aria-pressed="true"]{box-shadow:inset 0 0 0 3px var(--red);transform:scale(1.04)}
@media (prefers-reduced-motion:reduce){.tile{transition:none}}
figcaption{max-width:440px;margin-top:16px;font-size:15px}
.readout{margin:0 0 12px;min-height:3.2em}
.legend{display:flex;align-items:center;gap:4px;font-size:13px;color:var(--muted)}
.legend i{width:28px;height:10px;border-radius:2px}
.legend span:first-child{margin-right:6px}.legend span:last-child{margin-left:6px}
.source{color:var(--muted);font-size:13px;margin:10px 0}
details{font-size:14px}summary{cursor:pointer;color:var(--muted)}
table{border-collapse:collapse;margin-top:8px;width:100%}
td,th{text-align:left;padding:4px 8px 4px 0;border-bottom:1px solid var(--rule);font-weight:400}
th{color:var(--muted)} td:last-child,th:last-child{text-align:right}
.map-empty{border:1px dashed var(--rule);border-radius:10px;padding:24px;color:var(--muted);max-width:440px}
section{padding:56px 0;border-top:1px solid var(--rule)}
h2{font-size:28px;font-weight:500;letter-spacing:-0.01em;margin:0 0 24px}
.cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:56px}
@media (max-width:800px){.cols{grid-template-columns:1fr;gap:32px}}
ul.asks{list-style:none;margin:0;padding:0;max-width:760px}
ul.asks li{display:flex;justify-content:space-between;gap:24px;padding:14px 0;border-bottom:1px solid var(--rule);align-items:baseline}
ul.asks q{quotes:none;font-size:19px;font-weight:300}
ul.asks .tool{font-size:13px;color:var(--muted);white-space:nowrap}
@media (max-width:600px){ul.asks li{flex-direction:column;gap:2px}}
ol.steps{margin:0;padding-left:1.4em}ol.steps li{margin-bottom:10px;padding-left:4px}
.prose p{max-width:36em;margin:0 0 16px}
.prose ul{padding-left:1.2em;margin:0}.prose li{margin-bottom:8px}
footer{padding:40px 0 56px;border-top:1px solid var(--rule);font-size:14px;color:var(--muted);display:flex;flex-wrap:wrap;gap:12px 28px}
[lang="ar"]{font-family:"Readex Pro",system-ui,sans-serif}
</style></head><body>
<div class="wrap">
<header class="top">
	<a class="brand" href="/"><img src="/icon.svg" width="28" height="28" alt="">Tunisia Data</a>
	<nav><a href="#connect">Connect</a><a href="${REPO_URL}">Source code</a></nav>
</header>

<main>
<div class="hero">
	<div>
		<h1>Tunisia's official numbers, in your Claude chats</h1>
		<p class="lead">Ask Claude about population, prices, jobs, health or any of the 24 governorates. It answers with the figures published by the Institut National de la Statistique and data.gov.tn, and tells you which year they are from.</p>
		<div class="connect" id="connect-box">
			<label for="mcp-url">Connector address</label>
			<div class="copy"><input id="mcp-url" readonly value="${esc(mcpUrl)}"><button type="button" id="copy-btn">Copy</button></div>
			<p>Free, read-only, no account needed. In English, French or Arabic.</p>
		</div>
	</div>
	${tileMap(map)}
</div>

<section>
	<h2>Things you can ask</h2>
	<ul class="asks">${exampleList}</ul>
</section>

<section id="connect">
	<div class="cols">
		<div>
			<h2>Add it to Claude</h2>
			<ol class="steps">
				<li>Open Claude and go to <b>Settings</b>, then <b>Connectors</b>.</li>
				<li>Choose <b>Add custom connector</b>.</li>
				<li>Name it "Tunisia Data" and paste the connector address above.</li>
				<li>Start a new chat and ask a question about Tunisia.</li>
			</ol>
		</div>
		<div class="prose">
			<h2>Where the numbers come from</h2>
			<p>About 7,000 indicators from the INS data portal, 77 thematic tables including the 2014 census, and around 2,900 datasets from ministries and municipalities on data.gov.tn.</p>
			<ul>
				<li>Every figure comes with its period. Old data is flagged, not passed off as current.</li>
				<li>Missing years stay missing. Nothing is estimated or filled in.</li>
				<li>Coverage varies: some topics stop years ago, and many exist only at national level.</li>
			</ul>
		</div>
	</div>
</section>
</main>

<footer>
	<span>Not affiliated with INS or data.gov.tn. Data belongs to its publishers.</span>
	<a href="/privacy">Privacy</a>
	<a href="${REPO_URL}">GitHub</a>
	<a href="${REPO_URL}/issues">Report a problem</a>
	<a href="/health">Status</a>
</footer>
</div>
<script>
(function(){
	var btn=document.getElementById('copy-btn'),input=document.getElementById('mcp-url');
	btn.addEventListener('click',function(){
		var done=function(){btn.textContent='Copied';setTimeout(function(){btn.textContent='Copy'},1800)};
		if(navigator.clipboard){navigator.clipboard.writeText(input.value).then(done,function(){input.select()})}else{input.select();document.execCommand('copy');done()}
	});
	var readout=document.querySelector('.readout');if(!readout)return;
	var unit=${JSON.stringify(map?.unit ?? "")},national=${JSON.stringify(map?.national ?? null)};
	var tiles=document.querySelectorAll('.tile');
	tiles.forEach(function(t){t.addEventListener('click',function(){
		tiles.forEach(function(o){o.setAttribute('aria-pressed','false')});t.setAttribute('aria-pressed','true');
		var v=Number(t.dataset.value),cmp='';
		if(national){var d=Math.round((v/national-1)*100);cmp=d===0?', the same as the national figure':', '+Math.abs(d)+'% '+(d>0?'above':'below')+' the national '+national.toLocaleString('en-US',{maximumFractionDigits:1})}
		readout.innerHTML='<strong></strong> <span lang="ar"></span>: '+v.toLocaleString('en-US',{maximumFractionDigits:1})+' '+unit+cmp+'. Rank '+t.dataset.rank+' of '+tiles.length+'.';
		readout.querySelector('strong').textContent=t.dataset.name;readout.querySelector('[lang=ar]').textContent=t.dataset.ar;
	})});
})();
</script>
</body></html>`;
}

export function privacyPage(): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Privacy policy · Tunisia Data</title><link rel="icon" href="/icon.svg" type="image/svg+xml">${FONTS}
<style>${BASE_CSS}
main{max-width:680px;padding:48px 0 72px}h1{font-size:40px;font-weight:700;letter-spacing:-0.02em;margin:0 0 8px}
h2{font-size:21px;font-weight:500;margin:36px 0 8px}p,li{max-width:36em}.muted{color:var(--muted)}
</style></head><body><div class="wrap"><main>
<p><a href="/">Tunisia Data</a></p>
<h1>Privacy policy</h1>
<p class="muted">Last updated 7 October 2026</p>

<h2>What this service is</h2>
<p>Tunisia Data is a free, read-only connector (an MCP server) that lets AI assistants such as Claude look up public statistics from the Institut National de la Statistique (INS) and public datasets from data.gov.tn. It has no user accounts and no login.</p>

<h2>Data collected</h2>
<p>The connector receives the tool requests your assistant sends it, such as "population of Sfax since 2020". These requests contain search words, region names and indicator numbers. It does not receive your name, email, account details or your conversation with the assistant. Do not put personal information in questions meant for this connector.</p>

<h2>How data is used and stored</h2>
<ul>
<li>Requests are used only to fetch and return the public data you asked for.</li>
<li>Answers from INS are cached for up to 7 days to reduce load on the INS server. The cache contains only public statistics, never information about who asked.</li>
<li>The hosting provider, Cloudflare, keeps technical logs (time, request path, errors, IP address) for operating and securing the service, under <a href="https://www.cloudflare.com/privacypolicy/">Cloudflare's privacy policy</a>. These logs are kept for a few days and are only used to fix errors.</li>
</ul>

<h2>Sharing with third parties</h2>
<p>To answer a request, the connector contacts dataportal.ins.tn or the website hosting a data.gov.tn file. Those requests come from Cloudflare's servers and contain only the statistical query, not your identity. No data is sold or shared for advertising.</p>

<h2>Retention</h2>
<p>Cached public data expires after 7 days. Cloudflare logs follow Cloudflare's retention periods. Nothing else is stored.</p>

<h2>Contact</h2>
<p>Questions or problems: open an issue at <a href="${REPO_URL}/issues">${REPO_URL}/issues</a>.</p>
</main></div></body></html>`;
}

/** Icon: a square of Sidi Bou Said blue holding the tile cartogram in miniature. */
export function iconSvg(): string {
	const cells = Object.values(GRID)
		.map(([c, r]) => `<rect x="${17 + c * 8}" y="${6 + r * 7.6}" width="6.6" height="6.2" rx="1.2" fill="${c === 3 && r === 0 ? "#E70013" : "#FFFFFF"}"/>`)
		.join("");
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#174F86"/>${cells}</svg>`;
}
