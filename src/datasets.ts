// Generic access to any of the 78 INS datasets (census 2014 tables, population
// projections, national accounts, ...). Each dataset has its own dimensions;
// the snapshot in catalog.dimensions lets us resolve human labels to INS keys
// offline, so only the data itself is fetched live.

import { catalog, COUNTRY_KEY, MAIN_SOURCE, normalize, regionSummary, resolveRegion } from "./catalog";
import type { DatasetEntry, DimensionElement, DimensionEntry, RegionEntry } from "./catalog-types";

export const REGION_DIM = "RDS_DICT_REGIONS_NSO";

export const datasetsById = new Map<string, DatasetEntry>(catalog.datasets.map((d) => [d.id, d]));

export function findDataset(idOrName: string): DatasetEntry | { error: string; candidates: { id: string; name: string }[] } {
	const exact = datasetsById.get(idOrName.trim()) ?? datasetsById.get(idOrName.trim().toUpperCase());
	if (exact) return exact;
	const n = normalize(idOrName);
	const matches = catalog.datasets.filter((d) => normalize(d.name).includes(n));
	if (matches.length === 1) return matches[0];
	return {
		error: matches.length ? `"${idOrName}" matches several datasets; pass an id.` : `Unknown dataset "${idOrName}". Use list_datasets.`,
		candidates: matches.slice(0, 15).map((d) => ({ id: d.id, name: d.name })),
	};
}

/** The dataset's own dimensions (everything except regions), with their elements. */
export function ownDimensions(ds: DatasetEntry): DimensionEntry[] {
	return ds.dimensions
		.filter((d) => d.id !== REGION_DIM)
		.map((d) => catalog.dimensions[d.id])
		.filter((d): d is DimensionEntry => !!d);
}

export const hasRegionDim = (ds: DatasetEntry) => ds.dimensions.some((d) => d.id === REGION_DIM);

/** Dimensions declared by INS but absent from the snapshot (fetch failed at build time). */
export const missingDimensions = (ds: DatasetEntry) =>
	ds.dimensions.filter((d) => d.id !== REGION_DIM && !catalog.dimensions[d.id]).map((d) => d.id);

export function elementPath(dim: DimensionEntry, el: DimensionElement): string {
	const byKey = new Map(dim.elements.map((e) => [e.key, e]));
	const names = [el.name];
	for (let p = el.parent; p !== null; p = byKey.get(p)?.parent ?? null) {
		const parent = byKey.get(p);
		if (!parent) break;
		names.unshift(parent.name);
	}
	return names.join(" > ");
}

/** Match a dimension by id or by (accent-insensitive) name: "Sexe", "milieu", "OBJ6958129". */
export function findDimension(ds: DatasetEntry, label: string): DimensionEntry | undefined {
	const dims = ownDimensions(ds);
	const n = normalize(label);
	return dims.find((d) => d.id === label) ?? dims.find((d) => normalize(d.name) === n) ?? dims.find((d) => normalize(d.name).includes(n));
}

export type ElementResolution = { ok: true; elements: DimensionElement[] } | { ok: false; error: string; candidates: string[] };

/** Resolve element labels/keys within one dimension. "*" selects every element. */
export function resolveElements(dim: DimensionEntry, values: string[]): ElementResolution {
	if (values.length === 1 && values[0] === "*") return { ok: true, elements: dim.elements };
	const out: DimensionElement[] = [];
	for (const v of values) {
		const n = normalize(v);
		const byKey = /^\d+$/.test(v.trim()) ? dim.elements.find((e) => e.key === Number(v)) : undefined;
		const exact = dim.elements.filter((e) => normalize(e.name) === n || normalize(e.full_name ?? "") === n);
		const partial = dim.elements.filter((e) => normalize(e.name).includes(n) || normalize(e.full_name ?? "").includes(n));
		const hit = byKey ?? (exact.length === 1 ? exact[0] : exact.length === 0 && partial.length === 1 ? partial[0] : undefined);
		if (!hit) {
			const pool = exact.length ? exact : partial.length ? partial : dim.elements;
			return {
				ok: false,
				error: `"${v}" ${exact.length + partial.length ? "is ambiguous" : "not found"} in dimension "${dim.name}" (${dim.id}).`,
				candidates: pool.slice(0, 30).map((e) => `${e.key}: ${elementPath(dim, e)}`),
			};
		}
		if (!out.includes(hit)) out.push(hit);
	}
	return { ok: true, elements: out };
}

