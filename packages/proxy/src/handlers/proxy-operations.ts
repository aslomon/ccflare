import { logError, ProviderError } from "@ccflare/core";
import { Logger } from "@ccflare/logger";
import type { Account, RequestMeta } from "@ccflare/types";
import { holdBudgetResponse, reserveBudgetRequest } from "../budget/request";
import { forwardToClient } from "../response-handler";
import { ERROR_MESSAGES, type ResolvedProxyContext } from "./proxy-types";
import { makeProxyRequest } from "./request-handler";
import { handleProxyError, processProxyResponse } from "./response-processor";
import { getValidAccessToken } from "./token-manager";

const log = new Logger("ProxyOperations");

/**
 * Handles proxy request without authentication
 * @param req - The incoming request
 * @param url - The parsed URL
 * @param requestMeta - Request metadata
 * @param requestBodyBuffer - Buffered request body
 * @param createBodyStream - Function to create body stream
 * @param ctx - The proxy context
 * @returns Promise resolving to the response
 * @throws {ProviderError} If the unauthenticated request fails
 */
export async function proxyUnauthenticated(
	req: Request,
	url: URL,
	requestMeta: RequestMeta,
	requestBodyBuffer: ArrayBuffer | null,
	createBodyStream: () => ReadableStream<Uint8Array> | undefined,
	ctx: ResolvedProxyContext,
): Promise<Response> {
	log.warn(ERROR_MESSAGES.NO_ACCOUNTS);

	const targetUrl = ctx.provider.buildUrl(ctx.upstreamPath, url.search);
	const headers = ctx.provider.prepareHeaders(req.headers, null);

	try {
		const upstreamRequestStartedAt = Date.now();
		const response = await makeProxyRequest(
			targetUrl,
			req.method,
			headers,
			createBodyStream,
			!!req.body,
		);
		const responseHeadersReceivedAt = Date.now();

		return forwardToClient(
			{
				requestId: requestMeta.id,
				method: requestMeta.method,
				path: url.pathname,
				account: null,
				requestHeaders: req.headers,
				requestBody: requestBodyBuffer,
				response,
				timestamp: requestMeta.timestamp,
				upstreamRequestStartedAt,
				responseHeadersReceivedAt,
				retryAttempt: 0,
				failoverAttempts: 0,
			},
			ctx,
		);
	} catch (error) {
		logError(error, log);
		throw new ProviderError(
			ERROR_MESSAGES.UNAUTHENTICATED_FAILED,
			ctx.providerName,
			502,
			{
				originalError: error instanceof Error ? error.message : String(error),
			},
		);
	}
}

/**
 * Attempts to proxy a request with a specific account
 * @param req - The incoming request
 * @param url - The parsed URL
 * @param account - The account to use
 * @param requestMeta - Request metadata
 * @param requestBodyBuffer - Buffered request body
 * @param createBodyStream - Function to create body stream
 * @param failoverAttempts - Number of failover attempts
 * @param ctx - The proxy context
 * @returns Promise resolving to response or null if failed
 */
export async function proxyWithAccount(
	req: Request,
	url: URL,
	account: Account,
	requestMeta: RequestMeta,
	requestBodyBuffer: ArrayBuffer | null,
	createBodyStream: () => ReadableStream<Uint8Array> | undefined,
	failoverAttempts: number,
	ctx: ResolvedProxyContext,
): Promise<Response | null> {
	const reservation = await reserveBudgetRequest(
		ctx.budgets,
		account,
		requestBodyBuffer,
		requestMeta.id,
	);
	if (!reservation) return null;
	let forwarded = false;
	try {
		log.info(`Attempting request with account: ${account.name}`);

		// Get valid access token
		const accessToken = await getValidAccessToken(account, ctx);

		// Prepare request
		const requestAccount =
			accessToken === account.access_token
				? account
				: { ...account, access_token: accessToken };
		const headers = ctx.provider.prepareHeaders(req.headers, requestAccount);
		const targetUrl = ctx.provider.buildUrl(
			ctx.upstreamPath,
			url.search,
			account,
		);

		// Make the request
		const upstreamRequestStartedAt = Date.now();
		const response = await makeProxyRequest(
			targetUrl,
			req.method,
			headers,
			createBodyStream,
			!!req.body,
			ctx.providerName === "lmstudio"
				? AbortSignal.any([req.signal, AbortSignal.timeout(3_600_000)])
				: undefined,
		);
		const responseHeadersReceivedAt = Date.now();

		// Process response and check for rate limit
		const isRateLimited = processProxyResponse(response, account, ctx);
		if (isRateLimited) {
			return null; // Signal to try next account
		}

		// Forward response to client
		const forwardedResponse = await forwardToClient(
			{
				requestId: requestMeta.id,
				method: requestMeta.method,
				path: url.pathname,
				account,
				requestHeaders: req.headers,
				requestBody: requestBodyBuffer,
				response,
				timestamp: requestMeta.timestamp,
				upstreamRequestStartedAt,
				responseHeadersReceivedAt,
				retryAttempt: 0,
				failoverAttempts,
			},
			ctx,
		);
		forwarded = true;
		return holdBudgetResponse(forwardedResponse, ctx.budgets, reservation);
	} catch (err) {
		handleProxyError(err, account, log);
		return null;
	} finally {
		if (!forwarded && reservation !== "unmanaged")
			ctx.budgets?.finish(reservation);
	}
}
