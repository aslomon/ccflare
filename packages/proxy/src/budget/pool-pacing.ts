import type { Account } from "@ccflare/types";
import type { BudgetControl } from "./control";
import { previewPacing } from "./pacing";

export function pacedCandidates(
	control: BudgetControl,
	pool: Account[],
	model: string | null,
	work: number,
): Account[] {
	const now = Date.now();
	const fitting = pool.filter((account) =>
		control.hasAllowance(account, model, work, now),
	);
	if (fitting.length) return fitting;
	const positions = new Map(
		pool.map((account) => {
			const group = control.group(account);
			const state = control.repo.state(group);
			const pace = previewPacing(
				state,
				control.policy,
				control.repo.reservedPercent(group, now),
				now,
			);
			return [
				account.id,
				pace.balancePercent / Math.max(0.001, pace.ratePercentPerHour),
			];
		}),
	);
	const maximum = Math.max(...positions.values());
	// Under overload, spend the least indebted group's allowance first.
	return pool.filter(
		(account) => (positions.get(account.id) ?? -Infinity) >= maximum - 1 / 60,
	);
}
