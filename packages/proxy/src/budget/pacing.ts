import type { BudgetPacing, BudgetPolicy, BudgetState } from "@ccflare/types";

export function previewPacing(
	state: BudgetState,
	policy: BudgetPolicy,
	reserved: number,
	now: number,
): BudgetPacing {
	const weekly = state.quota?.windows.find(
		(window) => window.key === "seven_day",
	);
	const hours = weekly?.resetAt
		? Math.max(1, (weekly.resetAt - now) / 3_600_000)
		: 168;
	const remaining = Math.max(
		0,
		policy.cutoffPercent -
			policy.headroomPercent -
			(weekly?.usedPercent ?? 0) -
			reserved,
	);
	const rate = Math.min(remaining / hours, (policy.cutoffPercent / 168) * 4);
	const elapsed = state.pacing.updatedAt
		? Math.max(0, now - state.pacing.updatedAt) / 3_600_000
		: 0;
	const balance = state.pacing.updatedAt
		? state.pacing.balancePercent + elapsed * state.pacing.ratePercentPerHour
		: rate * 0.5;
	return {
		updatedAt: now,
		balancePercent: Math.max(-policy.cutoffPercent, Math.min(rate, balance)),
		ratePercentPerHour: rate,
		pendingPercent: state.pacing.pendingPercent,
		observedPercent: state.pacing.updatedAt
			? state.pacing.observedPercent
			: (weekly?.usedPercent ?? 0),
	};
}

export function observedPacing(
	state: BudgetState,
	policy: BudgetPolicy,
	reserved: number,
	now: number,
): BudgetPacing {
	const pacing = previewPacing(state, policy, reserved, now);
	const used =
		state.quota?.windows.find((window) => window.key === "seven_day")
			?.usedPercent ?? 0;
	const delta = Math.max(0, used - pacing.observedPercent);
	return {
		...pacing,
		observedPercent: used,
		pendingPercent: Math.max(0, pacing.pendingPercent - delta),
		balancePercent:
			pacing.balancePercent - Math.max(0, delta - pacing.pendingPercent),
	};
}
