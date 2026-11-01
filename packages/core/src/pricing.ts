import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { readBoundedBody } from "./bounded-body";
import { TIME_CONSTANTS } from "./constants";
import {
	type PricingCatalogue as ApiResponse,
	findModelCost,
	type ModelCost,
	pricingCatalogueSchema,
	selectContextCost,
} from "./pricing-catalogue";
import { parseOpenRouterCatalogue } from "./pricing-openrouter";

export interface TokenBreakdown {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
}

export interface CostEstimateResult {
	readonly costUsd: number | null;
	readonly status: "estimated" | "unavailable";
	readonly source: "models.dev" | "openrouter" | "none" | "local";
}

const TokenCountSchema = z
	.number()
	.int()
	.nonnegative()
	.max(Number.MAX_SAFE_INTEGER);

const TokenBreakdownSchema = z.object({
	inputTokens: TokenCountSchema.optional(),
	outputTokens: TokenCountSchema.optional(),
	cacheReadInputTokens: TokenCountSchema.optional(),
	cacheCreationInputTokens: TokenCountSchema.optional(),
});

interface Logger {
	warn(message: string, ...args: unknown[]): void;
}

function parseCatalogue(data: unknown): ApiResponse | null {
	const result = pricingCatalogueSchema.safeParse(data);
	return result.success ? result.data : null;
}

function unavailableCost(): CostEstimateResult {
	return { costUsd: null, status: "unavailable", source: "none" };
}

class PriceCatalogue {
	private static instance: PriceCatalogue;
	private priceData: ApiResponse | null = null;
	private pending: Promise<ApiResponse | null> | null = null;
	private source: "openrouter" | "models.dev" = "models.dev";
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
		return join(this.getCacheDir(), "api-pricing.json");
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
			const envelope = z
				.object({
					source: z.enum(["openrouter", "models.dev"]),
					catalogue: pricingCatalogueSchema,
				})
				.safeParse(data);
			if (envelope.success) {
				this.source = envelope.data.source;
				return envelope.data.catalogue;
			}
			this.source = "models.dev";
			return parseCatalogue(data);
		} catch {
			return null;
		}
	}

	private async saveToCache(data: ApiResponse): Promise<void> {
		try {
			await this.ensureCacheDir();
			await fs.writeFile(
				this.getCachePath(),
				JSON.stringify({ source: this.source, catalogue: data }),
			);
		} catch (error) {
			this.logger?.warn("Failed to save pricing cache: %s", error);
		}
	}

	private async fetchRemote(): Promise<ApiResponse | null> {
		for (const source of ["openrouter", "models.dev"]) {
			try {
				const url =
					source === "openrouter"
						? "https://openrouter.ai/api/v1/models"
						: "https://models.dev/api.json";
				const response = await fetch(url, {
					signal: AbortSignal.timeout(2000),
				});
				if (!response.ok) continue;
				const body = await readBoundedBody(response, 8 * 1024 * 1024);
				if (!body) continue;
				const raw: unknown = JSON.parse(new TextDecoder().decode(body));
				const data =
					source === "openrouter"
						? parseOpenRouterCatalogue(raw)
						: parseCatalogue(raw);
				if (!data) continue;
				this.source = source === "openrouter" ? "openrouter" : "models.dev";
				await this.saveToCache(data);
				return data;
			} catch (error) {
				this.logger?.warn(
					"Pricing source failed",
					source,
					error instanceof Error ? error.message : String(error),
				);
			}
		}
		return null;
	}

	getSource(): "openrouter" | "models.dev" {
		return this.source;
	}

	async getPricing(): Promise<ApiResponse | null> {
		if (
			this.priceData &&
			Date.now() - this.lastFetch < this.getCacheDurationMs()
		) {
			return this.priceData;
		}

		const pending = this.pending ?? this.refreshPricing();
		this.pending = pending;
		try {
			return await pending;
		} finally {
			if (this.pending === pending) this.pending = null;
		}
	}

	private async refreshPricing(): Promise<ApiResponse | null> {
		const data = (await this.loadFromCache()) ?? (await this.fetchRemote());
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
	const prompt =
		(tokens.inputTokens ?? 0) +
		(tokens.cacheReadInputTokens ?? 0) +
		(tokens.cacheCreationInputTokens ?? 0);
	const rates = selectContextCost(cost, prompt);
	const categoryCosts = [
		categoryCostUnits(tokens.inputTokens, rates.input),
		categoryCostUnits(tokens.outputTokens, rates.output),
		categoryCostUnits(tokens.cacheReadInputTokens, rates.cache_read),
		categoryCostUnits(tokens.cacheCreationInputTokens, rates.cache_write),
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

	return { costUsd, status: "estimated", source: catalogue.getSource() };
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
