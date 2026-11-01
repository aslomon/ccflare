import { z } from "zod";
import type { ModelCost, PricingCatalogue } from "./pricing-catalogue";

const price = z
	.string()
	.regex(/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i)
	.transform((value) => {
		const [coefficient, exponent = "0"] = value.toLowerCase().split("e");
		return Number(`${coefficient}e${Number(exponent) + 6}`);
	})
	.pipe(z.number().finite().nonnegative());
const rates = {
	prompt: price.optional(),
	completion: price.optional(),
	input_cache_read: price.optional(),
	input_cache_write: price.optional(),
};
const modelSchema = z.object({
	id: z.string().regex(/^[a-z0-9-]+\/[a-z0-9][a-z0-9._/:+-]*$/i),
	pricing: z.object({
		...rates,
		overrides: z
			.array(
				z.object({ ...rates, min_prompt_tokens: z.number().int().positive() }),
			)
			.optional(),
	}),
});
const catalogueSchema = z.object({ data: z.array(z.unknown()).max(10000) });
type Rates = z.infer<typeof modelSchema>["pricing"];
type Model = z.infer<typeof modelSchema>;

function convertRates(value: Rates): ModelCost {
	return {
		input: value.prompt,
		output: value.completion,
		cache_read: value.input_cache_read,
		cache_write: value.input_cache_write,
	};
}

function addModel(result: PricingCatalogue, model: Model): void {
	const [rawProvider, ...parts] = model.id.split("/");
	const provider =
		rawProvider === "x-ai"
			? "xai"
			: rawProvider === "z-ai"
				? "zai"
				: rawProvider;
	const id = parts.join("/");
	if (!id || id.includes(":")) return;
	const cost = convertRates(model.pricing);
	if (provider === "zai" && cost.cache_write === undefined)
		cost.cache_write = 0;
	cost.tiers = model.pricing.overrides?.map((tier) => ({
		...convertRates(tier),
		tier: {
			type: "context",
			size: tier.min_prompt_tokens,
			inclusive: provider === "xai",
		},
	}));
	if (!Object.hasOwn(result, provider)) result[provider] = { models: {} };
	const models = result[provider].models;
	if (!models) return;
	models[id] = { id, name: id, cost };
	const native = id.replace(
		/^(claude-(?:opus|sonnet|haiku)-\d+)\.(\d+)/,
		"$1-$2",
	);
	models[native] = models[id];
}

export function parseOpenRouterCatalogue(
	value: unknown,
): PricingCatalogue | null {
	const parsed = catalogueSchema.safeParse(value);
	if (!parsed.success) return null;
	const result: PricingCatalogue = {};
	for (const entry of parsed.data.data) {
		const model = modelSchema.safeParse(entry);
		if (model.success) addModel(result, model.data);
	}
	return Object.keys(result).length ? result : null;
}
