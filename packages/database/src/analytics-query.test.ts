import { describe, expect, it } from "bun:test";
import { buildAnalyticsQuery } from "./analytics-query";

describe("buildAnalyticsQuery", () => {
	it("uses the shared bucket semantics for every supported range", () => {
		const now = new Date("2026-04-10T12:00:00.000Z").getTime();

		expect(buildAnalyticsQuery({ range: "1h", now })).toEqual(
			expect.objectContaining({
				meta: {
					range: "1h",
					bucket: "1m",
				},
				options: expect.objectContaining({
					startMs: now - 60 * 60 * 1000,
					bucketMs: 60 * 1000,
				}),
			}),
		);

		expect(buildAnalyticsQuery({ range: "6h", now })).toEqual(
			expect.objectContaining({
				meta: {
					range: "6h",
					bucket: "5m",
				},
				options: expect.objectContaining({
					startMs: now - 6 * 60 * 60 * 1000,
					bucketMs: 5 * 60 * 1000,
				}),
			}),
		);

		expect(buildAnalyticsQuery({ range: "24h", now })).toEqual(
			expect.objectContaining({
				meta: {
					range: "24h",
					bucket: "1h",
				},
				options: expect.objectContaining({
					startMs: now - 24 * 60 * 60 * 1000,
					bucketMs: 60 * 60 * 1000,
				}),
			}),
		);

		expect(buildAnalyticsQuery({ range: "7d", now })).toEqual(
			expect.objectContaining({
				meta: {
					range: "7d",
					bucket: "1h",
				},
				options: expect.objectContaining({
					startMs: now - 7 * 24 * 60 * 60 * 1000,
					bucketMs: 60 * 60 * 1000,
				}),
			}),
		);

		expect(buildAnalyticsQuery({ range: "30d", now })).toEqual(
			expect.objectContaining({
				meta: {
					range: "30d",
					bucket: "1d",
				},
				options: expect.objectContaining({
					startMs: now - 30 * 24 * 60 * 60 * 1000,
					bucketMs: 24 * 60 * 60 * 1000,
				}),
			}),
		);
	});

	it("passes filters through to repository query options", () => {
		expect(
			buildAnalyticsQuery({
				range: "24h",
				now: 1_000_000,
				accounts: ["primary", "secondary"],
				models: ["gpt-4o-mini"],
				providers: ["openai"],
				status: "error",
				includeModelBreakdown: true,
			}),
		).toEqual({
			endMs: 1_000_000,
			meta: {
				range: "24h",
				bucket: "1h",
			},
			options: {
				startMs: 1_000_000 - 24 * 60 * 60 * 1000,
				bucketMs: 60 * 60 * 1000,
				accounts: ["primary", "secondary"],
				models: ["gpt-4o-mini"],
				providers: ["openai"],
				status: "error",
				includeModelBreakdown: true,
			},
		});
	});
});
