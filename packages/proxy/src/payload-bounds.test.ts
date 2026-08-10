import { describe, expect, it } from "bun:test";
import type { RequestPayload } from "@ccflare/types";
import { boundRequestPayloadForStorage } from "./payload-bounds";

function createPayload(
	requestBody: string | null,
	responseBody: string | null,
): RequestPayload {
	return {
		id: "request-1",
		request: {
			headers: { "content-type": "application/json" },
			body: requestBody,
		},
		response: {
			status: 200,
			headers: { "content-type": "application/json" },
			body: responseBody,
		},
		meta: {
			trace: {
				timestamp: 1,
				provider: "openai",
				upstreamPath: "/responses",
				path: "/v1/openai/responses",
				method: "POST",
			},
			account: { id: "account-1" },
			transport: { success: true, isStream: false },
		},
	};
}

describe("boundRequestPayloadForStorage", () => {
	it("retains payloads that already fit", () => {
		const payload = createPayload("eHl6", "YWJj");

		const result = boundRequestPayloadForStorage(payload, 1024);

		expect(result.payload).toEqual(payload);
		expect(result.truncated).toBe(false);
	});

	it("truncates base64 bodies while keeping serialized payload under the cap", () => {
		const payload = createPayload("eA==".repeat(100), "eQ==".repeat(100));

		const result = boundRequestPayloadForStorage(payload, 512);

		expect(
			new TextEncoder().encode(JSON.stringify(result.payload)).byteLength,
		).toBeLessThanOrEqual(512);
		expect(result.truncated).toBe(true);
		expect(result.payload.request.body?.length ?? 0).toBeGreaterThan(0);
		expect(result.payload.response?.body?.length ?? 0).toBeGreaterThan(0);
		expect((result.payload.request.body?.length ?? 0) % 4).toBe(0);
		expect((result.payload.response?.body?.length ?? 0) % 4).toBe(0);
	});

	it("drops oversized header maps before violating the cap", () => {
		const payload = createPayload(null, null);
		payload.request.headers = { oversized: "x".repeat(1_000) };

		const result = boundRequestPayloadForStorage(payload, 512);

		expect(
			new TextEncoder().encode(JSON.stringify(result.payload)).byteLength,
		).toBeLessThanOrEqual(512);
		expect(result.payload.request.headers).toEqual({});
		expect(result.truncated).toBe(true);
	});
});
