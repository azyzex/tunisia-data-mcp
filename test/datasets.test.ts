import { describe, expect, it } from "vitest";
import { catalog } from "../src/catalog";
import { describeDataset, findDataset, planDatasetQuery, resolveElements } from "../src/datasets";

const projections = findDataset("OBJ6943049");
if ("error" in projections) throw new Error("fixture dataset missing");

describe("dataset catalog", () => {
	it("has every dataset dimension in the snapshot", () => {
		const shared = ["RDS_DICT_REGIONS_NSO", "RDS_DICT_INDICATORS_NSO", "UNITS"];
		const missing = catalog.datasets.flatMap((d) => d.dimensions.filter((x) => !shared.includes(x.id) && !catalog.dimensions[x.id]));
		expect(missing).toEqual([]);
	});

	it("finds datasets by id or name", () => {
		expect(findDataset("projection de la population")).toMatchObject({ id: "OBJ6943049" });
		expect("error" in findDataset("zzz")).toBe(true);
	});

	it("describes dimensions with defaults", () => {
		const d = describeDataset(projections);
		const genre = d.dimensions.find((x) => x.name === "Genre")!;
		expect(genre.default_if_unfiltered).toEqual(["Total"]);
		expect(genre.elements.map((e) => e.name)).toEqual(["Total", "Masculin", "Féminin"]);
	});
});

describe("planDatasetQuery", () => {
	it("defaults every unfiltered dimension to its top level and region to national", () => {
		const r = planDatasetQuery(projections, {}, []);
		expect(r.ok && r.plan.where).toEqual({
			RDS_DICT_REGIONS_NSO: [0],
			OBJ6943069: [27968509],
			OBJ6943079: [27968519],
			OBJ6943089: [27968549],
		});
	});

	it("resolves filters by dimension and element name, accent-insensitive", () => {
		const r = planDatasetQuery(projections, { genre: ["feminin", "Masculin"], "tranche d'age": ["0-4 ans"] }, ["Sfax"]);
		expect(r.ok && r.plan.where).toMatchObject({ RDS_DICT_REGIONS_NSO: [34], OBJ6943079: [27968539, 27968529], OBJ6943089: [27968559] });
	});

	it("expands '*' and refuses oversized selections", () => {
		const all = planDatasetQuery(projections, { Genre: ["*"] }, []);
		expect(all.ok && all.plan.seriesCount).toBe(3);
		const big = planDatasetQuery(projections, { Genre: ["*"], "Tranche d'âge": ["*"] }, ["Tunis", "Sfax", "Sousse", "Nabeul", "Gabes", "Gafsa"]);
		expect(big.ok).toBe(false);
	});

	it("explains unknown dimensions and elements", () => {
		const r = planDatasetQuery(projections, { Couleur: ["bleu"] }, []);
		expect(!r.ok && r.error).toMatch(/no dimension "Couleur"/);
		expect(resolveElements(catalog.dimensions.OBJ6943079, ["Enfant"]).ok).toBe(false);
	});

	it("redirects C_NSO to the indicator tools", () => {
		const nso = findDataset("C_NSO");
		if ("error" in nso) throw new Error();
		expect(planDatasetQuery(nso, {}, []).ok).toBe(false);
	});
});
