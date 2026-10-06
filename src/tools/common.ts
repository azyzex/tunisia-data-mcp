// Helpers shared by all tool modules.

import { describeAvailability, effectiveUnit, indicatorPath, indicatorsByKey, regionSummary, resolveRegion } from "../catalog";
import type { IndicatorEntry, RegionEntry } from "../catalog-types";
import { InsUnavailableError, type FetchResult } from "../ins/client";
import { InsResponseError } from "../ins/parse";
import { PreviewError } from "../opendata";

export const INS_ATTRIBUTION = "Institut National de la Statistique (INS) Tunisia — dataportal.ins.tn";
export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
export const OFFLINE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export type ToolResult = {
	content: { type: "text"; text: string }[];
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
};

export function ok(data: Record<string, unknown>): ToolResult {
	return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}

export function fail(message: string, extra: Record<string, unknown> = {}): ToolResult {
	return { content: [{ type: "text", text: JSON.stringify({ error: message, ...extra }) }], isError: true };
}

export const isResult = (x: unknown): x is ToolResult => typeof x === "object" && x !== null && "content" in x;

/** Uniform handling of upstream failures for tools that hit the network. */
export async function guarded(fn: () => Promise<ToolResult>): Promise<ToolResult> {
	try {
		return await fn();
	} catch (e) {
		if (e instanceof InsUnavailableError) {
			return fail(`${e.message}. The INS portal is an old public server and is sometimes down; try again in a few minutes.`);
		}
		if (e instanceof InsResponseError) return fail(`INS rejected the request: ${e.message}`);
		if (e instanceof PreviewError) return fail(e.message);
		throw e;
	}
}

export function retrieval(r: FetchResult) {
	return {
		attribution: INS_ATTRIBUTION,
		fetched_from_ins_at: r.fetched_at,
		served_from_cache: r.from_cache,
		...(r.stale ? { stale: true, stale_note: "INS was unreachable; this is the last cached copy." } : {}),
	};
}

export function indicatorSummary(ind: IndicatorEntry) {
	return {
		key: ind.key,
		name: ind.name,
		...(ind.full_name ? { full_name: ind.full_name } : {}),
		category: indicatorPath(ind).join(" > "),
		...effectiveUnit(ind),
		metadata_updated: ind.last_updated ?? null,
		has_sub_indicators: ind.is_category,
		availability: describeAvailability(ind.key),
	};
}

export function indicatorDetails(ind: IndicatorEntry) {
	return {
		...indicatorSummary(ind),
		source: ind.source ?? null,
		...(ind.note ? { definition_note: ind.note } : {}),
		...(ind.methodology ? { methodology: ind.methodology } : {}),
	};
}

export function lookupIndicator(key: number): IndicatorEntry | ToolResult {
	return indicatorsByKey.get(key) ?? fail(`Unknown indicator key ${key}. Use search_indicators to find valid keys.`);
}

export function lookupRegion(input: string): RegionEntry | ToolResult {
	const r = resolveRegion(input);
	if (r.ok) return r.region;
	return fail(r.reason, { candidates: r.candidates.map(regionSummary) });
}
