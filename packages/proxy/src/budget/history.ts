import type { Account, BudgetHistoryFact } from "@ccflare/types";
import type { BudgetControl } from "./control";
import { previewPacing } from "./pacing";
import { poolKey } from "./profiles";

export function recordBudgetSwitch(
	control: BudgetControl,
	account: Account,
	previous: ReturnType<BudgetControl["repo"]["session"]>,
	model: string | null,
): void {
	const next = control.repo.session(poolKey(account));
	if (
		next.accountId !== previous.accountId ||
		next.deadline !== previous.deadline
	)
		recordBudgetHistory(control, account, "selection", model, next.reason);
}

export function recordBudgetHistory(
	control: BudgetControl,
	account: Account,
	kind: BudgetHistoryFact["kind"],
	model: string | null,
	reason: string,
): void {
	const groupId = control.group(account);
	const state = control.repo.state(groupId);
	const now = Date.now();
	const reservedPercent = control.repo.reservedPercent(groupId, now);
	const pace = previewPacing(state, control.policy, reservedPercent, now);
	const session = control.repo.session(poolKey(account));
	control.repo.telemetry.append({
		kind,
		observedAt: now,
		accountId: account.id,
		groupId,
		model,
		reason,
		quota: kind === "quota" ? state.quota : null,
		reservedPercent,
		actualWorkTotal: state.actualWorkTotal,
		balancePercent: pace.balancePercent,
		ratePercentPerHour: pace.ratePercentPerHour,
		deadline: session.accountId === account.id ? session.deadline : null,
	});
}
