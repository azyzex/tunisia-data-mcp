// Turns raw INS observations into the clean, explicit JSON returned by tools.
// Rules: never fill gaps, always say how old the data is, always state unit
// and scale as separate fields.

import type { RawObservation } from "./ins/parse";

export type Frequency = RawObservation["frequency"];

export interface Observation {
	period: string;
	value: number | null; // null = INS has no value for this period (gap)
}

/** Scale codes from the UNITS dimension. INS only uses "1" in C_NSO today. */
const SCALES: Record<string, string> = {
	"1": "×1 — values are expressed directly in the unit (no thousands/millions multiplier)",
};

export function describeScale(code: string | undefined): string {
	if (code === undefined) return "not specified by INS";
	return SCALES[code] ?? `unknown INS scale code "${code}" — interpret values with care`;
}

/** Ordinal for a normalized period, used to detect gaps. */
function periodIndex(period: string, freq: Frequency): number | null {
	const y = Number(period.slice(0, 4));
	switch (freq) {
		case "annual":
			return y;
		case "monthly":
			return y * 12 + Number(period.slice(5, 7)) - 1;
		case "quarterly":
			return y * 4 + Number(period.slice(6)) - 1;
		case "half-yearly":
			return y * 2 + Number(period.slice(6)) - 1;
		default:
			return null; // daily: gaps are not meaningful (weekends, holidays)
	}
}

function periodFromIndex(i: number, freq: Frequency): string {
	switch (freq) {
		case "annual":
			return String(i);
		case "monthly":
			return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
		case "quarterly":
			return `${Math.floor(i / 4)}-Q${(i % 4) + 1}`;
		default:
			return `${Math.floor(i / 2)}-H${(i % 2) + 1}`;
	}
}

export interface CleanSeries {
	frequency: Frequency;
	first_period: string | null;
	last_period: string | null;
	observation_count: number;
	observations: Observation[];
	missing_periods: string[];
	scale: string;
}

/**
 * Build one series from observations of a single frequency, restricted to
 * [fromYear, toYear]. Periods between the first and last real observation
 * that INS doesn't provide are inserted with value null and listed in
 * missing_periods.
 */
export function buildSeries(obs: RawObservation[], freq: Frequency, fromYear?: number, toYear?: number): CleanSeries {
	const inRange = obs
		.filter((o) => o.frequency === freq)
		.filter((o) => {
			const y = Number(o.period.slice(0, 4));
			return (fromYear === undefined || y >= fromYear) && (toYear === undefined || y <= toYear);
		});

	// De-duplicate by period (INS should never send duplicates; keep the first).
	const byPeriod = new Map<string, RawObservation>();
	for (const o of inRange) if (!byPeriod.has(o.period)) byPeriod.set(o.period, o);
	const sorted = [...byPeriod.values()].sort((a, b) => a.period.localeCompare(b.period));

	const observations: Observation[] = [];
	const missing: string[] = [];
	let prev: number | null = null;
	for (const o of sorted) {
		const idx = periodIndex(o.period, freq);
		if (idx !== null && prev !== null) {
			for (let i = prev + 1; i < idx; i++) {
				const p = periodFromIndex(i, freq);
				observations.push({ period: p, value: null });
				missing.push(p);
			}
		}
		observations.push({ period: o.period, value: o.value });
		prev = idx;
	}

	const scaleCodes = new Set(sorted.map((o) => o.dims.UNITS));
	const scale =
		scaleCodes.size <= 1 ? describeScale([...scaleCodes][0]) : `mixed INS scale codes (${[...scaleCodes].join(", ")}) — values may not be comparable`;

	return {
		frequency: freq,
		first_period: sorted[0]?.period ?? null,
		last_period: sorted.at(-1)?.period ?? null,
		observation_count: sorted.length,
		observations,
		missing_periods: missing,
		scale,
	};
}

