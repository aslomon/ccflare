import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	estimateCostResult,
	estimateCostUSD,
	setPricingLogger,
} from "./pricing";

const originalFetch = globalThis.fetch;
const originalRefreshHours = process.env.CF_PRICING_REFRESH_HOURS;

function mockCatalogue(catalogue: unknown): void {
	globalThis.fetch = Object.assign(
		async () =>
			new Response(JSON.stringify(catalogue), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		{ preconnect: originalFetch.preconnect },
	);
}

function validCatalogue(inputCost = 2.5): unknown {
	return {
		openai: {
			name: "OpenAI",
			models: {
				"gpt-4o": {
					id: "gpt-4o",
					name: "GPT-4o",
					extraProviderField: true,
					cost: {
						input: inputCost,
						output: 10,
						cache_read: 1.25,
					},
				},
			},
		},
	};
}

beforeEach(() => {
	process.env.CF_PRICING_REFRESH_HOURS = "-1";
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalRefreshHours === undefined) {
		delete process.env.CF_PRICING_REFRESH_HOURS;
	} else {
		process.env.CF_PRICING_REFRESH_HOURS = originalRefreshHours;
	}
});

describe("estimateCostResult", () => {
	it("stores mocked catalogues in a separate test-process cache", async () => {
		mockCatalogue(validCatalogue());
		await estimateCostResult("gpt-4o", { inputTokens: 1 });
		const cache = Bun.file(
			join(tmpdir(), `ccflare-test-${process.pid}`, "api-pricing.json"),
		);
		expect(await cache.exists()).toBe(true);
	});

	it("returns an estimated models.dev cost for a validated model", async () => {
		mockCatalogue(validCatalogue());

		await expect(
			estimateCostResult("gpt-4o", {
				inputTokens: 127,
				cacheReadInputTokens: 18_688,
				outputTokens: 431,
			}),
		).resolves.toEqual({
			costUsd: (127 * 2.5 + 18_688 * 1.25 + 431 * 10) / 1_000_000,
			status: "estimated",
			source: "models.dev",
		});
	});

	it("distinguishes a legitimate zero price from unavailable pricing", async () => {
		mockCatalogue(validCatalogue(0));

		await expect(
			estimateCostResult("gpt-4o", { inputTokens: 10_000 }),
		).resolves.toEqual({
			costUsd: 0,
			status: "estimated",
			source: "models.dev",
		});
	});

	it("marks an unknown model as unavailable", async () => {
		mockCatalogue(validCatalogue());

		await expect(
			estimateCostResult("not-a-model", { inputTokens: 1_000 }),
		).resolves.toEqual({
			costUsd: null,
			status: "unavailable",
			source: "none",
		});
	});

	it("marks pricing as unavailable while models.dev is offline", async () => {
		globalThis.fetch = Object.assign(
			async () => {
				throw new Error("offline");
			},
			{ preconnect: originalFetch.preconnect },
		);

		await expect(
			estimateCostResult("gpt-4o", { inputTokens: 1_000 }),
		).resolves.toEqual({
			costUsd: null,
			status: "unavailable",
			source: "none",
		});
	});

	it.each([
		["negative price", validCatalogue(-1)],
		[
			"string price",
			{
				openai: {
					models: {
						"gpt-4o": {
							id: "gpt-4o",
							name: "GPT-4o",
							cost: { input: "2.5", output: 10 },
						},
					},
				},
			},
		],
		["invalid root", []],
	])("rejects an invalid catalogue with a %s", async (_label, catalogue) => {
		mockCatalogue(catalogue);

		await expect(
			estimateCostResult("gpt-4o", { inputTokens: 1_000 }),
		).resolves.toEqual({
			costUsd: null,
			status: "unavailable",
			source: "none",
		});
	});

	it("does not estimate a used token category without a catalogue price", async () => {
		mockCatalogue({
			openai: {
				models: {
					"gpt-4o": {
						id: "gpt-4o",
						name: "GPT-4o",
						cost: { input: 2.5 },
					},
				},
			},
		});

		await expect(
			estimateCostResult("gpt-4o", { outputTokens: 1 }),
		).resolves.toEqual({
			costUsd: null,
			status: "unavailable",
			source: "none",
		});
	});

	it.each([
		["negative", { inputTokens: -1 }],
		["fractional", { outputTokens: 1.5 }],
		["non-finite", { cacheReadInputTokens: Number.POSITIVE_INFINITY }],
	])("rejects %s token counts", async (_label, tokens) => {
		mockCatalogue(validCatalogue());

		await expect(estimateCostResult("gpt-4o", tokens)).resolves.toEqual({
			costUsd: null,
			status: "unavailable",
			source: "none",
		});
	});

	it("warns only once per model when pricing is unavailable", async () => {
		const warnings: string[] = [];
		setPricingLogger({
			warn(message) {
				warnings.push(message);
			},
		});
		mockCatalogue(validCatalogue());

		await estimateCostResult("missing-for-warning", { inputTokens: 1 });
		await estimateCostResult("missing-for-warning", { inputTokens: 1 });

		expect(warnings).toEqual(["Pricing unavailable for model %s"]);
	});
});

describe("estimateCostUSD", () => {
	it("keeps the legacy numeric return for compatible callers", async () => {
		mockCatalogue(validCatalogue());

		await expect(
			estimateCostUSD("gpt-4o", { inputTokens: 1_000 }),
		).resolves.toBe(0.0025);
	});

	it("keeps the legacy zero fallback when pricing is unavailable", async () => {
		mockCatalogue(validCatalogue());

		await expect(
			estimateCostUSD("unknown", { inputTokens: 1_000 }),
		).resolves.toBe(0);
	});
});
