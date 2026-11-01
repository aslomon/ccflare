import { sameQuotaWindow } from "@ccflare/core";
import type {
	BudgetPolicy,
	BudgetState,
	BudgetWindowLearning,
	QuotaSnapshot,
	QuotaWindow,
} from "@ccflare/types";

function matchingWork(state: BudgetState, model: string | null): number {
	return model === null
		? state.actualWorkTotal
		: Object.entries(state.modelWorkTotal).reduce(
				(sum, [name, work]) => sum + (name.includes(model) ? work : 0),
				0,
			);
}
function baseline(
	state: BudgetState,
	quota: QuotaSnapshot,
	window: QuotaWindow,
): BudgetWindowLearning {
	const previous = state.windowLearning[window.key];
	return {
		resetAt: window.resetAt,
		observedAt: quota.observedAt,
		usedPercent: window.usedPercent,
		workCursor: matchingWork(state, window.model),
		costPerWork:
			previous?.costPerWork ??
			(window.key.startsWith("seven_day") ? 0.03 : 0.3),
		samples: previous?.samples ?? 0,
		lastSampleAt: previous?.lastSampleAt ?? 0,
		unattributedPercent: previous?.unattributedPercent ?? 0,
	};
}

export function observeWindow(
	state: BudgetState,
	quota: QuotaSnapshot,
	window: QuotaWindow,
	policy: BudgetPolicy,
): BudgetWindowLearning {
	const previous = state.windowLearning[window.key];
	const current = baseline(state, quota, window);
	if (
		!previous ||
		!sameQuotaWindow(previous.resetAt, window.resetAt) ||
		window.usedPercent < previous.usedPercent
	)
		return current;
	const work = matchingWork(state, window.model) - previous.workCursor;
	const delta = window.usedPercent - previous.usedPercent;
	const elapsed = quota.observedAt - previous.observedAt;
	if (delta > 0 && work === 0)
		return {
			...current,
			unattributedPercent: previous.unattributedPercent + delta,
		};
	if (elapsed < Math.max(policy.minSessionMs, policy.pollMs * 2))
		return previous;
	if (work < 0.1 || delta <= 0) return roundedObservation(previous, work);
	const cost = Math.max(0.0001, Math.min(25, delta / work));
	return {
		...current,
		costPerWork:
			previous.samples === 0 ? cost : previous.costPerWork * 0.65 + cost * 0.35,
		samples: previous.samples + 1,
		lastSampleAt: quota.observedAt,
	};
}

function roundedObservation(
	previous: BudgetWindowLearning,
	work: number,
): BudgetWindowLearning {
	// One percentage point of quantization remains uncertainty, never zero cost.
	if (work < 1) return previous;
	const bound = Math.max(0.0001, 1 / work);
	return { ...previous, costPerWork: Math.min(previous.costPerWork, bound) };
}
