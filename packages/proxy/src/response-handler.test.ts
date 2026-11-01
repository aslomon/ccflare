import { describe, expect, it } from "bun:test";
import { CodexProvider } from "@ccflare/providers";
import type { Account } from "@ccflare/types";
import { waitForProxyBackgroundTasks } from "./background-tasks";
import type { ResolvedProxyContext } from "./handlers";
import type { RawPayloadCapturePolicy } from "./payload-capture";
import { forwardToClient } from "./response-handler";

function createResolvedProxyContext(
	messages: unknown[],
	isStreamingResponse = false,
): ResolvedProxyContext {
	return {
		provider: {
			name: "openai",
			defaultBaseUrl: "https://api.openai.com",
			buildUrl() {
				return "https://api.openai.com/v1/responses";
			},
			prepareHeaders(headers: Headers) {
				return headers;
			},
			parseRateLimit() {
				return {
					isRateLimited: false,
					statusHeader: "allowed",
				};
			},
			extractUsage() {
				return null;
			},
			isStreamingResponse() {
				return isStreamingResponse;
			},
		},
		providerName: "openai",
		upstreamPath: "/responses",
		strategy: {
			select(accounts: Account[]) {
				return accounts;
			},
		},
		dbOps: {
			getAvailableAccountsByProvider() {
				return [];
			},
			updateAccountRateLimitMeta() {},
			markAccountRateLimited() {},
		},
		runtime: {
			clientId: "test-client",
			retry: { attempts: 1, delayMs: 0, backoff: 1 },
			sessionDurationMs: 0,
			port: 8080,
		},
		refreshInFlight: new Map(),
		asyncWriter: {
			enqueue() {},
		},
		usageWorker: {
			postMessage(message: unknown) {
				messages.push(message);
			},
		},
	} as unknown as ResolvedProxyContext;
}

describe("forwardToClient", () => {
	it("processes headerless Codex Responses SSE while raw retention is disabled", async () => {
		const messages: Array<Record<string, unknown>> = [];
		const context = createResolvedProxyContext(messages);
		context.provider = new CodexProvider();
		context.providerName = "codex";
		const stream =
			'event: response.completed\ndata: {"type":"response.completed","response":{"model":"gpt-example-luna","usage":{"input_tokens":19,"output_tokens":7,"total_tokens":26}}}\n\n';
		await forwardToClient(
			{
				requestId: "req-codex-sse",
				method: "POST",
				path: "/v1/codex/responses",
				account: null,
				requestHeaders: new Headers(),
				requestBody: null,
				response: new Response(new TextEncoder().encode(stream)),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
				rawPayloadPolicy: { enabled: false, maxBytesPerBody: 1024 },
			},
			context,
		);
		await waitForProxyBackgroundTasks();
		expect(messages.find((message) => message.type === "start")).toMatchObject({
			isStream: true,
			captureRawPayload: false,
		});
		expect(messages.find((message) => message.type === "chunk")?.data).toEqual(
			new TextEncoder().encode(stream),
		);
	});
	it("caps request and non-streaming response bodies before base64 encoding", async () => {
		const messages: Array<Record<string, unknown>> = [];
		const policy: RawPayloadCapturePolicy = {
			enabled: true,
			maxBytesPerBody: 4,
		};
		await forwardToClient(
			{
				requestId: "req-capped",
				method: "POST",
				path: "/v1/openai/responses",
				account: null,
				requestHeaders: new Headers(),
				requestBody: new Uint8Array([1, 2, 3, 4, 5, 6]).buffer,
				response: new Response(new Uint8Array([7, 8, 9, 10, 11, 12])),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
				rawPayloadPolicy: policy,
			},
			createResolvedProxyContext(messages),
		);
		await waitForProxyBackgroundTasks();

		const start = messages.find((message) => message.type === "start");
		const end = messages.find((message) => message.type === "end");
		expect(start).toMatchObject({
			captureRawPayload: true,
			requestBodyTruncated: true,
		});
		expect(Buffer.from(String(start?.requestBody), "base64")).toEqual(
			Buffer.from([1, 2, 3, 4]),
		);
		expect(end).toMatchObject({ responseBodyTruncated: true });
		expect(Buffer.from(String(end?.responseBody), "base64")).toEqual(
			Buffer.from([7, 8, 9, 10]),
		);
	});

	it("marks raw persistence disabled while usage processing continues", async () => {
		const messages: Array<Record<string, unknown>> = [];
		await forwardToClient(
			{
				requestId: "req-default-off",
				method: "POST",
				path: "/v1/openai/responses",
				account: null,
				requestHeaders: new Headers(),
				requestBody: new TextEncoder().encode('{"model":"gpt-5"}').buffer,
				response: new Response('{"usage":{"total_tokens":2}}'),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
				rawPayloadPolicy: { enabled: false, maxBytesPerBody: 1024 },
			},
			createResolvedProxyContext(messages),
		);
		await waitForProxyBackgroundTasks();

		expect(messages.find((message) => message.type === "start")).toMatchObject({
			captureRawPayload: false,
			requestBody: expect.any(String),
		});
		expect(messages.find((message) => message.type === "end")).toMatchObject({
			responseBody: expect.any(String),
		});
	});

	it("caps each stream chunk before posting it to the worker", async () => {
		const messages: Array<Record<string, unknown>> = [];
		await forwardToClient(
			{
				requestId: "req-stream",
				method: "POST",
				path: "/v1/openai/responses",
				account: null,
				requestHeaders: new Headers(),
				requestBody: null,
				response: new Response(new Uint8Array([1, 2, 3, 4, 5, 6])),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
				rawPayloadPolicy: { enabled: true, maxBytesPerBody: 4 },
			},
			createResolvedProxyContext(messages, true),
		);
		await waitForProxyBackgroundTasks();

		const chunk = messages.find((message) => message.type === "chunk");
		expect(chunk).toMatchObject({ dataTruncated: true });
		expect(chunk?.data).toEqual(new Uint8Array([1, 2, 3, 4]));
	});

	it("passes explicit pre-extracted models through to the worker end message", async () => {
		const messages: unknown[] = [];
		const response = await forwardToClient(
			{
				requestId: "req-1",
				method: "POST",
				path: "/v1/ccflare/openai/responses",
				account: null,
				requestHeaders: new Headers({ "content-type": "application/json" }),
				requestBody: new TextEncoder().encode(
					JSON.stringify({ model: "anthropic/claude-sonnet-4" }),
				).buffer,
				response: new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
				preExtractedModel: "claude-sonnet-4",
			},
			createResolvedProxyContext(messages),
		);

		expect(response.status).toBe(200);
		await waitForProxyBackgroundTasks();

		const endMessage = messages.find(
			(message) =>
				typeof message === "object" &&
				message !== null &&
				"type" in message &&
				message.type === "end",
		) as { preExtractedModel?: string } | undefined;

		expect(endMessage?.preExtractedModel).toBe("claude-sonnet-4");
	});
});
