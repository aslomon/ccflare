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
): Promise<CostEstimateResult> {
	if (modelId === "unknown") return unavailableCost;
	return estimate(modelId, tokens);
}
