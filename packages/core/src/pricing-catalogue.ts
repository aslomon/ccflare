import { z } from "zod";

const price = z.number().finite().nonnegative();
const rates = {
	input: price.optional(),
	output: price.optional(),
	cache_read: price.optional(),
	cache_write: price.optional(),
};
export const modelCostSchema = z
	.object({
		...rates,
		tiers: z
			.array(
				z.object({
					...rates,
					tier: z.object({
						type: z.literal("context"),
						size: z.number().int().positive(),
						inclusive: z.boolean().optional(),
					}),
				}),
			)
			.optional(),
	})
	.passthrough();
export const pricingCatalogueSchema = z.record(
	z
		.object({
			models: z
				.record(
					z
						.object({
							id: z.string().min(1),
							name: z.string().min(1),
							cost: modelCostSchema.optional(),
						})
						.passthrough(),
				)
				.optional(),
		})
		.passthrough(),
);
export type PricingCatalogue = z.infer<typeof pricingCatalogueSchema>;
export type ModelCost = z.infer<typeof modelCostSchema>;

export function selectContextCost(cost: ModelCost, prompt: number): ModelCost {
	let rates = cost;
	for (const tier of [...(cost.tiers ?? [])].sort(
		(left, right) => left.tier.size - right.tier.size,
	)) {
		if (
			prompt > tier.tier.size ||
			(tier.tier.inclusive && prompt === tier.tier.size)
		) {
			rates = {
				...cost,
				input: tier.input ?? cost.input,
				output: tier.output ?? cost.output,
				cache_read: tier.cache_read ?? cost.cache_read,
				cache_write: tier.cache_write ?? cost.cache_write,
			};
		}
	}
	return rates;
}

export function findModelCost(
	pricing: PricingCatalogue,
	model: string,
): ModelCost | null {
	const id = model.startsWith("grok-") ? model.replace(/-build$/, "") : model;
	const provider = /^claude-/.test(id)
		? "anthropic"
		: /^(gpt-|o[134](?:-|$))/.test(id)
			? "openai"
			: /^glm-/.test(id)
				? "zai"
				: /^grok-/.test(id)
					? "xai"
					: null;
	if (provider) return pricing[provider]?.models?.[id]?.cost ?? null;
	const matches = Object.values(pricing).flatMap((entry) => {
		const cost = entry.models?.[id]?.cost;
		return cost ? [cost] : [];
	});
	return matches.length === 1 ? matches[0] : null;
}
