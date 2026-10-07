# Tunisia Data — MCP connector for Tunisian statistics and open data

A remote [Model Context Protocol](https://modelcontextprotocol.io) server that gives Claude (and any MCP client) direct, sourced access to:

- **INS**, Tunisia's **Institut National de la Statistique** ([dataportal.ins.tn](http://dataportal.ins.tn)): ~7,000 socio-economic indicators (population, prices, employment, health, education, enterprises, transport, trade…), by governorate where available, plus 77 thematic tables (2014 census, population projections 2014–2044, national accounts).
- **data.gov.tn**, the national open data portal: ~2,900 datasets from ministries, municipalities and public bodies, with live previews of CSV, XLSX, JSON and GeoJSON files.

It runs on Cloudflare Workers' free tier, needs no API key, and is read-only. You can ask in English, French or Arabic.

**Website:** a landing page with a live map of doctors per inhabitant by governorate, the [privacy policy](https://tunisia-data-mcp.azizguenni0.workers.dev/privacy) and the status page at `/health`, all served by the same Worker.

**Live server:** `https://tunisia-data-mcp.azizguenni0.workers.dev/mcp`. In Claude, go to **Settings → Connectors → Add custom connector** and paste this URL. Landing page: [tunisia-data-mcp.azizguenni0.workers.dev](https://tunisia-data-mcp.azizguenni0.workers.dev).

> *"Give me a profile of Kasserine."* · *"How has inflation evolved since 2025?"* · *"Rank the governorates by doctors per inhabitant."* · *"What does the 2014 census say about rural unemployment in Sidi Bouzid?"* · *"Is there open data on pharmacies on duty?"*

## Tools

| Tool | What it does | Network |
|---|---|---|
| `search_indicators` | Keyword search over ~7,000 INS indicators. Translates English keywords (unemployment → chômage) and shows whether each indicator has data, its frequency, latest period and levels (national / governorate). Can filter to governorate-level indicators or by category. | none |
| `get_indicator` | Definition, methodology, source, unit, coverage, parent and sub-indicators of one indicator | none |
| `get_series` | Time series for 1–6 regions: gaps returned as `null`, explicit unit and scale, summary figures (latest, change, year-on-year, min/max, CAGR), freshness warnings | INS (cached) |
| `compare_regions` | Ranks the 24 governorates (or the 7 regions) on one indicator, with the national value, share of national total, max/min ratio | INS (cached) |
| `region_profile` | 14 key figures for one governorate with rank out of 24, plus computed per-capita ratios (doctors per 10,000 inhabitants, enterprises per 1,000…) | INS (cached) |
| `list_datasets` | The 78 INS databases with coverage and last-update dates | none |
| `describe_dataset` | Dimensions (Sexe, Milieu, Tranche d'âge…) and elements of one dataset | none |
| `query_dataset` | Generic query on any INS dataset by dimension and element names (e.g. `{"Sexe": ["*"], "Milieu": ["Rural"]}`) | INS (cached) |
| `list_regions` | Country → 7 regions → 24 governorates (ISO codes, Arabic names) → 264 delegations → 2,000+ sectors | none |
| `search_open_data` | Search the data.gov.tn catalog by keyword, publisher or file format | none |
| `preview_open_data` | Download a data.gov.tn file and return its columns and first rows (CSV, XLSX, JSON, GeoJSON) | file host |

**Prompts** (templates in Claude's prompt menu): `governorate_report` (autocompletes governorate names), `indicator_trend`, `compare_governorates`.

**Regions** can be given as French, English or Arabic names (`Sfax`, `Le Kef`, `Bizerta`, `صفاقس`, `ولاية القصرين`), ISO codes (`TN-61`) or INS keys.

## Architecture

```
                     ┌──────────────── Cloudflare Worker (/mcp, stateless) ───────────────┐
Claude ──MCP HTTP──▶ │ bundled snapshots: INS catalog (7,034 indicators, 236 dimensions,  │
                     │ 2,374 regions), availability index, data.gov.tn catalog (2,920)    │
                     │ KV cache: 24 h fresh, 7 d stale fallback                            │
                     └───────┬───────────────────────────────────────────┬────────────────┘
                             │ POST XML (GetData)                        │ GET file (preview)
                    dataportal.ins.tn/WebApi                 agridata.tn, openbaladiati.tn, …
```

### Design decisions

- **Stateless MCP server.** Each request builds a fresh `McpServer` via `createMcpHandler` (Cloudflare Agents SDK + MCP SDK v2). No sessions and no Durable Objects: the simplest and cheapest setup on the free plan.
- **Snapshots for everything that describes the data, live calls only for values.** Search, region lookup, dataset descriptions and the data.gov.tn catalog run from JSON bundled into the Worker (≈1.1 MB gzipped, under the 3 MB free limit). They answer in milliseconds and keep working when the upstream portals are down. Values come live from INS, cached in KV.
- **A data-availability index, built once.** `scripts/build-availability.ts` asks INS for every indicator, in batches of 50 (larger batches make INS drop the connection), at national level plus sample governorates and delegations. It records which indicators really have data, at which levels and up to when. Search can then hide empty categories, rank live series above dead ones, and say "national only" without a network call. Result: 6,656 of 7,034 indicators have data, 338 at governorate level, and only 3 at delegation level.
- **Built for the free plan's 10 ms CPU budget per request.** A general XML parser took ~53 ms on a 790 KB response, so `GetData` gets a dedicated single-pass scanner (~9 ms). Queries also ask INS to filter years server-side, which cuts the response to ~170 KB. Lookups inside `region_profile` use hash maps instead of repeated scans.
- **Server-side period filtering, with a fallback.** The INS `<Period>` filter only works with plain years *and* an explicit frequency list (`Frequency='Y|Q'`). The documented `m.yyyy` syntax and some combinations (`Y|M|Q|H`) are rejected. The client picks the frequency from the availability index and falls back to the full series if INS refuses.
- **Cache with stale fallback.** Under 24 h old, responses come from KV. Older entries trigger a refetch. If INS is down, the old copy is served and flagged `stale: true`. Cache writes use `waitUntil` so they never delay the answer.
- **Failure handling.** 12 s timeout per attempt and one retry for transient errors. INS's "HTTP 200 + HTML error page" and `IncorrectRequest` are not retried. Every tool returns explained errors (`isError` with candidates or hints), never stack traces.
- **Honest data, not just data.** Gaps are `null`, never interpolated. Freshness is judged on the full series, not the requested window. Warnings flag data ≥ 3 years old, projections and rates that must not be summed. Known metadata errors are corrected and labelled as such (see limitation 5).
- **Strict region resolution.** INS keys are not ISO codes, so every output echoes name + ISO + Arabic name. Ambiguous names return candidates instead of a guess.

## Data limitations

Read this before trusting an answer.

1. **INS region keys are not ISO codes.** Sfax is INS key `34` but ISO `TN-61`, and INS key `61` is **Gafsa**. Prefer names or `TN-xx` codes.
2. **Coverage varies a lot.** Many indicators exist only nationally, and many "indicators" are categories whose data lives in sub-indicators (*Taux de chômage* → *Par sexe* → *Féminin*). Governorate-level unemployment, for instance, stops in **2016**, while the national series is quarterly up to 2026. The tools report the period of every figure.
3. **The availability index is a sample.** It probes the national level, 4 governorates and 2 delegations. An indicator published only for other regions could be reported without regional data, but in practice INS publishes regional series for all governorates at once.
4. **Old data is common.** The 2014 census and the national-accounts tables are years old, and some indicators stopped in 2015–2019. Warnings flag anything ≥ 3 years old.
5. **INS unit metadata is sometimes wrong.** The labour force survey indicators (keys 40xxxxxx) are labelled "Nombre" but published **in thousands**. The server corrects this and adds a `unit_note`. Other errors may exist, so check magnitudes that look odd.
6. **Missing years and breaks.** Some series have holes (e.g. 2005, 2008, 2009 in central-bank data). Population estimates jump when rebased on a new census (Gafsa: 355,544 in 2023 → 388,295 in 2024).
7. **Projections.** The socio-economic database is declared for 1970–2050. Values after the current year are projections and are flagged.
8. **Per-capita ratios are computed** by this server, from INS counts and the 1 January population estimate of the same year. They are not official INS figures.
9. **data.gov.tn files hosted on `*.data.gov.tn` cannot be previewed.** That server sends an incomplete TLS certificate chain (wrong Sectigo intermediate). Browsers repair this; Cloudflare Workers refuse it, and a Worker cannot trust extra CAs. Those files (836 of 4,834) are marked `previewable: false`, and their links are returned instead. Files on sector portals (agridata.tn, openbaladiati.tn, openculture.gov.tn, data.transport.tn…) preview fine.
10. **Previews are partial.** At most 3 MB is read, and legacy `.xls` and PDF are not parsed. data.gov.tn files are published as-is by each administration, with heterogeneous columns and quality.
11. **Snapshots age.** Indicator metadata, availability and the data.gov.tn catalog date from the last `npm run build-data` (dates at `/health`). Values themselves are live or ≤ 24 h cached.
12. **Labels are French.** English search terms are translated for common topics. Arabic names are supported for governorates only.
13. **Availability.** INS runs an old .NET server over plain HTTP that is sometimes slow or down. One outage during development lasted ~9 minutes. Expect occasional errors or `stale` results.

## Development

Requirements: Node 20+. No Cloudflare account is needed for local work.

```bash
npm install
npm test               # 62 unit tests: parsers, gaps, search, regions, datasets, previews, cache
npm run typecheck
npm run dev            # local Worker on http://localhost:8787 (landing page) and /mcp (KV simulated)
npm run smoke          # calls every tool and prompt end-to-end against the dev server
npm run inspector      # MCP Inspector UI: transport "Streamable HTTP", URL http://localhost:8787/mcp
```

Refresh the snapshots (about 20 minutes, polite to INS, resumable if interrupted):

```bash
npm run build-data     # = build-index (catalog + dimensions) + build-availability + build-opendata
```

### Automatic data refresh

`.github/workflows/refresh-data.yml` rebuilds the snapshots every Monday, runs the tests and commits any change. To also redeploy automatically, add two repository secrets: `CLOUDFLARE_API_TOKEN` (Cloudflare dashboard → My Profile → API Tokens → template "Edit Cloudflare Workers") and `CLOUDFLARE_ACCOUNT_ID`. Without them, the job refreshes and commits, but you deploy yourself.

### Deploy (free tier)

```bash
npx wrangler login     # opens the browser once
npm run deploy         # creates the KV namespace automatically on first deploy
npm run smoke -- https://tunisia-data-mcp.<your-subdomain>.workers.dev/mcp
```

Then in Claude: **Settings → Connectors → Add custom connector**, URL `https://tunisia-data-mcp.<your-subdomain>.workers.dev/mcp`.

## Project layout

```
src/
  index.ts            Worker entry: /mcp, /health, / (landing page)
  tools.ts            Assembles the MCP server
  tools/indicators.ts search_indicators, get_indicator, get_series, compare_regions, region_profile
  tools/datasets.ts   list_datasets, describe_dataset, query_dataset, list_regions
  tools/opendata.ts   search_open_data, preview_open_data
  tools/prompts.ts    Prompt templates
  tools/common.ts     Result helpers, error handling, shared formatting
  catalog.ts          Indicator search, availability, region resolution (in memory)
  datasets.ts         Generic INS dataset query planning
  opendata.ts         data.gov.tn search, CSV/XLSX/JSON previews
  series.ts           Gaps, scale, summary figures, freshness warnings
  lexicon.ts          English→French search terms, Arabic governorate names
  ins/client.ts       INS HTTP client, KV cache, retries, query builder
  ins/parse.ts        INS XML parsing (fast GetData scanner)
  data/*.json         Generated snapshots
scripts/              build-index, build-availability, build-opendata, smoke
samples/              Raw INS responses used by tests
certs/                Missing Sectigo intermediate, used by build-opendata (Node only)
test/                 Vitest unit tests
```

## INS API reference (as discovered)

All endpoints are `POST http://dataportal.ins.tn/WebApi/<Name>` with `Content-Type: text/xml; charset=UTF-8`. They need no auth or cookies.

| Endpoint | Body | Returns |
|---|---|---|
| `GetStructure` | `<QueryMessage></QueryMessage>` | 78 databases, their dimensions, declared years |
| `GetDimensionElements` | `<QueryMessage><DataWhere><DimensionId WithData='true'>RDS_DICT_REGIONS_NSO</DimensionId></DataWhere></QueryMessage>` | Element tree with attributes (name, unit, timestamp, source, ISO…) |
| `GetData` | `<QueryMessage SourceId='C_NSO'><Period From='2019' To='2026' Frequency='Y\|Q'></Period><DataWhere><Dimension Id='RDS_DICT_INDICATORS_NSO'><Element>22269316</Element></Dimension><Dimension Id='RDS_DICT_REGIONS_NSO'><Element>0</Element></Dimension></DataWhere></QueryMessage>` | `<Set Period="YEARS:2024" …>11958938</Set>` (also `MONTHS:7.2026`, `QUARTERS:2.2026`) |
| `GetDataBorders` | same as GetData | First and last year with data |

Quirks:
- An unknown `SourceId` returns `State="Success"` with no data.
- An unknown endpoint returns HTTP 200 with an HTML page.
- Attribute order inside `<Set>` varies.
- Every dimension of a dataset must be specified, or you get `IncorrectRequest`.
- Many indicators per call work up to ~150, but ~500 drops the connection.
- `<Period>` needs `yyyy` bounds and an explicit `Frequency`.

The data.gov.tn catalog is CKAN 2.9 at `https://catalog.data.gov.tn/fr/api/3/action/package_search` (fast; if it looks slow with curl on Windows, that is certificate revocation checking: try `--ssl-no-revoke`).

## License & attribution

Code: MIT. Data: © Institut National de la Statistique (Tunisia) and the publishing administrations on data.gov.tn. This project is not affiliated with either. Always cite the source.
