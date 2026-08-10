import type {
	AccountProvider,
	AnalyticsStatusFilter,
	TimeRange,
} from "@ccflare/types";
import type { AnalyticsQueryOptions } from "./repositories/analytics.repository";

interface AnalyticsRangeConfig {
	durationMs: number;
	bucketMs: number;
	bucketLabel: string;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const ANALYTICS_RANGE_CONFIG: Record<TimeRange, AnalyticsRangeConfig> = {
	"1h": {
		durationMs: HOUR_MS,
		bucketMs: 60 * 1000,
		bucketLabel: "1m",
	},
	"6h": {
		durationMs: 6 * HOUR_MS,
		bucketMs: 5 * 60 * 1000,
		bucketLabel: "5m",
	},
	"24h": {
		durationMs: DAY_MS,
		bucketMs: HOUR_MS,
		bucketLabel: "1h",
	},
	"7d": {
		durationMs: 7 * DAY_MS,
		bucketMs: HOUR_MS,
		bucketLabel: "1h",
	},
	"30d": {
		durationMs: 30 * DAY_MS,
		bucketMs: DAY_MS,
		bucketLabel: "1d",
	},
};

export interface BuildAnalyticsQueryInput {
	range: TimeRange;
	now?: number;
	accounts?: string[];
	models?: string[];
	providers?: AccountProvider[];
	status?: AnalyticsStatusFilter;
	includeModelBreakdown?: boolean;
}

export interface BuiltAnalyticsQuery {
	endMs: number;
	meta: {
		range: TimeRange;
		bucket: string;
	};
	options: AnalyticsQueryOptions;
}

export function buildAnalyticsQuery(
	input: BuildAnalyticsQueryInput,
): BuiltAnalyticsQuery {
	const now = input.now ?? Date.now();
	const config = ANALYTICS_RANGE_CONFIG[input.range];

	return {
		endMs: now,
		meta: {
			range: input.range,
			bucket: config.bucketLabel,
		},
		options: {
			startMs: now - config.durationMs,
			bucketMs: config.bucketMs,
			accounts: input.accounts,
			models: input.models,
			providers: input.providers,
			status: input.status,
			includeModelBreakdown: input.includeModelBreakdown,
		},
	};
}
