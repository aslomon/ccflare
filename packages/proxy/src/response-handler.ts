import { requestEvents } from "@ccflare/core";
import {
	sanitizeRequestHeaders,
	withSanitizedProxyHeaders,
} from "@ccflare/http";
import type { Account, HttpMethod } from "@ccflare/types";
import { trackProxyBackgroundTask } from "./background-tasks";
import type { ResolvedProxyContext } from "./handlers";
import {
	createRawPayloadCaptureCounters,
	limitCapturedBytes,
	loadRawPayloadCapturePolicy,
	type RawPayloadCapturePolicy,
	readBoundedResponseBody,
} from "./payload-capture";
import type { ChunkMessage, EndMessage, StartMessage } from "./worker-messages";

/**
 * Check if a response should be considered successful/expected
 * Treats certain well-known paths that return 404 as expected
 */
function isExpectedResponse(path: string, response: Response): boolean {
	// Any .well-known path returning 404 is expected
	if (path.startsWith("/.well-known/") && response.status === 404) {
		return true;
	}

	// Otherwise use standard HTTP success logic
	return response.ok;
}

export interface ResponseHandlerOptions {
	requestId: string;
	method: HttpMethod;
	path: string;
	account: Account | null;
	requestHeaders: Headers;
	requestBody: ArrayBuffer | null;
	response: Response;
	timestamp: number;
	upstreamRequestStartedAt?: number;
	responseHeadersReceivedAt?: number;
	retryAttempt: number;
	failoverAttempts: number;
	preExtractedModel?: string;
	rawPayloadPolicy?: RawPayloadCapturePolicy;
}

const rawPayloadCaptureCounters = createRawPayloadCaptureCounters();

export function getRawPayloadCaptureSnapshot() {
	return rawPayloadCaptureCounters.snapshot();
}

/**
 * Unified response handler that immediately streams responses
 * while forwarding data to worker for async processing.
 */
export async function forwardToClient(
	options: ResponseHandlerOptions,
	ctx: ResolvedProxyContext,
): Promise<Response> {
	const {
		requestId,
		method,
		path,
		account,
		requestHeaders,
		requestBody,
		response: responseRaw,
		timestamp,
		upstreamRequestStartedAt,
		responseHeadersReceivedAt,
		retryAttempt, // Always 0 in new flow, but kept for message compatibility
		failoverAttempts,
		preExtractedModel,
		rawPayloadPolicy,
	} = options;
	const capturePolicy = rawPayloadPolicy ?? loadRawPayloadCapturePolicy();

	// Always strip compression headers *before* we do anything else
	const response = withSanitizedProxyHeaders(responseRaw);

	// Prepare objects once for serialisation - sanitize headers before storing
	const sanitizedReq = sanitizeRequestHeaders(requestHeaders);
	const requestHeadersObj = Object.fromEntries(sanitizedReq.entries());

	const responseHeadersObj = Object.fromEntries(response.headers.entries());

	const isStream = ctx.provider.isStreamingResponse?.(response) ?? false;
	const limitedRequestBody = limitCapturedBytes(
		requestBody ? new Uint8Array(requestBody) : null,
		capturePolicy,
		rawPayloadCaptureCounters,
	);

	// Send START message immediately
	const startMessage: StartMessage = {
		type: "start",
		requestId,
		accountId: account?.id || null,
		method,
		path,
		upstreamPath: ctx.upstreamPath,
		timestamp,
		upstreamRequestStartedAt,
		responseHeadersReceivedAt,
		requestHeaders: requestHeadersObj,
		requestBody: limitedRequestBody.bytes
			? Buffer.from(limitedRequestBody.bytes).toString("base64")
			: null,
		captureRawPayload: capturePolicy.enabled,
		rawPayloadMaxBytes: capturePolicy.maxBytesPerBody,
		requestBodyTruncated: limitedRequestBody.truncated,
		responseStatus: response.status,
		responseHeaders: responseHeadersObj,
		isStream,
		providerName: ctx.providerName,
		retryAttempt,
		failoverAttempts,
	};
	ctx.usageWorker.postMessage(startMessage);

	// Emit request start event for real-time dashboard
	requestEvents.emit("event", {
		type: "start",
		id: requestId,
		timestamp,
		method,
		path,
		accountId: account?.id || null,
		statusCode: response.status,
	});

	/*********************************************************************
	 *  STREAMING RESPONSES — tee with Response.clone() and send chunks
	 *********************************************************************/
	if (isStream && response.body) {
		// Clone response once for background consumption.
		const analyticsClone = response.clone();

		const backgroundTask = (async () => {
			try {
				const reader = analyticsClone.body?.getReader();
				if (!reader) return; // Safety check
				// eslint-disable-next-line no-constant-condition
				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					if (value) {
						const limitedChunk = limitCapturedBytes(
							value,
							capturePolicy,
							rawPayloadCaptureCounters,
						);
						const chunkMsg: ChunkMessage = {
							type: "chunk",
							requestId,
							data: limitedChunk.bytes ?? new Uint8Array(),
							dataTruncated: limitedChunk.truncated,
						};
						ctx.usageWorker.postMessage(chunkMsg);
					}
				}
				// Finished without errors
				const endMsg: EndMessage = {
					type: "end",
					requestId,
					preExtractedModel,
					success: isExpectedResponse(path, analyticsClone),
				};
				ctx.usageWorker.postMessage(endMsg);
			} catch (err) {
				const endMsg: EndMessage = {
					type: "end",
					requestId,
					preExtractedModel,
					success: false,
					error: err instanceof Error ? err.message : String(err),
				};
				ctx.usageWorker.postMessage(endMsg);
			}
		})();
		trackProxyBackgroundTask(backgroundTask);

		// Return the sanitized response
		return response;
	}

	/*********************************************************************
	 *  NON-STREAMING RESPONSES — read body in background, send END once
	 *********************************************************************/
	const backgroundTask = (async () => {
		try {
			const clone = response.clone();
			const body = await readBoundedResponseBody(
				clone,
				capturePolicy.maxBytesPerBody,
			);
			if (body.bytes) {
				if (capturePolicy.enabled) {
					rawPayloadCaptureCounters.recordCaptured(body.droppedBytes);
				} else {
					rawPayloadCaptureCounters.recordDisabled();
				}
			}
			const endMsg: EndMessage = {
				type: "end",
				requestId,
				responseBody: body.bytes
					? Buffer.from(body.bytes).toString("base64")
					: null,
				responseBodyTruncated: body.truncated,
				preExtractedModel,
				success: isExpectedResponse(path, clone),
			};
			ctx.usageWorker.postMessage(endMsg);
		} catch (err) {
			const endMsg: EndMessage = {
				type: "end",
				requestId,
				preExtractedModel,
				success: false,
				error: err instanceof Error ? err.message : String(err),
			};
			ctx.usageWorker.postMessage(endMsg);
		}
	})();
	trackProxyBackgroundTask(backgroundTask);

	// Return the sanitized response
	return response;
}
