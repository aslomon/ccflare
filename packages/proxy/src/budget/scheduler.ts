import type { BudgetRepository } from "@ccflare/database";
import type { Account, BudgetPolicy } from "@ccflare/types";
import { poolKey } from "./profiles";

export function pruneBudgetSession(
	repo: BudgetRepository,
	pool: string,
	accounts: Account[],
): void {
	const members = new Set(
		accounts
			.filter((account) => poolKey(account) === pool)
			.map((account) => account.id),
	);
	const session = repo.session(pool);
	const credits = Object.fromEntries(
		Object.entries(session.credits).filter(([id]) => members.has(id)),
	);
	const lastSelectedAt = Object.fromEntries(
		Object.entries(session.lastSelectedAt).filter(([id]) => members.has(id)),
	);
	if (
		Object.keys(credits).length !== Object.keys(session.credits).length ||
		Object.keys(lastSelectedAt).length !==
			Object.keys(session.lastSelectedAt).length
	)
		repo.saveSession(pool, { ...session, credits, lastSelectedAt });
}

export function orderBudgetSessions(
	accounts: Account[],
	scores: Map<string, number>,
	repo: BudgetRepository,
	policy: BudgetPolicy,
	learning: Set<string>,
	reason = "session_deadline",
): Account[] {
	const first = accounts[0];
	if (!first) return [];
	const pool = poolKey(first);
	const now = Date.now();
	const session = repo.session(pool);
	const current = accounts.find((account) => account.id === session.accountId);
	if (current && session.deadline > now)
		return [
			current,
			...accounts.filter((account) => account.id !== current.id),
		];
	const credits = { ...session.credits };
	const ordered = rankedAccounts(accounts, session, scores);
	const chosen =
		ordered.find((account) => account.id !== session.accountId) ?? ordered[0];
	if (!chosen) return [];
	// Fairness is charged by admitted work. Duration does not apply the weight again.
	const duration = learning.has(chosen.id)
		? policy.minSessionMs
		: (policy.minSessionMs + policy.maxSessionMs) / 2;
	repo.saveSession(pool, {
		accountId: chosen.id,
		deadline: now + Math.round(duration),
		startedAt: now,
		reason,
		credits,
		lastSelectedAt: { ...session.lastSelectedAt, [chosen.id]: now },
	});
	return [chosen, ...ordered.filter((account) => account.id !== chosen.id)];
}

export function chargeBudgetSession(
	repo: BudgetRepository,
	account: Account,
	work: number,
	scores: Map<string, number>,
): void {
	const pool = poolKey(account);
	const session = repo.session(pool);
	const total = [...scores.values()].reduce((sum, score) => sum + score, 0);
	if (total <= 0) return;
	const credits = { ...session.credits };
	for (const [id, score] of scores)
		credits[id] = (credits[id] ?? 0) + (work * score) / total;
	credits[account.id] = (credits[account.id] ?? 0) - work;
	repo.saveSession(pool, { ...session, credits });
}

function rankedAccounts(
	accounts: Account[],
	session: ReturnType<BudgetRepository["session"]>,
	scores: Map<string, number>,
): Account[] {
	const credits = session.credits;
	return [...accounts].sort(
		(a, b) =>
			(credits[b.id] ?? 0) - (credits[a.id] ?? 0) ||
			(session.lastSelectedAt[a.id] ?? 0) -
				(session.lastSelectedAt[b.id] ?? 0) ||
			(scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) ||
			a.created_at - b.created_at ||
			a.id.localeCompare(b.id),
	);
}
