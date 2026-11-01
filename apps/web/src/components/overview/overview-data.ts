import type { TimePoint, TimeRange } from "@ccflare/types";
import { format } from "date-fns";

export const OVERVIEW_DEFAULT_RANGE = "7d" satisfies TimeRange;

export function getEstimatedCostNote(unpricedRequests: number): string {
	const basis = "Current API token prices; not an invoice";
	if (unpricedRequests <= 0) return basis;
	const noun = unpricedRequests === 1 ? "request" : "requests";
	return `${basis}; ${unpricedRequests} ${noun} not priced`;
}

interface OverviewTrend {
	change: number;
	direction: "up" | "down" | "flat";
	favorable: boolean;
}

function compareMetric(
	current: number | null | undefined,
	previous: number | null | undefined,
	higherIsBetter: boolean,
): OverviewTrend | null {
	if (
		typeof current !== "number" ||
		typeof previous !== "number" ||
		previous <= 0
	)
		return null;
	const change = ((current - previous) / previous) * 100;
	return {
		change,
		direction: change > 0 ? "up" : change < 0 ? "down" : "flat",
		favorable: higherIsBetter ? change >= 0 : change <= 0,
	};
}

const trendBuckets: Record<TimeRange, { milliseconds: number; label: string }> =
	{
		"1h": { milliseconds: 60_000, label: "minute" },
		"6h": { milliseconds: 300_000, label: "5-minute period" },
		"24h": { milliseconds: 3_600_000, label: "hour" },
		"7d": { milliseconds: 3_600_000, label: "hour" },
		"30d": { milliseconds: 86_400_000, label: "day" },
	};

function completeBuckets(points: TimePoint[], bucketMs: number, now: number) {
	const currentStart = Math.floor(now / bucketMs) * bucketMs - bucketMs;
	const current = points.find(
		(point) => point.ts === currentStart && point.hasData !== false,
	);
	const previous = points.find(
		(point) => point.ts === currentStart - bucketMs && point.hasData !== false,
	);
	return { current, previous };
}

export function getOverviewTrends(
	points: TimePoint[],
	range: TimeRange,
	now = Date.now(),
) {
	const bucket = trendBuckets[range];
	const { current, previous } = completeBuckets(
		points,
		bucket.milliseconds,
		now,
	);
	return {
		period: `last complete ${bucket.label} vs previous ${bucket.label}`,
		requests: compareMetric(current?.requests, previous?.requests, true),
		successRate: compareMetric(
			current?.successRate,
			previous?.successRate,
			true,
		),
		responseTime: compareMetric(
			current?.avgResponseTime,
			previous?.avgResponseTime,
			false,
		),
		cost: compareMetric(current?.costUsd, previous?.costUsd, false),
		outputSpeed: compareMetric(
			current?.avgTokensPerSecond,
			previous?.avgTokensPerSecond,
			true,
		),
	};
}

export type OverviewTimeSeriesPoint = Record<string, string | number> & {
	time: string;
	requests: number;
	tokens: number;
	successRate: number;
	responseTime: number;
	cost: number;
	tokensPerSecond: number;
	observed: 0 | 1;
};

function labelPattern(range: TimeRange): string {
	if (range === "7d") return "MMM d, HH:mm";
	if (range === "30d") return "MMM d";
	return "HH:mm";
}

function toOverviewPoint(
	point: TimePoint,
	range: TimeRange,
): OverviewTimeSeriesPoint {
	return {
		time: format(new Date(point.ts), labelPattern(range)),
		requests: point.requests,
		tokens: point.tokens,
		successRate: point.successRate,
		responseTime: Math.round(point.avgResponseTime),
		cost: point.costUsd,
		tokensPerSecond: point.avgTokensPerSecond ?? 0,
		observed: point.hasData === false ? 0 : 1,
	};
}

export function buildOverviewTimeSeries(
	points: TimePoint[],
	range: TimeRange,
): OverviewTimeSeriesPoint[] {
	return points.map((point) => toOverviewPoint(point, range));
}
