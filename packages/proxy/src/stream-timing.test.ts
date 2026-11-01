import { expect, test } from "bun:test";
import { calculateRequestTimings, calculateStreamSpeed } from "./stream-timing";

test("uses the observed stream interval without inventing a one-millisecond duration", () => {
	expect(calculateStreamSpeed(100, 1_000, 3_000)).toBe(50);
	expect(calculateStreamSpeed(100, 1_000, 1_000)).toBeNull();
	expect(calculateStreamSpeed(100, undefined, 3_000)).toBeNull();
	expect(calculateStreamSpeed(0, 1_000, 3_000)).toBeNull();
	expect(calculateStreamSpeed(100, 3_000, 1_000)).toBeNull();
	expect(
		calculateStreamSpeed(Number.POSITIVE_INFINITY, 1_000, 3_000),
	).toBeNull();
});

test("includes hidden reasoning generation in effective output throughput", () => {
	const result = calculateRequestTimings(
		{
			timestamp: 900,
			upstreamRequestStartedAt: 1_000,
			responseHeadersReceivedAt: 1_100,
		},
		31_000,
		3_000,
		30_800,
		31_000,
	);
	expect(result.outputTokensPerSecond).toBe(100);
	expect(result.streamingDurationMs).toBe(200);
	expect(result.ttftMs).toBe(29_900);
	expect(result.proxyOverheadMs).toBe(100);
	expect(result.upstreamTtfbMs).toBe(100);
});

test("keeps throughput unavailable without upstream start and completion timestamps", () => {
	expect(
		calculateRequestTimings({ timestamp: 1_000 }, 3_000, 100)
			.outputTokensPerSecond,
	).toBeNull();
	expect(
		calculateRequestTimings(
			{ timestamp: 1_000, upstreamRequestStartedAt: 1_100 },
			undefined,
			100,
		).outputTokensPerSecond,
	).toBeNull();
});
