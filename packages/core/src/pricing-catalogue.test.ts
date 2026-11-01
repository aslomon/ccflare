import { expect, test } from "bun:test";
import { findModelCost, selectContextCost } from "./pricing-catalogue";
import { parseOpenRouterCatalogue } from "./pricing-openrouter";

test("converts decimal and exponent prices without losing their units", () => {
	const data = parseOpenRouterCatalogue({
		data: [
			{
				id: "z-ai/glm-5.3",
				pricing: { prompt: "1.4e-6", completion: "0.0000044" },
			},
		],
	});
	if (!data) throw new Error("Expected a validated catalogue");
	expect(findModelCost(data, "glm-5.3")).toMatchObject({
		input: 1.4,
		output: 4.4,
		cache_write: 0,
	});
});

test("rejects malformed catalogues and never treats a batch price as standard", () => {
	expect(parseOpenRouterCatalogue(null)).toBeNull();
	expect(
		parseOpenRouterCatalogue({
			data: [
				{ id: "openai/gpt-6.1-sol:batch", pricing: { prompt: "0.000001" } },
				{ id: "openai/gpt-6.1-sol", pricing: { prompt: "-1" } },
				{ id: "../invalid", pricing: {} },
			],
		}),
	).toBeNull();
});

test("isolates malformed models while retaining valid rates", () => {
	const data = parseOpenRouterCatalogue({
		data: [
			{ id: "bad", pricing: {} },
			{ id: "vendor/model", pricing: { prompt: "0", completion: "0" } },
		],
	});
	if (!data) throw new Error("Expected the valid model");
	expect(findModelCost(data, "model")).toMatchObject({ input: 0, output: 0 });
	expect(findModelCost(data, "missing")).toBeNull();
});

test("refuses ambiguous vendors instead of guessing a reseller price", () => {
	expect(
		findModelCost(
			{
				first: {
					models: {
						shared: { id: "shared", name: "shared", cost: { input: 1 } },
					},
				},
				second: {
					models: {
						shared: { id: "shared", name: "shared", cost: { input: 9 } },
					},
				},
			},
			"shared",
		),
	).toBeNull();
});

test("selects the highest eligible context tier regardless of catalogue order", () => {
	const cost = selectContextCost(
		{
			input: 1,
			output: 2,
			tiers: [
				{ input: 4, tier: { type: "context", size: 200 } },
				{ input: 3, tier: { type: "context", size: 100 } },
			],
		},
		201,
	);
	expect(cost.input).toBe(4);
	expect(cost.output).toBe(2);
});
