// Worker entry point. Stateless Streamable HTTP MCP endpoint at /mcp:
// each request builds a fresh McpServer (cheap — the catalogs are loaded once
// per isolate), so no Durable Objects or sessions are needed.

import { createMcpHandler } from "agents/mcp/server";
import { availability, catalog } from "./catalog";
import { InsClient } from "./ins/client";
import { openData } from "./opendata";
import { createServer } from "./tools";
import { landingPage } from "./landing";

export interface Env {
	CACHE?: KVNamespace;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/mcp") {
			const client = new InsClient(env.CACHE, fetch, (p) => ctx.waitUntil(p));
			return createMcpHandler(() => createServer(client), { route: "/mcp" })(request, env, ctx);
		}

		if (url.pathname === "/health") {
			return Response.json({
				name: "tunisia-data MCP server",
				mcp_endpoint: `${url.origin}/mcp`,
				sources: {
					ins: { url: "http://dataportal.ins.tn", catalog_snapshot: catalog.built_at, availability_snapshot: availability.built_at },
					open_data: { url: "https://data.gov.tn", catalog_snapshot: openData.built_at, datasets: openData.datasets.length },
				},
				cache: env.CACHE ? "kv" : "disabled",
			});
		}

		if (url.pathname === "/") {
			return new Response(landingPage(`${url.origin}/mcp`), { headers: { "content-type": "text/html; charset=utf-8" } });
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
