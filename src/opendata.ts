// Tunisia's national open data portal (catalog.data.gov.tn): ~3,000 datasets
// from ministries, municipalities and public bodies. Search runs on a bundled
// snapshot (instant, and independent of portal uptime); previews download the
// actual file live. Files are often hosted on sector portals
// (catalog.agridata.tn, openbaladiati.tn, data.transport.tn...).

import { unzipSync, strFromU8 } from "fflate";
import { XMLParser } from "fast-xml-parser";
import rawOpenData from "./data/opendata.json";
import type { OpenDataset, OpenDataSnapshot } from "./catalog-types";
import { normalize, queryTerms } from "./catalog";

export const openData = rawOpenData as OpenDataSnapshot;
export const PORTAL_URL = "https://catalog.data.gov.tn/fr/dataset/";

interface Doc {
	ds: OpenDataset;
	title: string;
	body: string;
}

const docs: Doc[] = openData.datasets.map((ds) => ({
	ds,
	title: normalize(ds.title),
	body: normalize([ds.notes, ds.org, ds.tags.join(" "), ds.place, ds.resources.map((r) => r.name).join(" ")].filter(Boolean).join(" ")),
}));

export const datasetsBySlug = new Map(openData.datasets.map((d) => [d.id, d]));

export interface OpenSearchOptions {
	limit: number;
	organization?: string;
	format?: string;
}

export function searchOpenData(query: string, opts: OpenSearchOptions) {
	const terms = queryTerms(query);
	const org = opts.organization ? normalize(opts.organization) : "";
	const fmt = opts.format?.toUpperCase();
	const hasWord = (text: string, w: string) => text.startsWith(w) || text.includes(` ${w}`);
	const hits: { ds: OpenDataset; score: number }[] = [];
	for (const d of docs) {
		if (org && !normalize(d.ds.org ?? "").includes(org)) continue;
		if (fmt && !d.ds.resources.some((r) => r.format === fmt)) continue;
		let score = 0;
		let ok = true;
		for (const alts of terms) {
			if (alts.some((w) => hasWord(d.title, w))) score += 3;
			else if (alts.some((w) => hasWord(d.body, w))) score += 1;
			else {
				ok = false;
				break;
			}
		}
		if (!ok) continue;
		score += Number(d.ds.modified.slice(0, 4)) / 10000; // newer first on ties
		hits.push({ ds: d.ds, score });
	}
	hits.sort((a, b) => b.score - a.score);
	return { total: hits.length, hits: hits.slice(0, opts.limit).map((h) => h.ds) };
}

const PREVIEWABLE_FORMATS = new Set(["CSV", "XLSX", "JSON", "GEOJSON", "TXT"]);

/**
 * *.data.gov.tn serves an incomplete TLS certificate chain (wrong Sectigo
 * intermediate). Browsers and Windows repair it on the fly; Cloudflare Workers
 * (like Node) refuse the connection, and a Worker cannot add trusted CAs. Files
 * hosted there can only be linked, not previewed. Files on sector portals
 * (agridata.tn, openbaladiati.tn, ...) are fine.
 */
export function previewability(r: { format: string; url: string }): { previewable: boolean; reason?: string } {
	if (!PREVIEWABLE_FORMATS.has(r.format)) return { previewable: false, reason: `format ${r.format || "unknown"} is not previewable` };
	let host = "";
	try {
		host = new URL(r.url).hostname;
	} catch {
		return { previewable: false, reason: "invalid URL" };
	}
	if (host === "data.gov.tn" || host.endsWith(".data.gov.tn")) {
		return { previewable: false, reason: "hosted on data.gov.tn, whose TLS certificate chain is incomplete; open the link in a browser" };
	}
	return { previewable: true };
}

export function openDatasetSummary(ds: OpenDataset) {
	return {
		id: ds.id,
		title: ds.title,
		...(ds.notes ? { description: ds.notes } : {}),
		organization: ds.org,
		last_modified: ds.modified,
		...(ds.period ? { period: ds.period } : {}),
		...(ds.place ? { place: ds.place } : {}),
		license: ds.license,
		url: PORTAL_URL + ds.id,
		resources: ds.resources.map((r) => ({ id: r.id, name: r.name, format: r.format || "unknown", previewable: previewability(r).previewable })),
	};
}

