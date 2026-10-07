import { describe, expect, it } from "vitest";
import { availability, availabilityOf, catalog, effectiveUnit, governorates, indicatorPath, indicatorsByKey, normalize, resolveRegion, searchIndicators } from "../src/catalog";

describe("catalog snapshot", () => {
	it("has the 24 governorates with ISO codes", () => {
		expect(governorates).toHaveLength(24);
		expect(governorates.every((g) => /^TN-\d{2}$/.test(g.iso!))).toBe(true);
	});

	it("lists all datasets", () => {
		expect(catalog.datasets.length).toBe(78);
		expect(catalog.datasets[0].id).toBe("C_NSO");
	});

	it("rebuilds category paths from parent links", () => {
		const ind = indicatorsByKey.get(27523489)!; // SAU
		expect(indicatorPath(ind)).toEqual(["Agriculture", "Données structurelles"]);
	});
});

describe("availability index", () => {
	it("covers most indicators", () => {
		expect(Object.keys(availability.indicators).length).toBeGreaterThan(6000);
		expect(availabilityOf(11922316)).toMatchObject({ nat: true, f: "A" });
		expect(availabilityOf(11922316)!.gov).toBeGreaterThan(0);
		expect(availabilityOf(28270769)).toBeUndefined();
	});
});

describe("normalize", () => {
	it("strips accents and punctuation", () => {
		expect(normalize("Bèja")).toBe("beja");
		expect(normalize("L'Ariana")).toBe("l ariana");
		expect(normalize("Taux de chômage (%)")).toBe("taux de chomage");
	});
});

describe("searchIndicators", () => {
	it("finds indicators without accents", () => {
		const { hits } = searchIndicators("creances banques depots", { limit: 5 });
		expect(hits.map((h) => h.ind.key)).toContain(27545539);
	});

	it("finds the CPI", () => {
		const { hits } = searchIndicators("indice prix consommation", { limit: 10 });
		expect(hits.map((h) => h.ind.key)).toContain(28228379);
	});

	it("ranks the headline CPI first", () => {
		expect(searchIndicators("indice prix consommation", { limit: 1 }).hits[0].ind.key).toBe(28228379);
	});

	it("translates English keywords", () => {
		const keys = searchIndicators("unemployment rate women", { limit: 10 }).hits.map((h) => h.ind.key);
		expect(keys).toContain(40008002);
		expect(searchIndicators("consumer price index", { limit: 3 }).hits[0].ind.key).toBe(28228379);
		// The CPI (28228379) or its year-on-year change, i.e. the inflation rate (28228399).
		expect([28228379, 28228399]).toContain(searchIndicators("inflation", { limit: 1 }).hits[0].ind.key);
		expect(searchIndicators("doctors", { limit: 5, level: "governorate" }).hits.map((h) => h.ind.key)).toContain(22300416);
	});

	it("hides indicators without data unless asked", () => {
		// "Taux de chômage" (28270769) is a category with no values of its own.
		expect(searchIndicators("taux de chomage", { limit: 50 }).hits.map((h) => h.ind.key)).not.toContain(28270769);
		expect(searchIndicators("taux de chomage", { limit: 50, includeEmpty: true }).hits.map((h) => h.ind.key)).toContain(28270769);
	});

	it("filters by governorate availability and category", () => {
		const { hits } = searchIndicators("taux", { limit: 50, level: "governorate" });
		expect(hits.length).toBeGreaterThan(0);
		expect(hits.every((h) => (availabilityOf(h.ind.key)?.gov ?? 0) > 0)).toBe(true);
		const sante = searchIndicators("nombre", { limit: 50, category: "Santé" }).hits;
		expect(sante.length).toBeGreaterThan(0);
		expect(sante.every((h) => normalize([...indicatorPath(h.ind), h.ind.name].join(" ")).includes("sante"))).toBe(true);
	});

	it("ignores stopwords and returns nothing for gibberish", () => {
		expect(searchIndicators("de la", { limit: 5 }).total).toBe(0);
		expect(searchIndicators("zzzzqqq", { limit: 5 }).total).toBe(0);
	});
});

describe("resolveRegion", () => {
	const key = (s: string) => {
		const r = resolveRegion(s);
		return r.ok ? r.region.key : null;
	};

	it("resolves names, accents, ISO codes, keys and aliases", () => {
		expect(key("Sfax")).toBe(34);
		expect(key("gouvernorat de sfax")).toBe(34);
		expect(key("beja")).toBe(21);
		expect(key("Ariana")).toBe(12);
		expect(key("Le Kef")).toBe(23);
		expect(key("Kef")).toBe(23);
		expect(key("tn-11")).toBe(11);
		expect(key("Tunisia")).toBe(0);
		expect(key("Grand Tunis")).toBe(28629509);
	});

	it("keeps INS keys and ISO codes apart (INS 61 is Gafsa, ISO TN-61 is Sfax)", () => {
		expect(key("TN-61")).toBe(34);
		expect(key("61")).toBe(61);
		const r = resolveRegion("61");
		expect(r.ok && r.region.name).toBe("Gouvernorat de Gafsa");
	});

	it("resolves Arabic and English names", () => {
		expect(key("صفاقس")).toBe(34);
		expect(key("ولاية القصرين")).toBe(42);
		expect(key("أريانة")).toBe(12);
		expect(key("اريانة")).toBe(12); // without hamza
		expect(key("Bizerta")).toBe(17);
		expect(key("Governorate of Gabes")).toBe(51);
		expect(key("South West")).toBe(6);
	});

	it("prefers the governorate for 'Tunis'", () => {
		expect(key("Tunis")).toBe(11);
	});

	it("returns candidates instead of guessing", () => {
		const r = resolveRegion("Nowhere");
		expect(r.ok).toBe(false);
	});
});

describe("effectiveUnit", () => {
	it("corrects the labour force survey unit (published in thousands)", () => {
		expect(effectiveUnit(indicatorsByKey.get(40003000)!)).toMatchObject({ unit: "Milliers (thousands)" });
		expect(effectiveUnit(indicatorsByKey.get(11922316)!)).toEqual({ unit: "Nombre" });
	});
});
