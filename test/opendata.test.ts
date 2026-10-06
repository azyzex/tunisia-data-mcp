import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openData, parseCsv, parseXlsx, previewability, previewResource, searchOpenData } from "../src/opendata";

describe("open data snapshot search", () => {
	it("has the portal catalog", () => {
		expect(openData.datasets.length).toBeGreaterThan(2000);
	});

	it("finds datasets", () => {
		expect(searchOpenData("pharmacies", { limit: 5 }).total).toBeGreaterThan(0);
		expect(searchOpenData("station climatique", { limit: 5 }).total).toBeGreaterThan(0);
	});

	it("filters by format", () => {
		const { hits } = searchOpenData("budget", { limit: 20, format: "csv" });
		expect(hits.every((d) => d.resources.some((r) => r.format === "CSV"))).toBe(true);
	});
});

describe("parseCsv", () => {
	it("detects the ; delimiter and handles quotes", () => {
		expect(parseCsv('Nom;Valeur\n"Sfax; centre";12\r\nTunis;"3 ""a"""\n')).toEqual([
			["Nom", "Valeur"],
			["Sfax; centre", "12"],
			["Tunis", '3 "a"'],
		]);
	});
});

function makeXlsx(): Uint8Array {
	return zipSync({
		"xl/workbook.xml": strToU8('<workbook><sheets><sheet name="Données" sheetId="1"/></sheets></workbook>'),
		"xl/sharedStrings.xml": strToU8("<sst><si><t>Gouvernorat</t></si><si><t>Ecoles</t></si><si><r><t>Sf</t></r><r><t>ax</t></r></si></sst>"),
		"xl/worksheets/sheet1.xml": strToU8(
			'<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
				'<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>42</v></c></row></sheetData></worksheet>',
		),
	});
}

describe("parseXlsx", () => {
	it("reads shared strings, rich text and sparse cells", () => {
		expect(parseXlsx(makeXlsx())).toEqual({ sheet: "Données", rows: [["Gouvernorat", "Ecoles"], ["Sfax", "", "42"]] });
	});
});

describe("previewResource", () => {
	const fakeFetch = (body: BodyInit, type: string) =>
		(async () => new Response(body, { headers: { "content-type": type } })) as unknown as typeof fetch;

	it("previews CSV with column names", async () => {
		const p = await previewResource("http://x/a.csv", "CSV", 1, fakeFetch("a,b\n1,2\n3,4\n", "text/csv"));
		expect(p).toEqual({ kind: "csv", columns: ["a", "b"], total_rows: 2, rows: [{ a: "1", b: "2" }] });
	});

	it("previews XLSX", async () => {
		const p = await previewResource("http://x/a.xlsx", "XLSX", 5, fakeFetch(makeXlsx(), "application/octet-stream"));
		expect(p).toMatchObject({ kind: "xlsx", columns: ["Gouvernorat", "Ecoles", "col3"], total_rows: 1 });
	});

	it("summarizes GeoJSON", async () => {
		const gj = JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point" }, properties: { nom: "A" } }] });
		const p = await previewResource("http://x/a.geojson", "GEOJSON", 5, fakeFetch(gj, "application/json"));
		expect(p).toEqual({ kind: "geojson", total_features: 1, geometry_types: ["Point"], properties: [{ nom: "A" }] });
	});

	it("decodes Windows-1252 CSVs", async () => {
		const bytes = new Uint8Array([0x4e, 0x6f, 0x6d, 0x0a, 0x42, 0xe8, 0x6a, 0x61, 0x0a]); // "Nom\nBèja\n" in cp1252
		const p = await previewResource("http://x/a.csv", "CSV", 5, fakeFetch(bytes, "text/csv"));
		expect(p).toMatchObject({ rows: [{ Nom: "Bèja" }] });
	});

	it("refuses unsupported formats clearly", async () => {
		await expect(previewResource("http://x/a.pdf", "PDF", 5, fakeFetch("x", "application/pdf"))).rejects.toThrow(/CSV, XLSX, JSON/);
	});
});

describe("previewability", () => {
	it("allows sector portals and rejects *.data.gov.tn and binary formats", () => {
		expect(previewability({ format: "CSV", url: "https://catalog.agridata.tn/x.csv" }).previewable).toBe(true);
		expect(previewability({ format: "CSV", url: "https://catalog.data.gov.tn/x.csv" })).toMatchObject({ previewable: false, reason: expect.stringMatching(/TLS/) });
		expect(previewability({ format: "PDF", url: "https://openbaladiati.tn/x.pdf" }).previewable).toBe(false);
	});
});
