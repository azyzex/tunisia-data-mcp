// MCP server definition: assembles the tool modules and prompts.

import { McpServer } from "@modelcontextprotocol/server";
import type { InsClient } from "./ins/client";
import { registerDatasetTools } from "./tools/datasets";
import { registerIndicatorTools } from "./tools/indicators";
import { registerOpenDataTools } from "./tools/opendata";
import { registerPrompts } from "./tools/prompts";

export const SERVER_INSTRUCTIONS =
	"Official and open data about Tunisia. Sources: the Institut National de la Statistique (INS) data portal and the national open data portal (data.gov.tn).\n" +
	"- Statistics (population, prices/inflation, employment, health, education, enterprises, transport, trade...): search_indicators -> get_series / compare_regions / get_indicator. " +
	"region_profile gives a governorate overview in one call.\n" +
	"- Census 2014 tables, population projections 2014-2044, national accounts: list_datasets -> describe_dataset -> query_dataset.\n" +
	"- Administrative, municipal and sector datasets (budgets, agriculture, facilities...): search_open_data -> preview_open_data.\n" +
	"- Regions: names in French, English or Arabic, or ISO codes (TN-61). INS keys are not ISO numbers.\n" +
	"Every data result includes its unit, period and source, warnings about old data or projections, and missing periods as null (never estimated).";

export function createServer(client: InsClient, fetchImpl: typeof fetch = fetch): McpServer {
	const server = new McpServer({ name: "tunisia-data", version: "2.0.0" }, { instructions: SERVER_INSTRUCTIONS });
	registerIndicatorTools(server, client);
	registerDatasetTools(server, client);
	registerOpenDataTools(server, fetchImpl);
	registerPrompts(server);
	return server;
}
