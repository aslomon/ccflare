import { sameQuotaWindow } from "@ccflare/core";
import type { BudgetPolicy, BudgetState, QuotaSnapshot } from "@ccflare/types";
import { observeWindow } from "./window-learning";

function burnObservation(
	state: BudgetState,
	quota: QuotaSnapshot,
	minimumMs: number,
) {
	const weekly = quota.windows.find((w) => w.key === "seven_day");
	const previous = state.quota?.windows.find((w) => w.key === "seven_day");
	const same = !!previous && sameQuotaWindow(previous.resetAt, weekly?.resetAt);
	const elapsed = quota.observedAt - state.burnObservedAt;
	if (!same || state.burnObservedAt === 0)
		return {
			weeklyBurnPerHour: 0,
			burnSampleDurationMs: 0,
			burnObservedAt: quota.observedAt,
			burnObservedPercent: weekly?.usedPercent ?? 0,
		};
	if (elapsed < minimumMs)
		return {
			weeklyBurnPerHour:
				state.burnSampleDurationMs >= minimumMs ? state.weeklyBurnPerHour : 0,
			burnSampleDurationMs: state.burnSampleDurationMs,
			burnObservedAt: state.burnObservedAt,
			burnObservedPercent: state.burnObservedPercent,
		};
	const delta = Math.max(
		0,
		(weekly?.usedPercent ?? 0) - state.burnObservedPercent,
	);
	const rate = delta / (elapsed / 3_600_000);
	const alpha = 1 - Math.exp(-elapsed / 1_800_000);
	return {
		weeklyBurnPerHour:
			state.burnSampleDurationMs >= minimumMs
				? state.weeklyBurnPerHour * (1 - alpha) + rate * alpha
				: rate,
		burnSampleDurationMs: elapsed,
		burnObservedAt: quota.observedAt,
		burnObservedPercent: weekly?.usedPercent ?? 0,
	};
}

export function updateObservation(
	state: BudgetState,
	quota: QuotaSnapshot,
	policy: BudgetPolicy,
): BudgetState {
	if (state.quota && quota.observedAt < state.quota.observedAt) return state;
	const windowLearning = Object.fromEntries(
		quota.windows.map((window) => [
			window.key,
			observeWindow(state, quota, window, policy),
		]),
	);
	const weekly = quota.windows.find((w) => w.key === "seven_day");
	const previousReset = state.quota?.windows.find(
		(w) => w.key === "seven_day",
	)?.resetAt;
	const weeklyBlockedReset =
		weekly && weekly.usedPercent >= policy.cutoffPercent
			? weekly.resetAt
			: sameQuotaWindow(previousReset, weekly?.resetAt)
				? state.weeklyBlockedReset
				: null;
	return {
		...state,
		quota,
		error: null,
		failures: 0,
		nextCheckAt: quota.observedAt + policy.pollMs,
		weeklyBlockedReset,
		windowLearning,
		weeklyCostPerWork:
			windowLearning.seven_day?.costPerWork ?? state.weeklyCostPerWork,
		shortCostPerWork:
			windowLearning.five_hour?.costPerWork ?? state.shortCostPerWork,
		learnedSamples: windowLearning.seven_day?.samples ?? 0,
		observedWork: windowLearning.seven_day?.workCursor ?? state.actualWorkTotal,
		trackingStartedAt: state.trackingStartedAt || quota.observedAt,
		...burnObservation(state, quota, policy.minSessionMs),
	};
}
