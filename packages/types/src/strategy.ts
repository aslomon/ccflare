import type { Account } from "./account";

export interface SessionRotationWindow {
	minMs: number;
	maxMs: number;
}

export const StrategyName = {
	Session: "session",
} as const;

export type StrategyName = (typeof StrategyName)[keyof typeof StrategyName];

export const LB_STRATEGIES = Object.freeze(
	Object.values(StrategyName),
) as readonly StrategyName[];

export function isLbStrategy(value: string): value is StrategyName {
	return LB_STRATEGIES.includes(value as StrategyName);
}

/**
 * Interface for strategy-specific database operations
 * Allows strategies to interact with the database without direct SQL access
 */
export interface StrategyStore {
	getAccountsByProvider?(provider: Account["provider"]): Account[];
	/**
	 * Reset session for an account
	 * Updates session_start and session_request_count
	 */
	resetAccountSession(accountId: string, timestamp: number): void;

	/**
	 * Get all accounts (optional method for strategies that need full account list)
	 */
	getAllAccounts?(): Account[];

	/**
	 * Update account request count
	 */
	updateAccountRequestCount?(accountId: string, count: number): void;

	/**
	 * Get account by ID
	 */
	getAccount?(accountId: string): Account | null;
}
