import { describe, expect, it } from "bun:test";
import type { TimePoint } from "@ccflare/types";
import { fillMissingTimeBuckets } from "./analytics-series";

const HOUR_MS = 60 * 60 * 1000;

function createPoint(ts: number, requests: number): TimePoint {
	return {
		ts,
		requests,
		tokens: requests * 10,
		costUsd: requests * 0.000_123,
		successRate: 100,
		errorRate: 0,
		cacheHitRate: 0,
		avgResponseTime: 20,
		avgTokensPerSecond: 5,
	};
}

describe("fillMissingTimeBuckets", () => {
	it("represents every hourly bucket and marks missing periods", () => {
		const startMs = Date.UTC(2026, 3, 10, 10, 30);
		const endMs = Date.UTC(2026, 3, 10, 13, 15);
		const points = [
			createPoint(Date.UTC(2026, 3, 10, 11), 2),
			createPoint(Date.UTC(2026, 3, 10, 13), 3),
		];

		const filled = fillMissingTimeBuckets(points, startMs, endMs, HOUR_MS);

		expect(filled.map((point) => point.ts)).toEqual([
			Date.UTC(2026, 3, 10, 10),
			Date.UTC(2026, 3, 10, 11),
			Date.UTC(2026, 3, 10, 12),
			Date.UTC(2026, 3, 10, 13),
		]);
		expect(filled.map((point) => point.hasData)).toEqual([
			false,
			true,
			false,
			true,
		]);
		expect(filled[1]?.costUsd).toBe(0.000_246);
		expect(filled[2]).toEqual(
			expect.objectContaining({ requests: 0, tokens: 0, costUsd: 0 }),
		);
	});

	it("does not mutate the source points", () => {
		const point = createPoint(Date.UTC(2026, 3, 10, 11), 1);

		fillMissingTimeBuckets(
			[point],
			Date.UTC(2026, 3, 10, 11),
			Date.UTC(2026, 3, 10, 11, 30),
			HOUR_MS,
		);

		expect(point.hasData).toBeUndefined();
	});
});
