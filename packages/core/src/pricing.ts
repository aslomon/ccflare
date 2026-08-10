import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { TIME_CONSTANTS } from "./constants";

export interface TokenBreakdown {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
}

export interface CostEstimateResult {
	readonly costUsd: number | null;
	readonly status: "estimated" | "unavailable";
	readonly source: "models.dev" | "none";
}

const PriceSchema = z.number().finite().nonnegative();
const TokenCountSchema = z
	.number()
	.int()
	.nonnegative()
	.max(Number.MAX_SAFE_INTEGER);

const ModelCostSchema = z
	.object({
		input: PriceSchema.optional(),
		output: PriceSchema.optional(),
		cache_read: PriceSchema.optional(),
		cache_write: PriceSchema.optional(),
	})
	.passthrough();

const ModelDefinitionSchema = z
	.object({
		id: z.string().min(1),
		name: z.string().min(1),
		cost: ModelCostSchema.optional(),
	})
	.passthrough();

const ProviderSchema = z
	.object({
		models: z.record(ModelDefinitionSchema).optional(),
	})
	.passthrough();

const PricingCatalogueSchema = z.record(ProviderSchema);
const TokenBreakdownSchema = z.object({
	inputTokens: TokenCountSchema.optional(),
	outputTokens: TokenCountSchema.optional(),
	cacheReadInputTokens: TokenCountSchema.optional(),
	cacheCreationInputTokens: TokenCountSchema.optional(),
});

type ApiResponse = z.infer<typeof PricingCatalogueSchema>;
type ModelCost = z.infer<typeof ModelCostSchema>;

interface Logger {
	warn(message: string, ...args: unknown[]): void;
}

function parseCatalogue(data: unknown): ApiResponse | null {
	const result = PricingCatalogueSchema.safeParse(data);
	return result.success ? result.data : null;
}

function unavailableCost(): CostEstimateResult {
	return { costUsd: null, status: "unavailable", source: "none" };
}

class PriceCatalogue {
	private static instance: PriceCatalogue;
	private priceData: ApiResponse | null = null;
	private lastFetch = 0;
	private warnedModels = new Set<string>();
	private logger: Logger | null = null;

	private constructor() {}

	setLogger(logger: Logger): void {
		this.logger = logger;
	}

	static get(): PriceCatalogue {
		if (!PriceCatalogue.instance) {
			PriceCatalogue.instance = new PriceCatalogue();
		}
		return PriceCatalogue.instance;
	}

	private getCacheDir(): string {
		return join(tmpdir(), "ccflare");
	}

	private getCachePath(): string {
		return join(this.getCacheDir(), "models.dev.json");
	}

	private getCacheDurationMs(): number {
		const hours = Number(process.env.CF_PRICING_REFRESH_HOURS) || 24;
		return hours * TIME_CONSTANTS.HOUR;
	}

	private async ensureCacheDir(): Promise<void> {
		try {
			await fs.mkdir(this.getCacheDir(), { recursive: true });
		} catch (error) {
			this.logger?.warn("Failed to create cache directory: %s", error);
		}
	}

	private async loadFromCache(): Promise<ApiResponse | null> {
		try {
			const cachePath = this.getCachePath();
			const stats = await fs.stat(cachePath);
			const age = Date.now() - stats.mtime.getTime();
			if (age >= this.getCacheDurationMs()) {
				return null;
			}
			const content = await fs.readFile(cachePath, "utf-8");
			const data: unknown = JSON.parse(content);
			return parseCatalogue(data);
		} catch {
			return null;
		}
	}

	private async saveToCache(data: ApiResponse): Promise<void> {
		try {
			await this.ensureCacheDir();
			await fs.writeFile(this.getCachePath(), JSON.stringify(data, null, 2));
		} catch (error) {
			this.logger?.warn("Failed to save pricing cache: %s", error);
		}
	}

	private async fetchRemote(): Promise<ApiResponse | null> {
		try {
			const response = await fetch("https://models.dev/api.json");
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}
			const rawData: unknown = await response.json();
			const data = parseCatalogue(rawData);
			if (!data) {
				throw new Error("Invalid models.dev pricing catalogue");
			}
			await this.saveToCache(data);
			return data;
		} catch (error) {
			this.logger?.warn("Failed to fetch pricing data: %s", error);
			return null;
		}
	}

	async getPricing(): Promise<ApiResponse | null> {
		if (
			this.priceData &&
			Date.now() - this.lastFetch < this.getCacheDurationMs()
		) {
			return this.priceData;
		}

		const data = (await this.fetchRemote()) ?? (await this.loadFromCache());
		if (data) {
			this.priceData = data;
			this.lastFetch = Date.now();
		}
		return data;
	}

	warnOnce(modelId: string): void {
		if (this.warnedModels.has(modelId)) {
			return;
		}
		this.warnedModels.add(modelId);
		this.logger?.warn("Pricing unavailable for model %s", modelId);
	}
}

/** Set the logger for pricing warnings. */
export function setPricingLogger(logger: Logger): void {
	PriceCatalogue.get().setLogger(logger);
}

function findModelCost(
	pricing: ApiResponse,
	modelId: string,
): ModelCost | null {
	for (const provider of Object.values(pricing)) {
		const cost = provider.models?.[modelId]?.cost;
		if (cost) {
			return cost;
		}
	}
	return null;
}

function categoryCostUnits(
	tokenCount: number | undefined,
	pricePerMillion: number | undefined,
): number | null {
	if (!tokenCount) {
		return 0;
	}
	if (pricePerMillion === undefined) {
		return null;
	}
	return tokenCount * pricePerMillion;
}

function calculateCost(cost: ModelCost, tokens: TokenBreakdown): number | null {
	const categoryCosts = [
		categoryCostUnits(tokens.inputTokens, cost.input),
		categoryCostUnits(tokens.outputTokens, cost.output),
		categoryCostUnits(tokens.cacheReadInputTokens, cost.cache_read),
		categoryCostUnits(tokens.cacheCreationInputTokens, cost.cache_write),
	];
	let totalCostUnits = 0;
	for (const amount of categoryCosts) {
		if (amount === null) {
			return null;
		}
		totalCostUnits += amount;
	}
	const totalCost = totalCostUnits / 1_000_000;
	return Number.isFinite(totalCost) ? totalCost : null;
}

/** Estimate request cost from a validated models.dev catalogue. */
export async function estimateCostResult(
	modelId: string,
	tokens: TokenBreakdown,
): Promise<CostEstimateResult> {
	const catalogue = PriceCatalogue.get();
	const normalizedModelId = modelId.trim();
	const parsedTokens = TokenBreakdownSchema.safeParse(tokens);
	if (!normalizedModelId || !parsedTokens.success) {
		catalogue.warnOnce(modelId);
		return unavailableCost();
	}

	const pricing = await catalogue.getPricing();
	const cost = pricing ? findModelCost(pricing, normalizedModelId) : null;
	const costUsd = cost ? calculateCost(cost, parsedTokens.data) : null;
	if (costUsd === null) {
		catalogue.warnOnce(normalizedModelId);
		return unavailableCost();
	}

	return { costUsd, status: "estimated", source: "models.dev" };
}

/**
 * Legacy numeric estimator. Prefer estimateCostResult when unavailable pricing
 * must remain distinct from a legitimate zero-dollar estimate.
 */
export async function estimateCostUSD(
	modelId: string,
	tokens: TokenBreakdown,
): Promise<number> {
	const result = await estimateCostResult(modelId, tokens);
	return result.costUsd ?? 0;
}
