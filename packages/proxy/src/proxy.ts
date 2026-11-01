import { requestEvents, ServiceUnavailableError } from "@ccflare/core";
import { Logger } from "@ccflare/logger";
import { isRequestPayload, isRequestSummary } from "@ccflare/types";
import { budgetRequestInfo, budgetUnavailable } from "./budget/request";
import {
	createRequestMetadata,
	ERROR_MESSAGES,
	type ProxyContext,
	prepareRequestBody,
	proxyUnauthenticated,
	proxyWithAccount,
	resolveProxyContext,
	selectAccountsForRequest,
	TIMING,
} from "./handlers";
import {
	UsageWorkerController,
	type UsageWorkerHealthSnapshot,
	type UsageWorkerTransport,
} from "./usage-worker";

export type { ProxyContext } from "./handlers";

import { LocalCapacity } from "./local-capacity";

const localCapacity = new LocalCapacity(2);
const log = new Logger("Proxy");

let usageWorkerInstance: UsageWorkerController | null = null;

/**
 * Gets or creates the usage worker instance
 * @returns The usage worker instance
 */
export function getUsageWorker(): UsageWorkerTransport {
	if (usageWorkerInstance?.isShuttingDown()) {
		usageWorkerInstance.forceTerminate();
		usageWorkerInstance = null;
	}

	if (!usageWorkerInstance) {
		usageWorkerInstance = new UsageWorkerController({
			logger: log,
			shutdownDelayMs: TIMING.WORKER_SHUTDOWN_DELAY,
			onWorkerMessage: (data) => {
				if (data.type === "summary" && isRequestSummary(data.summary)) {
					requestEvents.emit("event", {
						type: "summary",
						payload: data.summary,
					});
				} else if (data.type === "payload" && isRequestPayload(data.payload)) {
					requestEvents.emit("event", {
						type: "payload",
						payload: data.payload,
					});
				}
			},
		});
	}
	return usageWorkerInstance;
}

export function getUsageWorkerHealth(): UsageWorkerHealthSnapshot {
	return (
		usageWorkerInstance?.getHealthSnapshot() ?? {
			state: "stopped",
			queuedMessages: 0,
			pendingAcks: 0,
			lastError: null,
			degradedSince: null,
			droppedMessages: {
				queuedChunks: 0,
				replayedChunks: 0,
				factMessages: 0,
				shutdownMessages: 0,
				usageFacts: 0,
			},
			payloadPersistenceFailures: 0,
		}
	);
}

/**
 * Gracefully terminates the usage worker
 */
export async function terminateUsageWorker(): Promise<void> {
	if (usageWorkerInstance) {
		const activeWorker = usageWorkerInstance;
		try {
			await usageWorkerInstance.terminateGracefully();
		} finally {
			if (usageWorkerInstance === activeWorker) {
				usageWorkerInstance = null;
			}
		}
	}
}

/**
 * Main proxy handler - orchestrates the entire proxy flow
 *
 * This function coordinates the proxy process by:
 * 1. Creating request metadata for tracking
 * 2. Preparing the request body for reuse
 * 3. Selecting accounts based on load balancing strategy
 * 4. Attempting to proxy with each account in order
 * 5. Falling back to unauthenticated proxy if no accounts available
 *
 * @param req - The incoming request
 * @param url - The parsed URL
 * @param ctx - The proxy context containing strategy, database, and provider
 * @returns Promise resolving to the proxied response
 * @throws {ServiceUnavailableError} If all accounts fail to proxy the request
 * @throws {ProviderError} If unauthenticated proxy fails
 */
async function handleProxyRequest(
	req: Request,
	url: URL,
	ctx: ProxyContext,
): Promise<Response> {
	const resolved = resolveProxyContext(url, ctx);
	if (!resolved) {
		return new Response("Not Found", { status: 404 });
	}
	// Native session metadata carries no inference usage. Retain account auth,
	// manual pauses and transport limits without charging model reservations.
	const requestContext = resolved.provider.isMetadataRequest?.(
		req.method,
		resolved.upstreamPath,
	)
		? { ...resolved, budgets: undefined }
		: resolved;

	// 1. Create request metadata before any buffering work so total timing
	// includes proxy-side request preparation overhead.
	const requestMeta = createRequestMetadata(req, url);
	requestEvents.emit("event", {
		type: "ingress",
		id: requestMeta.id,
		timestamp: requestMeta.timestamp,
		method: requestMeta.method,
		path: requestMeta.path,
	});

	// 2. Prepare request body
	let requestBodyBuffer: ArrayBuffer | null;
	try {
		({ buffer: requestBodyBuffer } = await prepareRequestBody(req));
	} catch {
		return Response.json(
			{
				error: {
					type: "invalid_request",
					message: "Request body exceeds 16 MiB or could not be read",
				},
			},
			{ status: 413 },
		);
	}
	try {
		requestBodyBuffer =
			requestContext.provider.prepareBody?.(requestBodyBuffer, req.headers) ??
			requestBodyBuffer;
	} catch {
		return Response.json(
			{
				error: {
					type: "invalid_request",
					message: "Invalid provider request settings",
				},
			},
			{ status: 400 },
		);
	}
	if (requestContext.budgets?.enabled) {
		try {
			const info = budgetRequestInfo(requestBodyBuffer);
			requestContext.budgetModel = info.model;
			requestContext.budgetWork = info.work;
		} catch {
			return Response.json(
				{
					error: {
						type: "invalid_request",
						message: "Invalid budget-managed request",
					},
				},
				{ status: 400 },
			);
		}
	}

	// 3. Select accounts
	const accounts = selectAccountsForRequest(requestMeta, requestContext);

	// 4. Handle no accounts case
	if (accounts.length === 0) {
		if (
			requestContext.budgets?.enabled ||
			requestContext.providerName === "lmstudio" ||
			requestContext.providerName === "grok-build"
		)
			return budgetUnavailable();
		return proxyUnauthenticated(
			req,
			url,
			requestMeta,
			requestBodyBuffer,
			() => {
				if (!requestBodyBuffer) return undefined;
				return new Response(requestBodyBuffer).body ?? undefined;
			},
			requestContext,
		);
	}

	// 5. Log selected accounts
	log.info(
		`Selected ${accounts.length} accounts: ${accounts.map((a) => a.name).join(", ")}`,
	);
	log.info(`Request: ${req.method} ${url.pathname}`);

	// 6. Try each account
	for (let i = 0; i < accounts.length; i++) {
		const response = await proxyWithAccount(
			req,
			url,
			accounts[i],
			requestMeta,
			requestBodyBuffer,
			() => {
				if (!requestBodyBuffer) return undefined;
				return new Response(requestBodyBuffer).body ?? undefined;
			},
			i,
			requestContext,
		);

		if (response) {
			return response;
		}
	}

	// 7. All accounts failed
	if (requestContext.budgets?.enabled) return budgetUnavailable();
	throw new ServiceUnavailableError(
		`${ERROR_MESSAGES.ALL_ACCOUNTS_FAILED} (${accounts.length} attempted)`,
		requestContext.providerName,
	);
}

export async function handleProxy(
	req: Request,
	url: URL,
	ctx: ProxyContext,
): Promise<Response> {
	if (req.method === "POST" && url.pathname.startsWith("/v1/lmstudio/")) {
		return localCapacity.run(
			(signal) => handleProxyRequest(new Request(req, { signal }), url, ctx),
			req.signal,
		);
	}
	return handleProxyRequest(req, url, ctx);
}
