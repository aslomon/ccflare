import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateCostUSD, requestEvents } from "@ccflare/core";
import { DatabaseFactory } from "@ccflare/database";
import { CodexProvider, ProviderRegistry } from "@ccflare/providers";
import {
	getUsageWorker,
	handleWebSocketUpgradeRequest,
	type ProxyContext,
	terminateUsageWorker,
	type WebSocketProxyData,
	websocketProxyHandler,
} from "@ccflare/proxy";
import type { Account, Request, RequestStreamEvent } from "@ccflare/types";
import {
	createCodexAccount,
	decodeMessageData,
	FakeServerWebSocket,
	type FakeUpstreamCapture,
	FakeUpstreamWebSocket,
	OriginalWebSocket,
	waitFor,
} from "./test-helpers/websocket";

let tempDir: string | null = null;

afterEach(async () => {
	await terminateUsageWorker();
	globalThis.WebSocket = OriginalWebSocket;
	FakeUpstreamWebSocket.reset();
	DatabaseFactory.reset();

	if (tempDir) {
		rmSync(tempDir, { force: true, recursive: true });
		tempDir = null;
	}

	delete process.env.ccflare_DB_PATH;
	delete process.env.ccflare_CONFIG_PATH;
	delete process.env.CF_RAW_PAYLOAD_CAPTURE;
});

function createLargeResponseCompletedMessage(sizeBytes: number): string {
	const oversizedInstructions = "x".repeat(sizeBytes);
	return JSON.stringify({
		type: "response.completed",
		response: {
			id: "resp_large",
			model: "gpt-4o",
			usage: {
				input_tokens: 21,
				output_tokens: 8,
				total_tokens: 29,
			},
			output: [
				{
					type: "message",
					role: "assistant",
					content: [
						{
							type: "output_text",
							text: "done",
						},
					],
				},
			],
			instructions: oversizedInstructions,
		},
	});
}

function insertCodexAccount(account: Account): void {
	DatabaseFactory.getInstance().createAccount({
		name: account.name,
		provider: account.provider,
		auth_method: account.auth_method,
		base_url: account.base_url,
		api_key: account.api_key,
		refresh_token: account.refresh_token,
		access_token: account.access_token,
		expires_at: account.expires_at,
		weight: account.weight,
	});
}

function createProxyContext(): ProxyContext {
	return {
		providerRegistry: new ProviderRegistry([new CodexProvider()]),
		strategy: {
			select(selectedAccounts: Account[]) {
				return selectedAccounts;
			},
		},
		dbOps: DatabaseFactory.getInstance(),
		runtime: {
			clientId: "test-client",
			retry: {
				attempts: 1,
				delayMs: 0,
				backoff: 1,
			},
			sessionDurationMs: 0,
			port: 8080,
		},
		refreshInFlight: new Map(),
		asyncWriter: {
			enqueue() {},
		},
		usageWorker: getUsageWorker(),
	} as unknown as ProxyContext;
}