// ---------- File preview ----------

const MAX_BYTES = 3 * 1024 * 1024;

/** Read at most MAX_BYTES of a response body; files on the portal can be huge. */
async function readCapped(res: Response): Promise<{ bytes: Uint8Array; text: string; truncated: boolean }> {
	if (!res.body) return { bytes: new Uint8Array(), text: "", truncated: false };
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	let truncated = false;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		size += value.byteLength;
		if (size >= MAX_BYTES) {
			truncated = true;
			await reader.cancel();
			break;
		}
	}
	const buf = new Uint8Array(size);
	let off = 0;
	for (const c of chunks) {
		buf.set(c, off);
		off += c.byteLength;
	}
	// Many government CSVs are exported from Excel in Windows-1252, not UTF-8.
	const utf8 = new TextDecoder("utf-8").decode(buf);
	const text = utf8.includes("�") ? new TextDecoder("windows-1252").decode(buf) : utf8;
	return { bytes: buf, text, truncated };
}

/** Minimal RFC 4180 CSV parser with delimiter auto-detection (`,` `;` or tab). */
export function parseCsv(text: string): string[][] {
	const firstLine = text.slice(0, text.indexOf("\n") >>> 0 || text.length);
	const delim = [";", ",", "\t"].map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quoted) {
			if (c === '"' && text[i + 1] === '"') {
				field += '"';
				i++;
			} else if (c === '"') quoted = false;
			else field += c;
		} else if (c === '"') quoted = true;
		else if (c === delim) {
			row.push(field);
			field = "";
		} else if (c === "\n" || c === "\r") {
			if (c === "\r" && text[i + 1] === "\n") i++;
			row.push(field);
			if (row.some((f) => f.trim() !== "")) rows.push(row.map((f) => f.trim()));
			row = [];
			field = "";
		} else field += c;
	}
	row.push(field);
	if (row.some((f) => f.trim() !== "")) rows.push(row.map((f) => f.trim()));
	return rows;
}

export class PreviewError extends Error {}

// Note: cells carry an attribute named "r" (A1 reference) while rich text uses
// <r> elements, so the array rule must only apply to elements.
const xml = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "",
	isArray: (name, _path, _leaf, isAttribute) => !isAttribute && ["si", "r", "row", "c", "sheet"].includes(name),
});

/** "B12" -> column index 1 */
function colIndex(ref: string): number {
	let n = 0;
	for (const ch of ref.replace(/\d+$/, "")) n = n * 26 + (ch.charCodeAt(0) - 64);
	return n - 1;
}

const textOf = (node: any): string => {
	if (node === undefined || node === null) return "";
	if (typeof node !== "object") return String(node);
	if ("#text" in node) return String(node["#text"]);
	return "";
};

/**
 * Minimal XLSX reader: unzip, read shared strings and the first worksheet.
 * Enough for previews of the simple tables government portals publish;
 * formulas show their cached values, dates show as Excel serial numbers.
 */
export function parseXlsx(bytes: Uint8Array): { sheet: string; rows: string[][] } {
	let files: Record<string, Uint8Array>;
	try {
		files = unzipSync(bytes, { filter: (f) => f.name.startsWith("xl/") && f.name.endsWith(".xml") });
	} catch {
		throw new PreviewError("File is not a readable XLSX archive.");
	}
	const shared: string[] = [];
	if (files["xl/sharedStrings.xml"]) {
		const sst = xml.parse(strFromU8(files["xl/sharedStrings.xml"])).sst;
		for (const si of sst?.si ?? []) {
			// A shared string is either <t> or rich text runs <r><t>.
			shared.push(si.t !== undefined ? textOf(si.t) : (si.r ?? []).map((r: any) => textOf(r.t)).join(""));
		}
	}
	const sheets = xml.parse(strFromU8(files["xl/workbook.xml"] ?? new Uint8Array())).workbook?.sheets?.sheet ?? [];
	const sheetFile = Object.keys(files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).sort()[0];
	if (!sheetFile) throw new PreviewError("XLSX file has no worksheet.");
	const ws = xml.parse(strFromU8(files[sheetFile])).worksheet;
	const rows: string[][] = [];
	for (const row of ws?.sheetData?.row ?? []) {
		const out: string[] = [];
		for (const c of row.c ?? []) {
			const i = c.r ? colIndex(c.r) : out.length;
			let v = textOf(c.v);
			if (c.t === "s") v = shared[Number(v)] ?? "";
			else if (c.t === "inlineStr") v = textOf(c.is?.t);
			out[i] = v.trim();
		}
		if (out.some((x) => x)) rows.push(Array.from(out, (x) => x ?? ""));
	}
	return { sheet: sheets[0]?.name ?? sheetFile, rows };
}

