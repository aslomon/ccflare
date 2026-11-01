import type { Account, BudgetAccountView } from "@ccflare/types";
import type { BudgetControl } from "./control";
import { poolDemand } from "./demand";
import { sessionWeights } from "./weights";

function forecastConfidence(
	known: boolean,
	samples: number,
	ageMs: number | null,
): BudgetAccountView["forecast"]["confidence"] {
	if (!known) return "unknown";
	if (ageMs === null || ageMs > 6 * 3_600_000) return "low";
	return samples >= 5 ? "high" : samples >= 2 ? "medium" : "low";
}
function poolCapacity(
	control: BudgetControl,
	pool: Account[],
	model: string | null,
	now: number,
): number {
	const groups = new Map(
		pool.map((account) => [
			control.group(account),
			control.decision(account, model, 0, now).score,
		]),
	);
	return [...groups.values()].reduce((sum, score) => sum + score, 0);
}
function forecastAllocation(
	control: BudgetControl,
	account: Account,
	pool: Account[],
	scores: Map<string, number>,
	demand: ReturnType<typeof poolDemand>,
	now: number,
) {
	const state = control.repo.state(control.group(account)),
		learning = state.windowLearning.seven_day;
	const known =
		demand.coverageMs >= control.policy.minSessionMs &&
		state.actualWorkTotal >= 0.1;
	const sampleAgeMs = learning?.lastSampleAt
		? now - learning.lastSampleAt
		: null;
	const groupScore = pool
		.filter((peer) => control.group(peer) === control.group(account))
		.reduce((sum, peer) => sum + (scores.get(peer.id) ?? 0), 0);
	const total = [...scores.values()].reduce((sum, score) => sum + score, 0);
	return {
		known,
		sampleAgeMs,
		confidence: forecastConfidence(known, learning?.samples ?? 0, sampleAgeMs),
		expectedPercentPerHour:
			((demand.poolDemandPerHour * groupScore) / Math.max(total, 0.0001)) *
			state.weeklyCostPerWork,
	};
}
export function budgetForecast(
	control: BudgetControl,
	account: Account,
	model: string | null,
	now: number,
): BudgetAccountView["forecast"] {
	const pool = control.compatiblePool(account, model);
	const scores = sessionWeights(control, pool, model).scores;
	const demand = poolDemand(control, control.modelPool(account, model), now);
	const poolCapacityPerHour = poolCapacity(control, pool, model, now);
	const { known, ...allocation } = forecastAllocation(
		control,
		account,
		pool,
		scores,
		demand,
		now,
	);
	return {
		...demand,
		...allocation,
		poolCapacityPerHour,
		poolDeficit:
			known &&
			Math.max(demand.recentWorkPerHour, demand.poolDemandPerHour) >
				poolCapacityPerHour,
	};
}
