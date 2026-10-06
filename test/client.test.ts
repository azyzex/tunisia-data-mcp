import { describe, expect, it } from "vitest";
import { buildDataQuery, InsClient, InsUnavailableError } from "../src/ins/client";
import { InsResponseError } from "../src/ins/parse";

/** Minimal in-memory KV with the subset of the API the client uses. */
function fakeKv() {
	const store = new Map<string, string>();
	return {
		store,
		kv: {
			async get(key: string, type: string) {
				const v = store.get(key);
				return v === undefined ? null : type === "json" ? JSON.parse(v) : v;
			},
			async put(key: string, value: string) {
				store.set(key, value);
			},
		} as unknown as KVNamespace,
	};
}

function fakeFetch(responses: (() => Response | Promise<Response>)[]) {
	let calls = 0;
	const fn = (async () => {
		const r = responses[Math.min(calls, responses.length - 1)];
		calls++;
		return r();
	}) as unknown as typeof fetch;
	return { fn, calls: () => calls };
}

const XML = `<Series State="Success"/>`;
const flush = (pending: Promise<unknown>[]) => Promise.all(pending);

describe("InsClient", () => {
	it("serves the second call from cache", async () => {
		const { kv } = fakeKv();
		const f = fakeFetch([() => new Response(XML)]);
		const pending: Promise<unknown>[] = [];
		const c = new InsClient(kv, f.fn, (p) => pending.push(p));
		const a = await c.post("GetData", "<q/>");
		await flush(pending);
		const b = await c.post("GetData", "<q/>");
		expect(a.from_cache).toBe(false);
		expect(b.from_cache).toBe(true);
		expect(f.calls()).toBe(1);
	});

	it("retries once on network failure", async () => {
		const f = fakeFetch([
			() => {
				throw new TypeError("connection reset");
			},
			() => new Response(XML),
		]);
		const r = await new InsClient(undefined, f.fn).post("GetData", "<q/>");
		expect(r.xml).toBe(XML);
		expect(f.calls()).toBe(2);
	});

	it("gives up after the retry with a clear error", async () => {
		const f = fakeFetch([() => new Response("down", { status: 503 })]);
		await expect(new InsClient(undefined, f.fn).post("GetData", "<q/>")).rejects.toThrow(InsUnavailableError);
		expect(f.calls()).toBe(2);
	});

	it("serves a stale copy when INS is down", async () => {
		const { kv, store } = fakeKv();
		const old = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
		const f = fakeFetch([() => new Response(XML)]);
		// Prime the cache through the client to get the right key, then age it.
		const pending: Promise<unknown>[] = [];
		await new InsClient(kv, f.fn, (p) => pending.push(p)).post("GetData", "<q/>");
		await flush(pending);
		const [key, value] = [...store.entries()][0];
		store.set(key, JSON.stringify({ ...JSON.parse(value), fetched_at: old }));

		const down = fakeFetch([() => new Response("", { status: 502 })]);
		const r = await new InsClient(kv, down.fn).post("GetData", "<q/>");
		expect(r).toMatchObject({ stale: true, from_cache: true, fetched_at: old });
	});

	it("does not retry when INS answers with an HTML error page", async () => {
		const f = fakeFetch([() => new Response("<html><body>Endpoint not found.</body></html>")]);
		await expect(new InsClient(undefined, f.fn).post("GetData", "<q/>")).rejects.toThrow(InsResponseError);
		expect(f.calls()).toBe(1);
	});
});

describe("buildDataQuery", () => {
	it("builds the documented XML and escapes values", () => {
		expect(buildDataQuery("C_NSO", { DIM: [1, "a'b"] })).toBe(
			"<QueryMessage SourceId='C_NSO'><DataWhere><Dimension Id='DIM'><Element>1</Element><Element>a&apos;b</Element></Dimension></DataWhere></QueryMessage>",
		);
	});
});
