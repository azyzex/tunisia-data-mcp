// Ready-made prompts: show up in Claude's prompt picker ("/" menu in some
// clients) and encode a good workflow for common requests.

import { completable, type McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { governorates, normalize } from "../catalog";

const governorateNames = governorates.map((g) => g.name.replace(/^Gouvernorat (de |du |d')?/, ""));
const completeGovernorate = (value: string) => governorateNames.filter((n) => normalize(n).startsWith(normalize(value)));

const text = (t: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: t } }] });

export function registerPrompts(server: McpServer) {
	server.registerPrompt(
		"governorate_report",
		{
			title: "Governorate report",
			description: "A sourced socio-economic brief on one Tunisian governorate.",
			argsSchema: z.object({
				governorate: completable(z.string().describe("Governorate name, e.g. Kasserine"), completeGovernorate),
				language: z.string().optional().describe("Language of the report (default: English)"),
			}),
		},
		({ governorate, language }) =>
			text(
				`Write a concise socio-economic brief on the governorate of ${governorate}, Tunisia, in ${language || "English"}.\n` +
					`1. Call region_profile for "${governorate}".\n` +
					`2. For the 2-3 most striking figures (best or worst ranks), call get_series to show the trend over the last 10 years.\n` +
					`3. Optionally search_open_data for local datasets about ${governorate}.\n` +
					`Rules: cite INS with the reference period next to every number; say explicitly when a figure is more than 3 years old; ` +
					`never fill missing years; compare rates, not totals, between governorates.`,
			),
	);

	server.registerPrompt(
		"indicator_trend",
		{
			title: "Explain a trend",
			description: "Find an official indicator and explain how it evolved.",
			argsSchema: z.object({
				topic: z.string().describe("What to look at, e.g. 'inflation', 'unemployment of women', 'births'"),
				region: z.string().optional().describe("Governorate or 'Tunisie' (default)"),
			}),
		},
		({ topic, region }) =>
			text(
				`Explain how "${topic}" evolved in ${region || "Tunisia"}.\n` +
					`1. search_indicators for the topic (French or English keywords); pick the indicator whose latest_period is most recent and whose levels include the requested region.\n` +
					`2. get_series for it${region ? ` with region "${region}"` : ""}; use the summary block for changes instead of computing them yourself.\n` +
					`3. If useful, compare_regions for the latest period.\n` +
					`Report the unit, period, source (INS) and every warning returned. Do not interpolate missing periods.`,
			),
	);

	server.registerPrompt(
		"compare_governorates",
		{
			title: "Compare governorates",
			description: "Rank the 24 governorates on a topic, with context.",
			argsSchema: z.object({ topic: z.string().describe("e.g. 'doctors', 'unemployment', 'road accidents'") }),
		},
		({ topic }) =>
			text(
				`Rank Tunisia's 24 governorates on "${topic}".\n` +
					`1. search_indicators with level="governorate" to find an indicator with regional data.\n` +
					`2. compare_regions for it. If it is a count (not a rate), also compare per inhabitant using the population indicator (key 11922316) for the same year.\n` +
					`3. Present a table (rank, governorate, value) and comment on the gap between coastal and interior regions if relevant.\n` +
					`Cite INS and the period.`,
			),
	);
}
