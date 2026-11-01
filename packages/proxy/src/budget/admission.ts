import type { Account } from "@ccflare/types";
import type { BudgetControl } from "./control";
import { recordBudgetHistory } from "./history";
import { previewPacing } from "./pacing";
import { chargeBudgetSession } from "./scheduler";
import { sessionWeights } from "./weights";
import { predictedWork } from "./work";

interface AdmissionRequest {
	account: Account;
	model: string | null;
	maximumWork: number;
	override?: number;
	requestId?: string;
}
const validMaximum = (work: number): boolean =>
	Number.isFinite(work) && work > 0 && work <= 1_000_000;
function quotaAllows(
	control: BudgetControl,
	account: Account,
	model: string | null,
	work: number,
	now: number,
): boolean {
	const decision = control.decision(account, model, work, now, false);
	if (!decision.eligible)
		recordBudgetHistory(control, account, "denied", model, decision.reason);
	return decision.eligible;
}

function prepareAdmission(control: BudgetControl, input: AdmissionRequest) {
	const { account, model, maximumWork, override } = input;
	const group = control.group(account),
		state = control.repo.state(group),
		now = Date.now();
	if (!validMaximum(maximumWork)) return null;
	const work = predictedWork(state, model, maximumWork);
	const percent = override ?? work * state.weeklyCostPerWork;
	if (!Number.isFinite(percent) || percent <= 0) return null;
	if (
		!quotaAllows(
			control,
			account,
			model,
			percent / state.weeklyCostPerWork,
			now,
		)
	)
		return null;
	const pool = control.compatiblePool(account, model);
	const pacing = previewPacing(
		state,
		control.policy,
		control.repo.reservedPercent(group, now),
		now,
	);
	const alternative = pool.some(
		(peer) =>
			control.group(peer) !== group &&
			control.hasAllowance(peer, model, maximumWork, now),
	);
	if (pacing.balancePercent < percent && alternative) {
		recordBudgetHistory(control, account, "denied", model, "pace_exhausted");
		return null;
	}
	return { group, state, now, work, percent, pool, pacing };
}
type Admission = NonNullable<ReturnType<typeof prepareAdmission>>;

function persistAdmission(
	control: BudgetControl,
	input: AdmissionRequest,
	admission: Admission,
): string {
	const { group, state, now, work, percent, pool, pacing } = admission;
	const { account, model, maximumWork, requestId } = input;
	const id = crypto.randomUUID();
	control.repo.reserve(
		account.id,
		group,
		id,
		work,
		percent,
		now,
		now + control.policy.reservationMs,
		{ model, requestId: requestId ?? null, estimatedWork: maximumWork },
	);
	control.repo.saveState(group, {
		...state,
		workTotal: state.workTotal + maximumWork,
		nextCheckAt: Math.min(state.nextCheckAt, now + 60_000),
		pacing: {
			...pacing,
			balancePercent: pacing.balancePercent - percent,
			pendingPercent: pacing.pendingPercent + percent,
		},
	});
	chargeBudgetSession(
		control.repo,
		account,
		work,
		sessionWeights(control, pool, model).scores,
	);
	return id;
}

export function admitBudgetRequest(
	control: BudgetControl,
	input: AdmissionRequest,
): string | null {
	const admission = prepareAdmission(control, input);
	return admission ? persistAdmission(control, input, admission) : null;
}
