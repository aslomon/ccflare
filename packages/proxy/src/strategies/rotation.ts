import { isAccountAvailable } from "@ccflare/core";
import type {
	Account,
	SessionRotationWindow,
	StrategyStore,
} from "@ccflare/types";

/** Stable jitter keeps a session's deadline unchanged after process restarts. */
export function rotationDuration(
	account: Account,
	window: SessionRotationWindow,
): number {
	let hash = 2166136261;
	for (const character of `${account.id}:${account.session_start}`) {
		hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
	}
	return window.minMs + (hash % (window.maxMs - window.minMs + 1));
}

function compareAccounts(left: Account, right: Account): number {
	return left.created_at - right.created_at || left.id.localeCompare(right.id);
}

function mostRecentSession(accounts: Account[]): Account | undefined {
	return accounts.reduce<Account | undefined>((latest, account) => {
		if (account.session_start === null) return latest;
		if (!latest || account.session_start > (latest.session_start ?? 0))
			return account;
		return latest;
	}, undefined);
}

export function selectRotatingSession(
	accounts: Account[],
	window: SessionRotationWindow,
	store: StrategyStore | null,
): Account[] {
	const now = Date.now();
	const available = accounts.filter((account) =>
		isAccountAvailable(account, now),
	);
	const first = available[0];
	if (!first) return [];
	const pool = (store?.getAccountsByProvider?.(first.provider) ?? accounts)
		.filter((account) => account.provider === first.provider)
		.sort(compareAccounts);
	const current = mostRecentSession(pool);
	const currentIndex = current
		? pool.findIndex((account) => account.id === current.id)
		: -1;
	const availableIds = new Set(available.map((account) => account.id));
	const continuing =
		current &&
		availableIds.has(current.id) &&
		current.session_start !== null &&
		now < current.session_start + rotationDuration(current, window);
	const startIndex = continuing ? currentIndex : currentIndex + 1;
	const ordered = [
		...pool.slice(startIndex),
		...pool.slice(0, startIndex),
	].filter((account) => availableIds.has(account.id));
	const chosen = ordered[0];
	if (chosen && !continuing) {
		store?.resetAccountSession(chosen.id, now);
		chosen.session_start = now;
		chosen.session_request_count = 0;
	}
	return ordered;
}