describe("WebSocket request logging integration", () => {
	it("logs websocket turns to request history and emits real-time request events", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "ccflare-websocket-logging-"));
		process.env.ccflare_DB_PATH = join(tempDir, "ccflare.db");
		process.env.ccflare_CONFIG_PATH = join(tempDir, "ccflare.json");
		process.env.CF_RAW_PAYLOAD_CAPTURE = "1";
		DatabaseFactory.initialize();
		globalThis.WebSocket =
			FakeUpstreamWebSocket as unknown as typeof globalThis.WebSocket;

		const events: RequestStreamEvent[] = [];
		const handleRequestEvent = (event: RequestStreamEvent) => {
			events.push(event);
		};
		requestEvents.on("event", handleRequestEvent);

		try {
			insertCodexAccount(createCodexAccount());
			const ctx = createProxyContext();
			const url = new URL("http://localhost:8080/v1/codex/responses");
			let upgradeOptions:
				| {
						headers?: HeadersInit;
						data: WebSocketProxyData;
				  }
				| undefined;
			handleWebSocketUpgradeRequest(
				new Request(url, {
					method: "GET",
					headers: {
						connection: "Upgrade",
						upgrade: "websocket",
					},
				}),
				url,
				ctx,
				{
					upgrade(
						_request: Request,
						options?: { headers?: HeadersInit; data?: WebSocketProxyData },
					) {
						upgradeOptions = options as {
							headers?: HeadersInit;
							data: WebSocketProxyData;
						};
						return true;
					},
				} as unknown as Bun.Server<WebSocketProxyData>,
			);
			const downstream = new FakeServerWebSocket(
				upgradeOptions?.data as WebSocketProxyData,
			);
			websocketProxyHandler.open?.(
				downstream as unknown as Bun.ServerWebSocket<WebSocketProxyData>,
			);

			const capture = await waitFor(
				() => Promise.resolve(FakeUpstreamWebSocket.captures[0] ?? null),
				(value): value is FakeUpstreamCapture => value !== null,
			);

			websocketProxyHandler.message(
				downstream as unknown as Bun.ServerWebSocket<WebSocketProxyData>,
				'{"type":"response.create","model":"gpt-4o","input":"hello"}',
			);

			await waitFor(
				() => Promise.resolve(capture.sent[0] ?? null),
				(value): value is string | Uint8Array | ArrayBuffer => value !== null,
			);
			expect(decodeMessageData(capture.sent[0] as string)).toBe(
				'{"type":"response.create","model":"gpt-4o","input":"hello"}',
			);

			capture.socket.emitMessage(
				'{"type":"response.created","response":{"id":"resp_ws","model":"gpt-4o"}}',
			);
			capture.socket.emitMessage(
				'{"type":"response.output_text.delta","delta":"Hello"}',
			);
			capture.socket.emitMessage(
				'{"type":"response.completed","response":{"id":"resp_ws","model":"gpt-4o","usage":{"input_tokens":12,"output_tokens":4,"total_tokens":16}}}',
			);

			const dbOps = DatabaseFactory.getInstance();
			const loggedRequest = await waitFor(
				() => Promise.resolve(dbOps.getRecentRequests(1)[0] ?? null),
				(request): request is Request =>
					request !== null &&
					request.model === "gpt-4o" &&
					request.totalTokens === 16,
			);
			if (!loggedRequest) {
				throw new Error("Expected a logged websocket request");
			}
			expect(loggedRequest).toMatchObject({
				method: "WS",
				path: "/v1/codex/responses",
				provider: "codex",
				upstreamPath: "/responses",
				statusCode: 101,
				success: true,
				model: "gpt-4o",
				promptTokens: 12,
				completionTokens: 4,
				totalTokens: 16,
				inputTokens: 12,
				outputTokens: 4,
			});
			expect(loggedRequest.costUsd).toBe(
				await estimateCostUSD("gpt-4o", {
					inputTokens: 12,
					outputTokens: 4,
				}),
			);

			const persistedPayload = await waitFor(
				() =>
					Promise.resolve(
						dbOps.getRequestPayload(loggedRequest.id) as {
							request: { body: string | null };
							response: { body: string | null } | null;
						} | null,
					),
				(
					value,
				): value is {
					request: { body: string | null };
					response: { body: string | null } | null;
				} => value !== null,
			);
			if (!persistedPayload) {
				throw new Error("Expected persisted websocket payload");
			}
			expect(
				Buffer.from(persistedPayload.request.body as string, "base64").toString(
					"utf8",
				),
			).toBe('{"type":"response.create","model":"gpt-4o","input":"hello"}');
			expect(
				Buffer.from(
					persistedPayload.response?.body as string,
					"base64",
				).toString("utf8"),
			).toContain("event: response.completed");

			await waitFor(
				() =>
					Promise.resolve(
						events.some(
							(event) =>
								event.type === "summary" &&
								event.payload.id === loggedRequest.id,
						),
					),
				Boolean,
			);
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "start",
					method: "WS",
					path: "/v1/codex/responses",
					statusCode: 101,
				}),
			);
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "summary",
					payload: expect.objectContaining({
						id: loggedRequest.id,
						method: "WS",
						model: "gpt-4o",
						success: true,
					}),
				}),
			);
		} finally {
			requestEvents.off("event", handleRequestEvent);
		}
	});

	it("persists websocket token usage even when the model is missing", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "ccflare-websocket-logging-"));
		process.env.ccflare_DB_PATH = join(tempDir, "ccflare.db");
		process.env.ccflare_CONFIG_PATH = join(tempDir, "ccflare.json");
		DatabaseFactory.initialize();
		globalThis.WebSocket =
			FakeUpstreamWebSocket as unknown as typeof globalThis.WebSocket;

		insertCodexAccount(createCodexAccount());
		const ctx = createProxyContext();
		const url = new URL("http://localhost:8080/v1/codex/responses");
		let upgradeOptions:
			| {
					headers?: HeadersInit;
					data: WebSocketProxyData;
			  }
			| undefined;
		handleWebSocketUpgradeRequest(
			new Request(url, {
				method: "GET",
				headers: {
					connection: "Upgrade",
					upgrade: "websocket",
				},
			}),
			url,
			ctx,
			{
				upgrade(
					_request: Request,
					options?: { headers?: HeadersInit; data?: WebSocketProxyData },
				) {
					upgradeOptions = options as {
						headers?: HeadersInit;
						data: WebSocketProxyData;
					};
					return true;
				},
			} as unknown as Bun.Server<WebSocketProxyData>,
		);
		const downstream = new FakeServerWebSocket(
			upgradeOptions?.data as WebSocketProxyData,
		);
		websocketProxyHandler.open?.(
			downstream as unknown as Bun.ServerWebSocket<WebSocketProxyData>,
		);

		const capture = await waitFor(
			() => Promise.resolve(FakeUpstreamWebSocket.captures[0] ?? null),
			(value): value is FakeUpstreamCapture => value !== null,
		);

		websocketProxyHandler.message(
			downstream as unknown as Bun.ServerWebSocket<WebSocketProxyData>,
			'{"type":"response.create","input":"hello without a model"}',
		);

		await waitFor(
			() => Promise.resolve(capture.sent.length),
			(length) => length > 0,
		);

		capture.socket.emitMessage(
			'{"type":"response.created","response":{"id":"resp_missing_model"}}',
		);
		capture.socket.emitMessage(
			'{"type":"response.output_text.delta","delta":"Hello"}',
		);
		capture.socket.emitMessage(
			'{"type":"response.completed","response":{"id":"resp_missing_model","usage":{"input_tokens":7,"output_tokens":2,"total_tokens":9}}}',
		);

		const dbOps = DatabaseFactory.getInstance();
		const loggedRequest = await waitFor(
			() => Promise.resolve(dbOps.getRecentRequests(1)[0] ?? null),
			(request): request is Request =>
				request !== null && request.totalTokens === 9,
		);

		expect(loggedRequest).toMatchObject({
			model: "unknown",
			totalTokens: 9,
			inputTokens: 7,
			outputTokens: 2,
			costUsd: null,
		});
	});

	it("persists cached input token discounts and reasoning tokens from websocket usage", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "ccflare-websocket-logging-"));
		process.env.ccflare_DB_PATH = join(tempDir, "ccflare.db");
		process.env.ccflare_CONFIG_PATH = join(tempDir, "ccflare.json");
		DatabaseFactory.initialize();
		globalThis.WebSocket =
			FakeUpstreamWebSocket as unknown as typeof globalThis.WebSocket;

		insertCodexAccount(createCodexAccount());
		const ctx = createProxyContext();
		const url = new URL("http://localhost:8080/v1/codex/responses");
		let upgradeOptions:
			| {
					headers?: HeadersInit;
					data: WebSocketProxyData;
			  }
			| undefined;
		handleWebSocketUpgradeRequest(
			new Request(url, {
				method: "GET",
				headers: {
					connection: "Upgrade",
					upgrade: "websocket",
				},
			}),
			url,
			ctx,
			{
				upgrade(
					_request: Request,
					options?: { headers?: HeadersInit; data?: WebSocketProxyData },
				) {
					upgradeOptions = options as {
						headers?: HeadersInit;
						data: WebSocketProxyData;
					};
					return true;
				},
			} as unknown as Bun.Server<WebSocketProxyData>,
		);
		const downstream = new FakeServerWebSocket(
			upgradeOptions?.data as WebSocketProxyData,
		);
		websocketProxyHandler.open?.(
			downstream as unknown as Bun.ServerWebSocket<WebSocketProxyData>,
		);

		const capture = await waitFor(
			() => Promise.resolve(FakeUpstreamWebSocket.captures[0] ?? null),
			(value): value is FakeUpstreamCapture => value !== null,
		);

		websocketProxyHandler.message(
			downstream as unknown as Bun.ServerWebSocket<WebSocketProxyData>,
			'{"type":"response.create","model":"gpt-4o","input":"cached hello"}',
		);

		await waitFor(
			() => Promise.resolve(capture.sent.length),
			(length) => length > 0,
		);

		capture.socket.emitMessage(
			'{"type":"response.created","response":{"id":"resp_cached","model":"gpt-4o"}}',
		);
		capture.socket.emitMessage(
			'{"type":"response.completed","response":{"id":"resp_cached","model":"gpt-4o","usage":{"input_tokens":18815,"output_tokens":431,"total_tokens":19246,"input_tokens_details":{"cached_tokens":18688},"output_tokens_details":{"reasoning_tokens":321}}}}',
		);

		const dbOps = DatabaseFactory.getInstance();
		const loggedRequest = await waitFor(
			() => Promise.resolve(dbOps.getRecentRequests(1)[0] ?? null),
			(request): request is Request =>
				request !== null && request.totalTokens === 19246,
		);
		if (!loggedRequest) {
			throw new Error("Expected websocket request with cached token usage");
		}

		expect(loggedRequest).toMatchObject({
			model: "gpt-4o",
			inputTokens: 127,
			cacheReadInputTokens: 18688,
			outputTokens: 431,
			reasoningTokens: 321,
			totalTokens: 19246,
		});
		expect(loggedRequest.costUsd).toBe(
			await estimateCostUSD("gpt-4o", {
				inputTokens: 127,
				cacheReadInputTokens: 18688,
				outputTokens: 431,
			}),
		);
	});

	it("persists websocket token usage when response.completed exceeds the SSE usage buffer", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "ccflare-websocket-logging-"));
		process.env.ccflare_DB_PATH = join(tempDir, "ccflare.db");
		process.env.ccflare_CONFIG_PATH = join(tempDir, "ccflare.json");
		DatabaseFactory.initialize();
		globalThis.WebSocket =
			FakeUpstreamWebSocket as unknown as typeof globalThis.WebSocket;

		insertCodexAccount(createCodexAccount());
		const ctx = createProxyContext();
		const url = new URL("http://localhost:8080/v1/codex/responses");
		let upgradeOptions:
			| {
					headers?: HeadersInit;
					data: WebSocketProxyData;
			  }
			| undefined;
		handleWebSocketUpgradeRequest(
			new Request(url, {
				method: "GET",
				headers: {
					connection: "Upgrade",
					upgrade: "websocket",
				},
			}),
			url,
			ctx,
			{
				upgrade(
					_request: Request,
					options?: { headers?: HeadersInit; data?: WebSocketProxyData },
				) {
					upgradeOptions = options as {
						headers?: HeadersInit;
						data: WebSocketProxyData;
					};
					return true;
				},
			} as unknown as Bun.Server<WebSocketProxyData>,
		);
		const downstream = new FakeServerWebSocket(
			upgradeOptions?.data as WebSocketProxyData,
		);
		websocketProxyHandler.open?.(
			downstream as unknown as Bun.ServerWebSocket<WebSocketProxyData>,
		);

		const capture = await waitFor(
			() => Promise.resolve(FakeUpstreamWebSocket.captures[0] ?? null),
			(value): value is FakeUpstreamCapture => value !== null,
		);

		websocketProxyHandler.message(
			downstream as unknown as Bun.ServerWebSocket<WebSocketProxyData>,
			'{"type":"response.create","model":"gpt-4o","input":"hello"}',
		);

		await waitFor(
			() => Promise.resolve(capture.sent.length),
			(length) => length > 0,
		);

		capture.socket.emitMessage(
			'{"type":"response.created","response":{"id":"resp_large","model":"gpt-4o"}}',
		);
		capture.socket.emitMessage(createLargeResponseCompletedMessage(350 * 1024));

		const dbOps = DatabaseFactory.getInstance();
		const loggedRequest = await waitFor(
			() => Promise.resolve(dbOps.getRecentRequests(1)[0] ?? null),
			(request): request is Request =>
				request !== null && request.totalTokens === 29,
		);

		expect(loggedRequest).toMatchObject({
			model: "gpt-4o",
			totalTokens: 29,
			inputTokens: 21,
			outputTokens: 8,
		});
	});
});
