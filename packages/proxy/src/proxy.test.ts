import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { budgetPolicySchema, requestEvents } from "@ccflare/core";
import { BudgetRepository, DatabaseOperations } from "@ccflare/database";
import { type Provider, ProviderRegistry } from "@ccflare/providers";
import type { Account } from "@ccflare/types";
import { BudgetControl } from "./budget/control";
import { handleCompatibilityProxy } from "./compat/handler";
import { handleProxy, type ProxyContext } from "./proxy";

const originalFetch = globalThis.fetch;

function createTestProvider(name: string): Provider {
	return {
		name,
		defaultBaseUrl: `https://${name}.example.com`,
		async refreshToken(_account: Account, _clientId: string) {
			throw new Error("not implemented");
		},
		buildUrl(upstreamPath: string, query: string, account?: Account): string {
			return `${account?.base_url ?? this.defaultBaseUrl}${upstreamPath}${query}`;
		},
		prepareHeaders(headers: Headers): Headers {
			return new Headers(headers);
		},
		parseRateLimit() {
			return { isRateLimited: false };
		},
		async processResponse(response: Response): Promise<Response> {
			return response;
		},
	};
}

function createProxyContext(providers: Provider[]): ProxyContext {
	return {
		providerRegistry: new ProviderRegistry(providers),
		strategy: {
			select() {
				return [];
			},
		},
		dbOps: {
			getAllAccounts() {
				return [];
			},
			getAvailableAccountsByProvider() {
				return [];
			},
		},
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
		usageWorker: {
			postMessage() {},
		} as unknown as Worker,
	} as unknown as ProxyContext;
}

afterEach(() => {
	requestEvents.removeAllListeners("event");
	globalThis.fetch = originalFetch;
	mock.restore();
});

describe("handleProxy routing", () => {
	it("blocks quota-managed native and compatibility requests without credential passthrough", async () => {
		const context = createProxyContext([
			createTestProvider("claude-code"),
			createTestProvider("anthropic"),
		]);
		const db = new DatabaseOperations(":memory:");
		context.dbOps = db;
		const account = db.createOAuthAccount({
			name: "test",
			provider: "claude-code",
			accessToken: "test",
			refreshToken: "test",
		});
		const budgets = new BudgetControl(
			db,
			new BudgetRepository(db.getDatabase()),
			budgetPolicySchema.parse({ enabled: true }),
		);
		context.budgets = budgets;
		const fakeFetch = Object.assign(async () => new Response("{}"), {
			preconnect: globalThis.fetch.preconnect,
		});
		const fetcher = spyOn(globalThis, "fetch").mockImplementation(fakeFetch);
		const native = new Request("http://local/v1/claude-code/v1/messages", {
			method: "POST",
			body: JSON.stringify({ model: "claude-sonnet", max_tokens: 10 }),
			headers: { Authorization: "Bearer passthrough" },
		});
		expect(
			(await handleProxy(native, new URL(native.url), context)).status,
		).toBe(503);
		budgets.observe(account, {
			source: "claude-oauth",
			observedAt: Date.now(),
			windows: [
				{
					key: "seven_day",
					usedPercent: 85,
					resetAt: Date.now() + 86_400_000,
					model: null,
				},
			],
		});
		const compat = new Request("http://local/v1/ccflare/anthropic/messages", {
			method: "POST",
			body: JSON.stringify({
				model: "anthropic/claude-sonnet",
				max_tokens: 10,
				messages: [],
			}),
		});
		expect(
			(await handleCompatibilityProxy(compat, new URL(compat.url), context))
				?.status,
		).toBe(503);
		expect(fetcher).not.toHaveBeenCalled();
		fetcher.mockRestore();
		db.close();
	});
	it("returns 404 for an unknown provider", async () => {
		const response = await handleProxy(
			new Request("http://localhost:8080/v1/google/v1/chat", {
				method: "POST",
			}),
			new URL("http://localhost:8080/v1/google/v1/chat"),
			createProxyContext([createTestProvider("anthropic")]),
		);

		expect(response.status).toBe(404);
	});

	it("returns 404 for a bare /v1/ path", async () => {
		const response = await handleProxy(
			new Request("http://localhost:8080/v1/"),
			new URL("http://localhost:8080/v1/"),
			createProxyContext([createTestProvider("anthropic")]),
		);

		expect(response.status).toBe(404);
	});

	it("matches providers case-sensitively", async () => {
		const response = await handleProxy(
			new Request("http://localhost:8080/v1/Anthropic/v1/messages", {
				method: "POST",
			}),
			new URL("http://localhost:8080/v1/Anthropic/v1/messages"),
			createProxyContext([createTestProvider("anthropic")]),
		);

		expect(response.status).toBe(404);
	});

	it("emits an ingress event before the upstream response is available", async () => {
		const fetchControl: { resolve?: (response: Response) => void } = {};
		const fetchPromise = new Promise<Response>((resolve) => {
			fetchControl.resolve = resolve;
		});
		const fetchMock = mock(() => fetchPromise);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const events: Array<unknown> = [];
		requestEvents.on("event", (event) => {
			events.push(event);
		});

		const responsePromise = handleProxy(
			new Request("http://localhost:8080/v1/anthropic/v1/messages", {
				method: "POST",
			}),
			new URL("http://localhost:8080/v1/anthropic/v1/messages"),
			createProxyContext([createTestProvider("anthropic")]),
		);

		expect(events).toContainEqual({
			type: "ingress",
			id: expect.any(String),
			timestamp: expect.any(Number),
			method: "POST",
			path: "/v1/anthropic/v1/messages",
		});
		await Promise.resolve();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const resolveFetch = fetchControl.resolve;
		if (!resolveFetch) {
			throw new Error("Expected fetch resolver to be assigned");
		}
		resolveFetch(new Response("ok", { status: 200 }));
		const response = await responsePromise;

		expect(response.status).toBe(200);
	});
});

it("never falls through to unauthenticated LM Studio when its account is paused or missing", async () => {
	const ctx = createProxyContext([createTestProvider("lmstudio")]);
	const response = await handleProxy(
		new Request("http://localhost/v1/lmstudio/v1/messages", {
			method: "POST",
			body: JSON.stringify({ model: "qwen/test" }),
		}),
		new URL("http://localhost/v1/lmstudio/v1/messages"),
		ctx,
	);
	expect(response.status).toBe(503);
	await response.text();
});
