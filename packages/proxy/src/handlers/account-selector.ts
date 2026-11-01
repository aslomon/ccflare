import type { Account, RequestMeta } from "@ccflare/types";
import type { ResolvedProxyContext } from "./proxy-types";

/**
 * Gets accounts ordered by the load balancing strategy
 * @param meta - Request metadata
 * @param ctx - The proxy context
 * @returns Array of ordered accounts
 */
export function getOrderedAccounts(
	meta: RequestMeta,
	ctx: ResolvedProxyContext,
): Account[] {
	const providerAccounts = ctx.dbOps.getAvailableAccountsByProvider(
		ctx.providerName,
	);
	return ctx.budgets?.enabled
		? ctx.budgets.order(
				providerAccounts,
				ctx.budgetModel ?? null,
				ctx.budgetWork ?? 0,
			)
		: ctx.strategy.select(providerAccounts, meta);
}

/**
 * Selects accounts for a request based on the load balancing strategy
 * @param meta - Request metadata
 * @param ctx - The proxy context
 * @returns Array of selected accounts
 */
export function selectAccountsForRequest(
	meta: RequestMeta,
	ctx: ResolvedProxyContext,
): Account[] {
	return getOrderedAccounts(meta, ctx);
}
