import type {
	Account,
	BudgetAccountView,
	BudgetDecision,
} from "@ccflare/types";
import type { BudgetControl } from "./control";
import { budgetForecast } from "./forecast";
import { previewPacing } from "./pacing";
import { poolKey } from "./profiles";

function pauseReason(account: Account, reason: string, now: number): string {
	return account.paused
		? "manual_pause"
		: (account.rate_limited_until ?? 0) > now
			? "provider_rate_limit"
			: reason;
}
function predictedAtReset(
	decision: BudgetDecision,
	reserved: number,
	forecast: BudgetAccountView["forecast"],
	now: number,
): number | null {
	if (forecast.confidence === "unknown" || decision.weeklyUsed === null)
		return null;
	const hours = decision.resetAt
		? Math.max(0, (decision.resetAt - now) / 3_600_000)
		: 168;
	return (
		decision.weeklyUsed + reserved + forecast.expectedPercentPerHour * hours
	);
}
export function viewBudgetAccount(
	control: BudgetControl,
	account: Account,
	model: string | null,
	work: number,
): BudgetAccountView {
	const group = control.group(account),
		state = control.repo.state(group),
		now = Date.now();
	const decision = control.decision(account, model, work, now),
		session = control.repo.session(poolKey(account));
	const manual = account.paused || (account.rate_limited_until ?? 0) > now;
	const reservedPercent = control.repo.reservedPercent(group, now),
		forecast = budgetForecast(control, account, model, now);
	return {
		...decision,
		eligible: decision.eligible && !manual,
		reason: pauseReason(account, decision.reason, now),
		profile: control.profile(account),
		quota: state.quota,
		cutoffPercent: control.policy.cutoffPercent,
		manualPaused: account.paused,
		automaticPaused: !decision.eligible,
		nextCheckAt: state.nextCheckAt,
		learning:
			control.profile(account).mode !== "local" && state.learnedSamples < 2,
		deadline: session.accountId === account.id ? session.deadline : null,
		reservedPercent,
		measuredWork: state.actualWorkTotal,
		pacing: previewPacing(state, control.policy, reservedPercent, now),
		forecast,
		predictedAtReset: predictedAtReset(
			decision,
			reservedPercent,
			forecast,
			now,
		),
	};
}