/** Use the first row as header, padded so every column has a name. */
function tabular(rows: string[][], maxRows: number) {
	const [header = [], ...body] = rows;
	const width = Math.max(header.length, ...body.slice(0, maxRows).map((r) => r.length));
	const cols = Array.from({ length: width }, (_, i) => header[i] || `col${i + 1}`);
	return { columns: cols, body, rows: body.slice(0, maxRows).map((r) => Object.fromEntries(cols.map((h, i) => [h, r[i] ?? ""]))) };
}

export async function previewResource(url: string, format: string, maxRows: number, fetchImpl: typeof fetch = fetch) {
	let res: Response;
	try {
		res = await fetchImpl(url, { signal: AbortSignal.timeout(25_000), redirect: "follow" });
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.warn("preview fetch failed", url, msg); // visible in Workers logs
		throw new PreviewError(`Could not download the file (${msg}). The user can open the link directly: ${url}`);
	}
	if (!res.ok) throw new PreviewError(`The portal returned HTTP ${res.status} for this file.`);
	const type = (res.headers.get("content-type") ?? "").toLowerCase();
	const fmt = format.toUpperCase();
	const { bytes, text, truncated } = await readCapped(res);

	if (fmt === "XLSX" || type.includes("spreadsheetml")) {
		if (truncated) throw new PreviewError("XLSX file is larger than the 3 MB preview limit. Share the link with the user instead.");
		const { sheet, rows } = parseXlsx(bytes);
		const t = tabular(rows, maxRows);
		return { kind: "xlsx", sheet, columns: t.columns, total_rows: t.body.length, rows: t.rows };
	}
	if (fmt === "JSON" || fmt === "GEOJSON" || type.includes("json")) {
		let data: any;
		try {
			data = JSON.parse(text);
		} catch {
			throw new PreviewError(truncated ? "JSON file is larger than the 3 MB preview limit." : "File is not valid JSON.");
		}
		if (data?.type === "FeatureCollection" && Array.isArray(data.features)) {
			const types = [...new Set(data.features.map((f: any) => f?.geometry?.type))];
			return {
				kind: "geojson",
				total_features: data.features.length,
				geometry_types: types,
				properties: data.features.slice(0, maxRows).map((f: any) => f?.properties ?? {}),
			};
		}
		const arr = Array.isArray(data) ? data : Array.isArray(data?.records) ? data.records : Array.isArray(data?.data) ? data.data : null;
		return arr ? { kind: "json-array", total_rows: arr.length, rows: arr.slice(0, maxRows) } : { kind: "json", preview: JSON.stringify(data).slice(0, 4000) };
	}
	if (fmt === "CSV" || fmt === "TXT" || type.includes("csv") || type.includes("text/plain")) {
		const t = tabular(parseCsv(text), maxRows);
		return {
			kind: "csv",
			columns: t.columns,
			total_rows: truncated ? `more than ${t.body.length} (file larger than 3 MB, count is partial)` : t.body.length,
			rows: t.rows,
		};
	}
	throw new PreviewError(`Preview supports CSV, XLSX, JSON and GeoJSON (not legacy XLS or PDF); this resource is ${fmt || type || "an unknown format"}. Share the link with the user instead.`);
}
