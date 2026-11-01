import crypto from "node:crypto";
import { readBoundedBody } from "@ccflare/core";
import { isHttpMethod, type RequestMeta } from "@ccflare/types";

/**
 * Creates request metadata for tracking and analytics
 * @param req - The incoming request
 * @param url - The parsed URL
 * @returns Request metadata object
 */
export function createRequestMetadata(req: Request, url: URL): RequestMeta {
	return {
		id: crypto.randomUUID(),
		method: isHttpMethod(req.method) ? req.method : "GET",
		path: url.pathname,
		timestamp: Date.now(),
	};
}

/**
 * Prepares request body for analytics and creates body stream factory
 * @param req - The incoming request
 * @returns Object containing the buffered body and stream factory
 */
export async function prepareRequestBody(req: Request): Promise<{
	buffer: ArrayBuffer | null;
	createStream: () => ReadableStream<Uint8Array> | undefined;
}> {
	let buffer: ArrayBuffer | null = null;

	if (req.body) {
		buffer = await readBoundedBody(req, 16 * 1024 * 1024);
	}

	return {
		buffer,
		createStream: () => {
			if (!buffer) return undefined;
			return new Response(buffer).body ?? undefined;
		},
	};
}

/**
 * Makes the actual HTTP request to the provider
 * @param targetUrl - The target URL to fetch
 * @param method - HTTP method
 * @param headers - Request headers
 * @param createBodyStream - Function to create request body stream
 * @param hasBody - Whether the request has a body
 * @returns Promise resolving to the response
 */
export async function makeProxyRequest(
	targetUrl: string,
	method: string,
	headers: Headers,
	createBodyStream: () => ReadableStream<Uint8Array> | undefined,
	hasBody: boolean,
	signal?: AbortSignal,
): Promise<Response> {
	return fetch(targetUrl, {
		method,
		headers,
		signal,
		body: createBodyStream(),
		...(hasBody ? ({ duplex: "half" } as RequestInit) : {}),
	});
}