/** Frequencies present in a set of observations, most granular first. */
export function frequenciesOf(obs: RawObservation[]): Frequency[] {
	const order: Frequency[] = ["daily", "monthly", "quarterly", "half-yearly", "annual"];
	const present = new Set(obs.map((o) => o.frequency));
	return order.filter((f) => present.has(f));
}

/**
 * Human-readable warnings so a model never presents old data as current.
 * `now` is injectable for tests.
 */
export function freshnessWarnings(
	series: Pick<CleanSeries, "last_period" | "missing_periods">,
	metadataUpdated: string | undefined,
	now = new Date(),
): string[] {
	const warnings: string[] = [];
	const year = now.getUTCFullYear();
	if (series.last_period) {
		const lastYear = Number(series.last_period.slice(0, 4));
		if (lastYear <= year - 3) {
			warnings.push(
				`The most recent value is for ${series.last_period}. This is not current data; say so explicitly when citing it.`,
			);
		}
		if (lastYear > year) {
			warnings.push(
				`Series extends to ${series.last_period}, beyond the current year: values after ${year} are projections, not observations.`,
			);
		}
	}
	if (series.missing_periods.length) {
		warnings.push(
			`INS has no value for ${series.missing_periods.length} period(s) inside the range (${summarize(series.missing_periods)}). They are returned as null; do not interpolate them silently.`,
		);
	}
	if (metadataUpdated && Number(metadataUpdated.slice(0, 4)) <= year - 5) {
		warnings.push(`INS last updated this indicator on ${metadataUpdated}.`);
	}
	return warnings;
}

function summarize(periods: string[]): string {
	return periods.length <= 6 ? periods.join(", ") : `${periods.slice(0, 5).join(", ")}, … ${periods.at(-1)}`;
}

export interface SeriesSummary {
	latest: Observation | null;
	previous: Observation | null; // previous period that has a value
	change_from_previous: number | null;
	pct_change_from_previous: number | null;
	same_period_last_year?: Observation | null; // monthly/quarterly/half-yearly only
	pct_change_year_on_year?: number | null;
	min: Observation | null;
	max: Observation | null;
	/** Compound annual growth rate between first and latest value (annual series, positive values only). */
	cagr_pct?: number | null;
	note: string;
}

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const pct = (a: number, b: number) => (b === 0 ? null : round(((a - b) / Math.abs(b)) * 100));

/**
 * Basic descriptive figures computed from real observations only (gaps are
 * skipped, never interpolated). Saves the model from doing arithmetic on long
 * series, which is where it makes mistakes.
 */
export function summarizeSeries(s: CleanSeries): SeriesSummary {
	const real = s.observations.filter((o): o is { period: string; value: number } => o.value !== null);
	const latest = real.at(-1) ?? null;
	const previous = real.at(-2) ?? null;
	const summary: SeriesSummary = {
		latest,
		previous,
		change_from_previous: latest && previous ? round(latest.value - previous.value, 4) : null,
		pct_change_from_previous: latest && previous ? pct(latest.value, previous.value) : null,
		min: real.reduce<Observation | null>((m, o) => (m === null || o.value < m.value! ? o : m), null),
		max: real.reduce<Observation | null>((m, o) => (m === null || o.value > m.value! ? o : m), null),
		note: "Computed on the returned range from published values only; percentage changes of rates are in % of the rate, not percentage points.",
	};
	if (latest && s.frequency !== "annual" && s.frequency !== "daily") {
		const target = `${Number(latest.period.slice(0, 4)) - 1}${latest.period.slice(4)}`;
		const ly = real.find((o) => o.period === target) ?? null;
		summary.same_period_last_year = ly;
		summary.pct_change_year_on_year = ly ? pct(latest.value, ly.value) : null;
	}
	if (s.frequency === "annual" && real.length >= 2) {
		const first = real[0];
		const years = Number(latest!.period) - Number(first.period);
		summary.cagr_pct = first.value > 0 && latest!.value > 0 && years > 0 ? round(((latest!.value / first.value) ** (1 / years) - 1) * 100) : null;
	}
	return summary;
}
