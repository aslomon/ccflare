import type { TimePoint, TimeRange } from "@ccflare/types";
import { format } from "date-fns";

export const OVERVIEW_DEFAULT_RANGE = "7d" satisfies TimeRange;

export function getEstimatedCostNote(
	unpricedRequests: number,
): string | undefined {
	if (unpricedRequests <= 0) return undefined;
	const noun = unpricedRequests === 1 ? "request" : "requests";
	return `${unpricedRequests} ${noun} not priced`;
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
