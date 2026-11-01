import {
	type CostEstimateResult,
	estimateCostResult,
	type TokenBreakdown,
} from "@ccflare/core";

type CostEstimator = (
	modelId: string,
	tokens: TokenBreakdown,
) => Promise<CostEstimateResult>;

const unavailableCost: CostEstimateResult = {
	costUsd: null,
	status: "unavailable",
	source: "none",
};

export async function resolveUsageCost(
	modelId: string,
	tokens: TokenBreakdown,
	estimate: CostEstimator = estimateCostResult,
	provider?: string,
): Promise<CostEstimateResult> {
	if (provider === "lmstudio")
		return { costUsd: 0, status: "estimated", source: "local" };
	if (modelId === "unknown") return unavailableCost;
	return estimate(modelId, tokens);
}
