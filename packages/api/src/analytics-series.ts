import type { TimePoint } from "@ccflare/types";

function createEmptyPoint(ts: number): TimePoint {
	return {
		ts,
		hasData: false,
		requests: 0,
		tokens: 0,
		costUsd: 0,
		successRate: 0,
		errorRate: 0,
		cacheHitRate: 0,
		avgResponseTime: 0,
		avgTokensPerSecond: null,
	};
}

function bucketStart(timestamp: number, bucketMs: number): number {
	return Math.floor(timestamp / bucketMs) * bucketMs;
}

export function fillMissingTimeBuckets(
	points: TimePoint[],
	startMs: number,
	endMs: number,
	bucketMs: number,
): TimePoint[] {
	if (bucketMs <= 0 || endMs < startMs) return [];

	const pointsByBucket = new Map(
		points.map((point) => [bucketStart(point.ts, bucketMs), point]),
	);
	const firstBucket = bucketStart(startMs, bucketMs);
	const lastBucket = bucketStart(endMs, bucketMs);
	const filled: TimePoint[] = [];

	for (let ts = firstBucket; ts <= lastBucket; ts += bucketMs) {
		const point = pointsByBucket.get(ts);
		filled.push(point ? { ...point, hasData: true } : createEmptyPoint(ts));
	}

	return filled;
}
