import { budgetUsageSchema } from "@ccflare/core";
import type {
	Account,
	BudgetProfile,
	BudgetState,
	BudgetUsage,
} from "@ccflare/types";
import type { BudgetControl } from "./control";
import { previewPacing } from "./pacing";
import { chargeBudgetSession } from "./scheduler";
import { sessionWeights } from "./weights";
import { learnWork, measuredWork } from "./work";

type Attempt = NonNullable<
	ReturnType<BudgetControl["repo"]["telemetry"]["attempt"]>
>;

function usagePercent(
	profile: BudgetProfile,
	usage: BudgetUsage,
	work: number,
	costPerWork: number,
	reserved: number,
): number {
	if (profile.mode !== "money") return work * costPerWork;
	return usage.costUsd !== null && profile.weeklyUsd
		? (usage.costUsd / profile.weeklyUsd) * 100
		: reserved;
}
function correctScheduling(
	control: BudgetControl,
	account: Account,
	model: string | null,
	difference: number,
): void {
	const pool = control.compatiblePool(account, model);
	chargeBudgetSession(
		control.repo,
		account,
		difference,
		sessionWeights(control, pool, model).scores,
	);
}
function settledPacing(
	control: BudgetControl,
	state: BudgetState,
	group: string,
	difference: number,
	now: number,
) {
	const pacing = previewPacing(
		state,
		control.policy,
		control.repo.reservedPercent(group, now),
		now,
	);
	return {
		...pacing,
		pendingPercent: Math.max(0, pacing.pendingPercent + difference),
		balancePercent: Math.min(
			pacing.ratePercentPerHour,
			pacing.balancePercent - difference,
		),
	};
}
function persistUsage(
	control: BudgetControl,
	account: Account,
	usage: BudgetUsage,
	attempt: Attempt,
	work: number,
	now: number,
): void {
	const state = control.repo.state(attempt.group_id);
	const percent = usagePercent(
		control.profile(account),
		usage,
		work,
		state.weeklyCostPerWork,
		attempt.admitted_percent,
	);
	const learned = learnWork(
		state,
		attempt.model ?? usage.model,
		attempt.estimated_work,
		work,
		now,
	);
	control.repo.saveState(attempt.group_id, {
		...learned,
		pacing: settledPacing(
			control,
			state,
			attempt.group_id,
			percent - attempt.admitted_percent,
			now,
		),
	});
	control.repo.settle(attempt.id, work, percent);
	const difference = work - attempt.admitted_work;
	correctScheduling(control, account, attempt.model, difference);
}
function settleUsage(
	control: BudgetControl,
	account: Account,
	usage: BudgetUsage,
	work: number,
): boolean {
	const attempt = control.repo.telemetry.attempt(
		usage.requestId,
		usage.accountId,
	);
	if (!attempt || attempt.group_id !== control.group(account)) return false;
	const now = Date.now();
	if (!control.repo.telemetry.settle(attempt.id, work, now)) return false;
	persistUsage(control, account, usage, attempt, work, now);
	return true;
}

export function recordCompletedUsage(
	control: BudgetControl,
	input: BudgetUsage,
): boolean {
	const parsed = budgetUsageSchema.safeParse(input);
	if (!parsed.success) return false;
	const usage = parsed.data,
		work = measuredWork(usage),
		account = control.dbOps.getAccount(usage.accountId);
	if (work === null || !account) return false;
	return settleUsage(control, account, usage, work);
}
