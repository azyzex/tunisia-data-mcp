// Shape of src/data/catalog.json (produced by scripts/build-index.ts).

export interface DatasetEntry {
	id: string;
	name: string;
	description: string;
	start_year: number | null;
	end_year: number | null;
	dimensions: { id: string; name: string; type: string | null; last_updated: string | null }[];
}

export interface IndicatorEntry {
	key: number;
	name: string;
	full_name?: string;
	parent: number | null;
	is_category: boolean;
	unit?: string;
	last_updated?: string; // YYYY-MM-DD, from the INS TIMESTAMP attribute
	source?: string;
	note?: string;
	methodology?: string;
}

export type RegionLevel = "country" | "region" | "governorate" | "delegation" | "sector";

export interface RegionEntry {
	key: number;
	name: string;
	level: RegionLevel;
	parent: number | null;
	iso?: string;
}

/** Shape of src/data/availability.json (scripts/build-availability.ts). */
export interface AvailabilityEntry {
	f: string; // frequency codes present: A annual, M monthly, Q quarterly, H half-yearly, D daily
	first: string; // first period (national if available, else any probed region)
	last: string; // latest period, same basis
	nat: boolean; // has national values
	gov: number; // how many of the probed governorates have values (0..4)
	del: boolean; // has values for at least one probed delegation
}

export interface Availability {
	built_at: string;
	probed: { national: number; governorates: number[]; delegations: number[] };
	indicators: Record<string, AvailabilityEntry>; // absent key = no data found
}

/** Shape of src/data/opendata.json (scripts/build-opendata.ts). */
export interface OpenDataset {
	id: string; // CKAN slug, also the URL path segment
	title: string;
	notes?: string;
	org: string | null;
	tags: string[];
	modified: string; // YYYY-MM-DD, metadata last modified
	period?: string;
	place?: string;
	license: string | null;
	resources: { id: string; name: string; format: string; url: string; datastore: boolean }[];
}

export interface OpenDataSnapshot {
	built_at: string;
	total_on_portal: number;
	datasets: OpenDataset[];
}

export interface DimensionElement {
	key: number;
	name: string;
	parent: number | null;
	full_name?: string;
	unit?: string;
}

export interface DimensionEntry {
	id: string;
	name: string;
	last_updated: string | null;
	elements: DimensionElement[];
}

export interface Catalog {
	built_at: string;
	datasets: DatasetEntry[];
	dimensions: Record<string, DimensionEntry>; // non-shared dimensions of all datasets

	indicators: IndicatorEntry[];
	regions: RegionEntry[];
}
