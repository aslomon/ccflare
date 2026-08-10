import { describe, expect, it } from "bun:test";
import type { TimePoint } from "@ccflare/types";
import {
	buildOverviewTimeSeries,
	getEstimatedCostNote,
	OVERVIEW_DEFAULT_RANGE,
} from "./overview-data";

function createPoint(ts: number): TimePoint {
	return {
		ts,
		hasData: true,
		requests: 4,
		tokens: 987,
		costUsd: 0.004_321,
		successRate: 100,
		errorRate: 0,
		cacheHitRate: 0,
		avgResponseTime: 25.6,
		avgTokensPerSecond: 12.5,
	};
}

describe("buildOverviewTimeSeries", () => {
	it("uses seven days as the Overview default", () => {
		expect(OVERVIEW_DEFAULT_RANGE).toBe("7d");
	});

	it("includes the date in seven-day labels", () => {
		const timestamp = new Date(2026, 3, 10, 12).getTime();

		const result = buildOverviewTimeSeries([createPoint(timestamp)], "7d");

		expect(result[0]?.time).toBe("Apr 10, 12:00");
	});

	it("preserves sub-cent cost precision and token totals", () => {
		const timestamp = new Date(2026, 3, 10, 12).getTime();

		const result = buildOverviewTimeSeries([createPoint(timestamp)], "7d");

		expect(result[0]?.cost).toBe(0.004_321);
		expect(result[0]?.tokens).toBe(987);
	});
});

describe("getEstimatedCostNote", () => {
	it("makes partial pricing coverage explicit", () => {
		expect(getEstimatedCostNote(2)).toBe("2 requests not priced");
		expect(getEstimatedCostNote(1)).toBe("1 request not priced");
		expect(getEstimatedCostNote(0)).toBeUndefined();
	});
});
