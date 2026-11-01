import type { Account } from "@ccflare/types";
import type { BudgetControl } from "./control";

export function sessionWeights(
	control: BudgetControl,
	pool: Account[],
	model: string | null,
) {
	const groups = new Map<string, { score: number; count: number }>();
	for (const account of pool) {
		const key = control.group(account);
		groups.set(key, {
			score: control.decision(account, model, 0, Date.now()).score,
			count: (groups.get(key)?.count ?? 0) + 1,
		});
	}
	const maximum = Math.max(
		0.001,
		...[...groups.values()].map((group) => group.score),
	);
	const minimum = maximum / Math.max(4, groups.size * 4);
	const scores = new Map<string, number>();
	const learning = new Set<string>();
	for (const account of pool) {
		const group = groups.get(control.group(account));
		if (!group) continue;
		scores.set(account.id, Math.max(minimum, group.score) / group.count);
		if (control.repo.state(control.group(account)).learnedSamples < 2)
			learning.add(account.id);
	}
	return { scores, learning };
}
