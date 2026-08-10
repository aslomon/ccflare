import type { RequestPayload } from "@ccflare/types";

export const MAX_STORED_PAYLOAD_BYTES = 1024 * 1024;

interface BoundedRequestPayload {
	payload: RequestPayload;
	truncated: boolean;
}

const textEncoder = new TextEncoder();

function serializedBytes(payload: RequestPayload): number {
	return textEncoder.encode(JSON.stringify(payload)).byteLength;
}

function withoutBodies(payload: RequestPayload): RequestPayload {
	return {
		...payload,
		request: {
			...payload.request,
			body: payload.request.body === null ? null : "",
		},
		response: payload.response
			? {
					...payload.response,
					body: payload.response.body === null ? null : "",
				}
			: null,
	};
}

function withoutHeaders(payload: RequestPayload): RequestPayload {
	return {
		...payload,
		request: { ...payload.request, headers: {} },
		response: payload.response ? { ...payload.response, headers: {} } : null,
	};
}

function base64Budget(bytes: number): number {
	return Math.max(0, Math.floor(bytes / 4) * 4);
}

function allocateBodyBytes(
	requestLength: number,
	responseLength: number,
	availableBytes: number,
): { requestBytes: number; responseBytes: number } {
	const totalLength = requestLength + responseLength;
	if (totalLength === 0) return { requestBytes: 0, responseBytes: 0 };
	const requestShare = Math.floor(
		(availableBytes * requestLength) / totalLength,
	);
	const requestBytes = Math.min(requestLength, base64Budget(requestShare));
	const responseBytes = Math.min(
		responseLength,
		base64Budget(availableBytes - requestBytes),
	);
	return { requestBytes, responseBytes };
}

export function boundRequestPayloadForStorage(
	payload: RequestPayload,
	maxBytes = MAX_STORED_PAYLOAD_BYTES,
): BoundedRequestPayload {
	if (serializedBytes(payload) <= maxBytes) {
		return { payload, truncated: false };
	}

	let base = withoutBodies(payload);
	let headersDropped = false;
	if (serializedBytes(base) > maxBytes) {
		base = withoutHeaders(base);
		headersDropped = true;
	}

	const requestBody = payload.request.body ?? "";
	const responseBody = payload.response?.body ?? "";
	const availableBytes = Math.max(0, maxBytes - serializedBytes(base));
	const allocation = allocateBodyBytes(
		requestBody.length,
		responseBody.length,
		availableBytes,
	);
	const bounded: RequestPayload = {
		...base,
		request: {
			...base.request,
			body:
				payload.request.body === null
					? null
					: requestBody.slice(0, allocation.requestBytes),
		},
		response: base.response
			? {
					...base.response,
					body:
						payload.response?.body === null
							? null
							: responseBody.slice(0, allocation.responseBytes),
				}
			: null,
	};

	return {
		payload: bounded,
		truncated:
			headersDropped ||
			allocation.requestBytes < requestBody.length ||
			allocation.responseBytes < responseBody.length,
	};
}
