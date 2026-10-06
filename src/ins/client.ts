// HTTP client for the INS WebApi with caching and failure handling.
//
// Cache design (Cloudflare KV, free tier):
//   - Every response is stored with its fetch time and a 7-day KV expiry.
//   - Entries younger than FRESH_SECONDS are served without contacting INS.
//   - Older entries trigger a refetch; if INS is down or slow, the stale copy
//     is served instead and the result is flagged `stale: true` so the tool
//     output can say so. Users get an answer, and are told how old it is.
// KV is optional: without the binding (e.g. unit tests) we just call INS.

import { InsResponseError } from "./parse";

export const INS_BASE = "http://dataportal.ins.tn/WebApi/";
// GetData normally answers in ~2 s; two 12 s attempts bound the worst case
// at ~24 s, still inside typical MCP client timeouts.
const TIMEOUT_MS = 12_000;
const FRESH_SECONDS = 24 * 3600;
const KV_TTL_SECONDS = 7 * 24 * 3600;
const CACHE_VERSION = "v1";

export type Endpoint = "GetData" | "GetDataBorders" | "GetDimensionElements" | "GetStructure";

export interface FetchResult {
	xml: string;
	fetched_at: string; // ISO time the XML was retrieved from INS
	from_cache: boolean;
	stale: boolean;
}

export class InsUnavailableError extends Error {}

interface CacheEntry {
	xml: string;
	fetched_at: string;
}

async function sha256(text: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function callIns(endpoint: Endpoint, body: string, fetchImpl: typeof fetch): Promise<string> {
	let lastError: unknown;
	// One retry: the INS server occasionally drops connections, but we don't
	// want to pile up load on it if it is genuinely down.
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const res = await fetchImpl(INS_BASE + endpoint, {
				method: "POST",
				headers: { "Content-Type": "text/xml; charset=UTF-8" },
				body,
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			if (res.status >= 500) throw new InsUnavailableError(`INS returned HTTP ${res.status}`);
			if (!res.ok) throw new InsResponseError(`INS returned HTTP ${res.status} for ${endpoint}`);
			const text = await res.text();
			// Unknown endpoints come back as a .NET HTML error page with status 200.
			if (/<html/i.test(text.slice(0, 500))) throw new InsResponseError(`INS returned an HTML error page for ${endpoint}`);
			return text;
		} catch (e) {
			lastError = e;
			if (e instanceof InsResponseError) throw e; // not transient, don't retry
		}
	}
	const msg = lastError instanceof Error ? lastError.message : String(lastError);
	throw new InsUnavailableError(`INS data portal is unreachable or timed out (${msg})`);
}

export class InsClient {
	constructor(
		private kv: KVNamespace | undefined,
		private fetchImpl: typeof fetch = fetch,
		private waitUntil: (p: Promise<unknown>) => void = () => {},
	) {}

	async post(endpoint: Endpoint, body: string): Promise<FetchResult> {
		const key = `${CACHE_VERSION}:${endpoint}:${await sha256(body)}`;
		let cached: CacheEntry | null = null;
		if (this.kv) {
			try {
				cached = await this.kv.get<CacheEntry>(key, "json");
			} catch {
				cached = null; // a broken cache must never break the tool
			}
		}
		const age = cached ? (Date.now() - Date.parse(cached.fetched_at)) / 1000 : Infinity;
		if (cached && age < FRESH_SECONDS) {
			return { ...cached, from_cache: true, stale: false };
		}

		try {
			const xml = await callIns(endpoint, body, this.fetchImpl);
			const entry: CacheEntry = { xml, fetched_at: new Date().toISOString() };
			if (this.kv) {
				// Don't make the user wait for the cache write.
				this.waitUntil(this.kv.put(key, JSON.stringify(entry), { expirationTtl: KV_TTL_SECONDS }).catch(() => {}));
			}
			return { ...entry, from_cache: false, stale: false };
		} catch (e) {
			if (cached && e instanceof InsUnavailableError) {
				return { ...cached, from_cache: true, stale: true };
			}
			throw e;
		}
	}
}

/** Escape text placed inside the XML query (keys are numeric, but be safe). */
export function xmlEscape(s: string): string {
	return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}

/**
 * Build a GetData / GetDataBorders query. The optional <Period> filter must use
 * plain years ("2019") with an explicit Frequency ("Y", "M", "Y|Q"): the
 * documented "m.yyyy" syntax is rejected, and without Frequency the filter is
 * ignored. Results are still filtered locally afterwards.
 */
export function buildDataQuery(
	sourceId: string,
	where: Record<string, (string | number)[]>,
	period?: { from: number; to: number; frequency: string },
): string {
	const dims = Object.entries(where)
		.map(
			([dim, els]) =>
				`<Dimension Id='${xmlEscape(dim)}'>${els.map((e) => `<Element>${xmlEscape(String(e))}</Element>`).join("")}</Dimension>`,
		)
		.join("");
	const p = period ? `<Period From='${period.from}' To='${period.to}' Frequency='${xmlEscape(period.frequency)}'></Period>` : "";
	return `<QueryMessage SourceId='${xmlEscape(sourceId)}'>${p}<DataWhere>${dims}</DataWhere></QueryMessage>`;
}
