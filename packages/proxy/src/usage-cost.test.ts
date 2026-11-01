import { describe, expect, it } from "bun:test";
import { resolveUsageCost } from "./usage-cost";

describe("resolveUsageCost", () => {
	it("keeps an unknown model unpriced instead of recording a false zero", async () => {
		let estimatorCalls = 0;
		const result = await resolveUsageCost(
			"unknown",
			{ inputTokens: 100, outputTokens: 50 },
			async () => {
				estimatorCalls += 1;
				return { costUsd: 0, status: "estimated", source: "models.dev" };
			},
		);

		expect(result).toEqual({
			costUsd: null,
			status: "unavailable",
			source: "none",
		});
		expect(estimatorCalls).toBe(0);
	});

	it("preserves unavailable catalogue results for known models", async () => {
		const result = await resolveUsageCost(
			"model-without-price",
			{ inputTokens: 100 },
			async () => ({ costUsd: null, status: "unavailable", source: "none" }),
		);

		expect(result.costUsd).toBeNull();
		expect(result.status).toBe("unavailable");
	});
});

it("records zero local API fees without pricing catalogue lookup", async () => {
	const result = await resolveUsageCost(
		"qwen/test",
		{ inputTokens: 100, outputTokens: 50 },
		async () => {
			throw new Error("must not fetch cloud pricing");
		},
		"lmstudio",
	);
	expect(result.costUsd).toBe(0);
	expect(result.source).toBe("local");
});
