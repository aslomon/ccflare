import type {
	BudgetDecision,
	BudgetPolicy,
	BudgetProfile,
	BudgetState,
	QuotaWindow,
} from "@ccflare/types";

export { budgetPolicySchema, budgetProfileSchema } from "./budget-schemas";

export function emptyBudgetState(): BudgetState {
	return {
		quota: null,
		error: null,
		nextCheckAt: 0,
		failures: 0,
		workTotal: 0,
		observedWork: 0,
		weeklyCostPerWork: 0.03,
		shortCostPerWork: 0.3,
		weeklyBlockedReset: null,
		learnedSamples: 0,
		weeklyBurnPerHour: 0,
		burnSampleDurationMs: 0,
		burnObservedAt: 0,
		burnObservedPercent: 0,
		actualWorkTotal: 0,
		modelWorkTotal: {},
		windowLearning: {},
		workModels: {},
		pacing: {
			updatedAt: 0,
			balancePercent: 0,
			ratePercentPerHour: 0,
			pendingPercent: 0,
			observedPercent: 0,
		},
		trackingStartedAt: 0,
	};
}

function applies(window: QuotaWindow, model: string | null): boolean {
	return (
		window.model === null || model === null || model.includes(window.model)
	);
}
/** Provider reset times can drift across polls due to sub-second rounding. */
export function sameQuotaWindow(
	left: number | null | undefined,
	right: number | null | undefined,
): boolean {
	return (
		left === right ||
		(typeof left === "number" &&
			typeof right === "number" &&
			Math.abs(left - right) <= 60_000)
	);
}

function blockReason(
	state: BudgetState,
	policy: BudgetPolicy,
	now: number,
	windows: QuotaWindow[],
	reserved: number,
	work: number,
	reservedWork: number,
	windowReservations: Record<string, number>,
): string | null {
	const weekly = windows.find((w) => w.key === "seven_day");
	if (!weekly) return "weekly_quota_missing";
	if (
		weekly.resetAt === null &&
		(weekly.usedPercent > 0 ||
			reserved + work * state.weeklyCostPerWork >= 0.25)
	)
		return "reset_pending";
	if (weekly.resetAt !== null && weekly.resetAt <= now) return "reset_pending";
	if (
		state.weeklyBlockedReset !== null &&
		sameQuotaWindow(state.weeklyBlockedReset, weekly.resetAt)
	)
		return "weekly_limit";
	return windowBlockReason(
		state,
		policy,
		now,
		windows,
		reserved,
		work,
		reservedWork,
		windowReservations,
	);
}

function windowBlockReason(
	state: BudgetState,
	policy: BudgetPolicy,
	now: number,
	windows: QuotaWindow[],
	reserved: number,
	work: number,
	reservedWork: number,
	windowReservations: Record<string, number>,
): string | null {
	for (const window of windows) {
		const isWeekly = window.key.startsWith("seven_day");
		const cutoff = isWeekly
			? policy.cutoffPercent
			: policy.shortWindowCutoffPercent;
		if (window.usedPercent >= cutoff)
			return isWeekly ? "weekly_limit" : "short_window_limit";
		if (window.resetAt !== null && window.resetAt <= now)
			return "reset_pending";
		const cost =
			state.windowLearning[window.key]?.costPerWork ??
			(isWeekly ? state.weeklyCostPerWork : state.shortCostPerWork);
		const pending =
			windowReservations[window.key] ??
			(isWeekly ? reserved : reservedWork * state.shortCostPerWork);
		if (
			window.usedPercent + pending + work * cost + policy.headroomPercent >=
			cutoff
		)
			return isWeekly ? "reserve_guard" : "short_window_limit";
	}
	return null;
}

function unavailableReason(
	state: BudgetState,
	profile: BudgetProfile,
	policy: BudgetPolicy,
	model: string | null,
	ageMs: number | null,
): string | null {
	if (
		profile.models.length &&
		model &&
		!profile.models.some(
			(m) =>
				m === model || (m.endsWith("*") && model.startsWith(m.slice(0, -1))),
		)
	)
		return "model_unavailable";
	if (profile.mode === "local") return null;
	if (!state.quota) return state.error ?? "usage_unknown";
	if (
		state.error &&
		[
			"usage_http_401",
			"usage_http_403",
			"usage_price_unknown",
			"usage_adapter_missing",
			"usage_money_profile_missing",
		].includes(state.error)
	)
		return state.error;
	if (ageMs === null || ageMs > policy.maxAgeMs) return "usage_stale";
	return null;
}

function availableCapacity(
	state: BudgetState,
	policy: BudgetPolicy,
	weekly: QuotaWindow,
	now: number,
	reserved: number,
) {
	const hours =
		weekly.resetAt === null
			? 168
			: Math.max(1, (weekly.resetAt - now) / 3_600_000);
	const remaining = Math.max(
		0,
		policy.cutoffPercent -
			policy.headroomPercent -
			weekly.usedPercent -
			reserved,
	);
	// A bounded horizon avoids unlimited urgency just before a reset.
	const score =
		Math.min(remaining / hours, (policy.cutoffPercent / 168) * 4) /
		state.weeklyCostPerWork;
	return {
		eligible: true,
		reason: state.learnedSamples ? "budget_available" : "learning",
		score,
		predictedAtReset:
			state.weeklyBurnPerHour > 0 &&
			state.burnSampleDurationMs >= policy.minSessionMs
				? weekly.usedPercent + state.weeklyBurnPerHour * hours + reserved
				: null,
	};
}

export function decideBudget(
	state: BudgetState,
	profile: BudgetProfile,
	policy: BudgetPolicy,
	now: number,
	model: string | null,
	reserved: number,
	work: number,
	reservedWork = reserved / state.weeklyCostPerWork,
	windowReservations: Record<string, number> = {},
): BudgetDecision {
	const weekly = state.quota?.windows.find((w) => w.key === "seven_day");
	const ageMs = state.quota ? Math.max(0, now - state.quota.observedAt) : null;
	const base = {
		eligible: false,
		score: 0,
		weeklyUsed: weekly?.usedPercent ?? null,
		resetAt: weekly?.resetAt ?? null,
		predictedAtReset: null,
		ageMs,
	};
	const unavailable = unavailableReason(state, profile, policy, model, ageMs);
	if (profile.mode === "local")
		return {
			...base,
			weeklyUsed: null,
			resetAt: null,
			ageMs: null,
			eligible: !unavailable,
			score: unavailable ? 0 : 1,
			reason: unavailable ?? "local_capacity",
		};
	if (unavailable || !state.quota)
		return { ...base, reason: unavailable ?? "usage_unknown" };
	const reason = blockReason(
		state,
		policy,
		now,
		state.quota.windows.filter((w) => applies(w, model)),
		reserved,
		work,
		reservedWork,
		windowReservations,
	);
	if (reason || !weekly) return { ...base, reason: reason ?? "reset_pending" };
	return {
		...base,
		...availableCapacity(state, policy, weekly, now, reserved),
	};
}