/** Default selection for an unfiltered dimension: its top-level elements (usually "Total"). */
export const defaultElements = (dim: DimensionEntry) => dim.elements.filter((e) => e.parent === null);

export interface DatasetQueryPlan {
	ds: DatasetEntry;
	selections: { dim: DimensionEntry; elements: DimensionElement[]; defaulted: boolean }[];
	regions: RegionEntry[];
	where: Record<string, number[]>;
	seriesCount: number;
}

export type PlanResult = { ok: true; plan: DatasetQueryPlan } | { ok: false; error: string; details?: Record<string, unknown> };

export const MAX_SERIES = 120;

/**
 * Turn user filters into a GetData selection. INS rejects queries that omit a
 * dimension ("IncorrectRequest"), so every dimension gets a selection: the
 * user's, or the top-level elements by default.
 */
export function planDatasetQuery(ds: DatasetEntry, filters: Record<string, string[]>, regionInputs: string[]): PlanResult {
	if (ds.id === MAIN_SOURCE.id) {
		return { ok: false, error: "C_NSO is the main socio-economic database: use search_indicators + get_series / compare_regions for it." };
	}
	const missing = missingDimensions(ds);
	if (missing.length) {
		return { ok: false, error: `The snapshot is missing dimension(s) ${missing.join(", ")} for this dataset; rebuild the catalog (npm run build-index).` };
	}

	const dims = ownDimensions(ds);
	const used = new Set<string>();
	const selections: DatasetQueryPlan["selections"] = [];
	for (const [label, values] of Object.entries(filters)) {
		const dim = findDimension(ds, label);
		if (!dim) {
			return {
				ok: false,
				error: `Dataset ${ds.id} has no dimension "${label}".`,
				details: { dimensions: dims.map((d) => ({ id: d.id, name: d.name })) },
			};
		}
		const r = resolveElements(dim, values);
		if (!r.ok) return { ok: false, error: r.error, details: { candidates: r.candidates } };
		selections.push({ dim, elements: r.elements, defaulted: false });
		used.add(dim.id);
	}
	for (const dim of dims) {
		if (!used.has(dim.id)) selections.push({ dim, elements: defaultElements(dim), defaulted: true });
	}

	const regions: RegionEntry[] = [];
	if (hasRegionDim(ds)) {
		for (const input of regionInputs.length ? regionInputs : ["Tunisie"]) {
			const r = resolveRegion(input);
			if (!r.ok) return { ok: false, error: r.reason, details: { candidates: r.candidates.map(regionSummary) } };
			regions.push(r.region);
		}
	}

	const seriesCount = selections.reduce((n, s) => n * s.elements.length, Math.max(regions.length, 1));
	if (seriesCount > MAX_SERIES) {
		return {
			ok: false,
			error: `This selection would return up to ${seriesCount} series (limit ${MAX_SERIES}). Narrow the filters.`,
			details: { selection_sizes: Object.fromEntries(selections.map((s) => [s.dim.name, s.elements.length])) },
		};
	}

	const where: Record<string, number[]> = {};
	if (regions.length) where[REGION_DIM] = regions.map((r) => r.key);
	for (const s of selections) where[s.dim.id] = s.elements.map((e) => e.key);
	return { ok: true, plan: { ds, selections, regions, where, seriesCount } };
}

export function describeDataset(ds: DatasetEntry) {
	const dims = ownDimensions(ds);
	return {
		id: ds.id,
		name: ds.name,
		description: ds.description || null,
		declared_years: ds.start_year && ds.end_year ? `${ds.start_year}-${ds.end_year}` : null,
		has_region_dimension: hasRegionDim(ds),
		dimensions: dims.map((d) => ({
			id: d.id,
			name: d.name,
			last_updated: d.last_updated,
			default_if_unfiltered: defaultElements(d).map((e) => e.name),
			elements: d.elements.map((e) => ({
				key: e.key,
				name: e.name,
				...(e.full_name ? { full_name: e.full_name } : {}),
				...(e.unit ? { unit: e.unit } : {}),
				...(e.parent !== null ? { parent_key: e.parent } : {}),
			})),
		})),
		...(missingDimensions(ds).length ? { missing_dimensions: missingDimensions(ds) } : {}),
		usage: hasRegionDim(ds)
			? `query_dataset with filters by dimension name, e.g. {"${dims[0]?.name ?? "Dimension"}": ["${dims[0]?.elements[0]?.name ?? "..."}"]}, and regions by name (default: national, key ${COUNTRY_KEY}).`
			: `query_dataset with filters by dimension name; this dataset has no region dimension.`,
	};
}
