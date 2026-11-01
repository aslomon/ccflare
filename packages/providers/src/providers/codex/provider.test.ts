import { afterEach, describe, expect, it } from "bun:test";
import {
	createJsonFetchMock,
	createOAuthAccount,
	expectBuildUrlCases,
	expectRemovedHeaders,
	expectUnifiedRateLimit,
	originalFetch,
} from "../../test-helpers";
import { CodexProvider } from "./provider";

describe("CodexProvider", () => {
	const provider = new CodexProvider();

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("builds backend-api URLs from the stripped Codex path", () => {
		expectBuildUrlCases(provider, [
			{
				upstreamPath: "/responses",
				expected: "https://chatgpt.com/backend-api/codex/responses",
			},
			{
				upstreamPath: "/responses",
				query: "?stream=true",
				expected: "https://chatgpt.com/backend-api/codex/responses?stream=true",
			},
			{
				upstreamPath: "/tasks",
				account: createOAuthAccount("codex", {
					base_url: "https://chatgpt.internal/backend-api/codex/",
				}),
				expected: "https://chatgpt.internal/backend-api/codex/tasks",
			},
		]);
	});

	it("injects Bearer auth plus Codex headers", () => {
		const headers = provider.prepareHeaders(
			new Headers({
				host: "localhost:8080",
				"x-api-key": "client-supplied-key",
				"anthropic-version": "2023-06-01",
				"accept-encoding": "gzip",
				"content-encoding": "gzip",
			}),
			createOAuthAccount("codex"),
		);

		expect(headers.get("authorization")).toBe("Bearer codex-access-token");
		expect(headers.get("originator")).toBe("codex_cli_rs");
		expect(headers.get("version")).toBe("0.164.0");
		expect(headers.get("user-agent")).toBe(
			"codex_cli_rs/0.164.0 (Mac OS; arm64)",
		);
		expectRemovedHeaders(headers, [
			"x-api-key",
			"anthropic-version",
			"host",
			"accept-encoding",
			"content-encoding",
		]);
	});

	it("forwards a Codex CLI user agent when its version matches", () => {
		const headers = provider.prepareHeaders(
			new Headers({
				version: "0.170.1",
				"user-agent": "codex_cli_rs/0.170.1 (Linux; x86_64)",
			}),
			createOAuthAccount("codex"),
		);

		expect(headers.get("version")).toBe("0.170.1");
		expect(headers.get("user-agent")).toBe(
			"codex_cli_rs/0.170.1 (Linux; x86_64)",
		);
		expect(headers.get("originator")).toBe("codex_cli_rs");
	});

	it("replaces a leading-zero version with the fallback pair", () => {
		const headers = provider.prepareHeaders(
			new Headers({
				version: "01.2.3",
				"user-agent": "codex_cli_rs/01.2.3 (Mac OS; arm64)",
			}),
			createOAuthAccount("codex"),
		);

		expect(headers.get("version")).toBe("0.164.0");
		expect(headers.get("user-agent")).toBe(
			"codex_cli_rs/0.164.0 (Mac OS; arm64)",
		);
	});

	it("replaces a non-CLI user agent and its version with the fallback pair", () => {
		const headers = provider.prepareHeaders(
			new Headers({
				version: "0.170.1",
				"user-agent": "Mozilla/5.0",
			}),
			createOAuthAccount("codex"),
		);

		expect(headers.get("version")).toBe("0.164.0");
		expect(headers.get("user-agent")).toBe(
			"codex_cli_rs/0.164.0 (Mac OS; arm64)",
		);
	});

	it("uses the CLI user-agent version when the version header is absent", () => {
		const headers = provider.prepareHeaders(
			new Headers({
				"user-agent": "codex_cli_rs/0.170.1 (Linux; x86_64)",
			}),
			createOAuthAccount("codex"),
		);

		expect(headers.get("version")).toBe("0.170.1");
		expect(headers.get("user-agent")).toBe(
			"codex_cli_rs/0.170.1 (Linux; x86_64)",
		);
	});

	it("replaces a CLI user agent whose version differs from the header", () => {
		const headers = provider.prepareHeaders(
			new Headers({
				version: "0.170.1",
				"user-agent": "codex_cli_rs/0.171.2 (Linux; x86_64)",
			}),
			createOAuthAccount("codex"),
		);

		expect(headers.get("version")).toBe("0.164.0");
		expect(headers.get("user-agent")).toBe(
			"codex_cli_rs/0.164.0 (Mac OS; arm64)",
		);
	});

	it("replaces a malformed Codex CLI user agent with the fallback pair", () => {
		const headers = provider.prepareHeaders(
			new Headers({
				version: "9.9.9",
				"user-agent": "codex_cli_rs/garbage",
			}),
			createOAuthAccount("codex"),
		);

		expect(headers.get("version")).toBe("0.164.0");
		expect(headers.get("user-agent")).toBe(
			"codex_cli_rs/0.164.0 (Mac OS; arm64)",
		);
	});

	it("ignores a malformed version header and falls back", () => {
		const headers = provider.prepareHeaders(
			new Headers({
				version: "0.164",
				"user-agent": "Mozilla/5.0",
			}),
			createOAuthAccount("codex"),
		);

		expect(headers.get("version")).toBe("0.164.0");
		expect(headers.get("user-agent")).toBe(
			"codex_cli_rs/0.164.0 (Mac OS; arm64)",
		);
	});

	it("falls back to Codex client 0.164.0 when version and user agent are absent", () => {
		const headers = provider.prepareHeaders(
			new Headers(),
			createOAuthAccount("codex"),
		);

		expect(headers.get("version")).toBe("0.164.0");
		expect(headers.get("user-agent")).toBe(
			"codex_cli_rs/0.164.0 (Mac OS; arm64)",
		);
		expect(headers.get("originator")).toBe("codex_cli_rs");
	});

	it("refreshes OAuth tokens via auth.openai.com with rotating refresh tokens", async () => {
		let requestUrl = "";
		let requestBody = "";

		globalThis.fetch = createJsonFetchMock(
			{
				access_token: "fresh-codex-access-token",
				refresh_token: "fresh-codex-refresh-token",
				expires_in: 1800,
			},
			async (request) => {
				requestUrl = request.url;
				requestBody = await request.text();
			},
		);

		const refreshed = await provider.refreshToken(
			createOAuthAccount("codex"),
			"unused-client-id",
		);

		expect(requestUrl).toBe("https://auth.openai.com/oauth/token");
		expect(requestBody).toContain("client_id=app_EMoamEEZ73f0CkXaXp7hrann");
		expect(requestBody).toContain("refresh_token=codex-refresh-token");
		expect(refreshed).toEqual({
			accessToken: "fresh-codex-access-token",
			refreshToken: "fresh-codex-refresh-token",
			expiresAt: expect.any(Number),
		});
	});

	it("parses Codex rate limit headers", () => {
		const fiveHourReset = Math.floor((Date.now() + 60_000) / 1000);
		const sevenDayReset = Math.floor((Date.now() + 120_000) / 1000);
		const response = new Response("{}", {
			status: 200,
			headers: {
				"x-codex-5h-reset-at": String(fiveHourReset),
				"x-codex-7d-reset-at": String(sevenDayReset),
				"x-codex-primary-used-percent": "12",
				"x-codex-secondary-used-percent": "4",
			},
		});

		expectUnifiedRateLimit(provider, response, {
			isRateLimited: false,
			resetTime: fiveHourReset * 1000,
			statusHeader: "allowed",
			remaining: undefined,
		});
	});
});
