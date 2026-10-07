# Connectors Directory submission: ready-to-paste answers

Portal: https://claude.ai/directory/manage → **Submit new** → **MCP connector**.
Any paid Claude plan can submit. Docs: https://claude.com/docs/connectors/building/submission

## 1. Connection
- Server URL: `https://tunisia-data-mcp.azizguenni0.workers.dev/mcp`
  (or pick your existing custom connector "TunisiAPI")
- Users connect to different URLs: **No**

## 2. Tools
All 11 tools have a `title` and `readOnlyHint: true`. They should all appear under "read-only". The 3 prompts sync too.

## 3. Listing
- **Server name** (≤100): `Tunisia Data`
- **One-liner** (≤200): `Tunisia's official statistics (INS) and open data (data.gov.tn) in Claude: population, prices, jobs, health and more, by governorate, with source and year.`
- **Description** (≤2,000):

> Ask Claude about Tunisia and get answers built on official numbers. Tunisia Data connects Claude to the Institut National de la Statistique (INS) data portal, about 7,000 indicators and 78 datasets, and to the national open data portal data.gov.tn, about 2,900 datasets from ministries and municipalities.
>
> What you can do:
> - Look up any indicator, such as population, inflation, unemployment, births, doctors, enterprises or road accidents, nationally or for each of the 24 governorates.
> - Get time series with summary figures: latest value, year-on-year change, highs and lows.
> - Rank and compare governorates, or get a one-call profile of a governorate with its rank out of 24.
> - Query the 2014 census tables, population projections to 2044 and the national accounts.
> - Find datasets on data.gov.tn and preview CSV, Excel, JSON and GeoJSON files.
>
> Every answer includes the unit, the period and the source. Old data and projections are flagged, and missing years stay missing instead of being estimated. Regions can be named in English, French or Arabic.
>
> Free, read-only, no account needed. Not affiliated with INS or data.gov.tn.

- **Categories** (1–5): pick the closest of what the portal offers, e.g. Data & Analytics, Research, Education, Government / Public data.
- **Documentation URL**: `https://github.com/azyzex/tunisia-data-mcp#readme`
- **Privacy policy URL**: `https://tunisia-data-mcp.azizguenni0.workers.dev/privacy`
- **Support contact**: `https://github.com/azyzex/tunisia-data-mcp/issues` (or an email you're happy to make public)
- **Icon**: `docs/icon-512.png`
- **URL slug** (permanent): `tunisia-data`

## 4. Use cases
- Primary use cases: students and researchers citing Tunisian statistics (mémoires, theses), journalists checking regional figures, analysts comparing governorates, anyone looking for Tunisian open data.
- What users need before connecting: nothing. No account, no key.
- Reads or writes: **Reads data only.**

## 5. Company
- Company name: your name (individual developer), or a project name if the portal requires one
- Website: `https://tunisia-data-mcp.azizguenni0.workers.dev`
- Primary contact: your email (only shown to Anthropic)

## 6. Authentication
**No authentication.** The data is public.

## 7. Data handling
- Underlying API: **a third party's public API that you don't control.** Suggested explanation:
  > The connector reads the public, unauthenticated API of the Institut National de la Statistique data portal (dataportal.ins.tn/WebApi), which INS publishes so that its data can be "reused and recombined in new applications" (from its API page), and the public CKAN catalog of data.gov.tn, Tunisia's official open data portal (open licences). The connector is read-only, caches responses for 7 days to limit load on INS, and attributes every figure to its source. It is not affiliated with either organisation.
- Personal health data: **No** (aggregate public statistics only)
- Sponsored content: **No**

## 8. Test & launch
- Test account: **not needed** (no authentication). Reviewer instructions:
  > Add the server URL as a custom connector, no login needed. Example prompts: "Give me a profile of Kasserine", "How has inflation moved over the last year in Tunisia?", "Rank the governorates by doctors per 10,000 inhabitants", "What does the 2014 census say about unemployment in Sidi Bouzid?", "Find open data about pharmacies on duty".
- Confirm you ran every tool: yes. All 11 were run end to end against the live server (`npm run smoke`) and from Claude as a custom connector.

## 9. Compliance
Seven acknowledgments only you can make. Read them; nothing in this connector involves financial transactions, AI media generation or conversation data collection.

## Known review risk
Anthropic's rule says connectors must call "your own first-party APIs, or APIs you legitimately proxy". INS publishes its API openly for reuse, which is the argument for "legitimate proxy", but the decision is Anthropic's. If it's declined, the connector keeps working as a custom connector for anyone who adds the URL.
