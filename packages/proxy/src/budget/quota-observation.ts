import { sameQuotaWindow } from "@ccflare/core";
import type { Account, BudgetState, QuotaSnapshot } from "@ccflare/types";
import type { BudgetControl } from "./control";
import { recordBudgetHistory } from "./history";
import { updateObservation } from "./observations";
import { observedPacing } from "./pacing";

function stateForQuota(
	previous: BudgetState,
	quota: QuotaSnapshot,
	control: BudgetControl,
): BudgetState {
	const state = updateObservation(previous, quota, control.policy);
	const oldReset = previous.quota?.windows.find(
		(window) => window.key === "seven_day",
	)?.resetAt;
	const reset = quota.windows.find(
		(window) => window.key === "seven_day",
	)?.resetAt;
	const rolledOver =
		oldReset !== undefined && !sameQuotaWindow(oldReset, reset);
	return rolledOver
		? {
				...state,
				pacing: {
					updatedAt: 0,
					balancePercent: 0,
					ratePercentPerHour: 0,
					pendingPercent: 0,
					observedPercent: 0,
				},
			}
		: state;
}

export function recordQuotaObservation(
	control: BudgetControl,
	account: Account,
	quota: QuotaSnapshot,
): void {
	const group = control.group(account),
		previous = control.repo.state(group);
	if (previous.quota && quota.observedAt < previous.quota.observedAt) return;
	const state = stateForQuota(previous, quota, control);
	control.repo.saveState(group, {
		...state,
		pacing: observedPacing(
			state,
			control.policy,
			control.repo.reservedPercent(group, quota.observedAt),
			quota.observedAt,
		),
	});
	// A full polling interval tolerates lagged provider accounting and async writers.
	control.repo.reconcile(group, quota.observedAt - control.policy.pollMs);
	control.repo.prune(quota.observedAt);
	control.repo.telemetry.prune(quota.observedAt);
	recordBudgetHistory(
		control,
		account,
		"quota",
		null,
		control.decision(account, null, 0, quota.observedAt).reason,
	);
}
