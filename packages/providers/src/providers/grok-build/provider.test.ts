import { describe, expect, it } from "bun:test";
import { zstdCompressSync } from "node:zlib";
import { budgetProfileSchema } from "@ccflare/core";
import { createOAuthAccount } from "../../test-helpers";
import { parseGrokCredential } from "./credential";
import { GrokBuildProvider } from "./provider";
import { parseGrokQuota } from "./quota";

const identity = "user-123";
const value = {
	key: "native-access-token",
	auth_mode: "oidc",
	user_id: identity,
	expires_at: "2099-01-01T00:00:00Z",
	oidc_issuer: "https://auth.x.ai",
	oidc_client_id: "cli-client",
};
const store = { "https://auth.x.ai::cli-client": value };
const credential = () => parseGrokCredential(store);
const account = () =>
	createOAuthAccount("grok-build", {
		refresh_token: `grok-cli:${identity}`,
		access_token: "old-token",
	});
const provider = new GrokBuildProvider(credential, async () => {});

it("decodes native zstd within 16 MiB and removes the compressed length", () => {
	const text = JSON.stringify({ model: "grok-4.7", input: "x".repeat(70_000) });
	const encoded = new Uint8Array(zstdCompressSync(Buffer.from(text))).buffer;
	const headers = new Headers({
		"content-encoding": "zstd",
		"content-length": "32",
	});
	const result = provider.prepareBody(encoded, headers);
	expect(new TextDecoder().decode(result ?? undefined)).toBe(text);
	expect(
		provider.prepareHeaders(headers, account()).get("content-length"),
	).toBeNull();
	const oversized = new Uint8Array(
		zstdCompressSync(Buffer.alloc(16 * 1024 * 1024 + 1)),
	).buffer;
	expect(() => provider.prepareBody(oversized, headers)).toThrow();
	expect(() => provider.prepareBody(new ArrayBuffer(2), headers)).toThrow();
	expect(() =>
		provider.prepareBody(
			encoded,
			new Headers({ "content-encoding": "unknown" }),
		),
	).toThrow();
});

it("classifies only known quota-free metadata routes", () => {
	expect(provider.isMetadataRequest("GET", "/models")).toBe(true);
	expect(
		provider.isMetadataRequest(
			"POST",
			"/sessions/01a0fd12-06dc-71a2-896f-510100d07d84/signals",
		),
	).toBe(true);
	for (const path of [
		"/responses",
		"/chat/completions",
		"/messages",
		"/unknown",
		"/sessions/not-an-id/signals",
	])
		expect(provider.isMetadataRequest("POST", path)).toBe(false);
	expect(provider.isMetadataRequest("POST", "/models")).toBe(false);
});

describe("native Grok subscription isolation", () => {
	it("routes to the subscription origin and preserves native request headers", () => {
		expect(provider.buildUrl("/responses", "?stream=true")).toBe(
			"https://cli-chat-proxy.grok.com/v1/responses?stream=true",
		);
		const headers = provider.prepareHeaders(
			new Headers({
				authorization: "Bearer incoming-other-account",
				"x-grok-session-id": "session",
				"x-api-key": "paid-api-key",
				"anthropic-version": "2023-06-01",
				host: "localhost",
			}),
			account(),
		);
		expect(headers.get("authorization")).toBe("Bearer native-access-token");
		expect(headers.get("x-userid")).toBe(identity);
		expect(headers.get("x-grok-session-id")).toBe("session");
		expect(headers.get("x-api-key")).toBeNull();
		expect(headers.get("anthropic-version")).toBeNull();
		expect(headers.get("host")).toBeNull();
	});
	it("fails closed on anonymous, mismatched and expired credentials", () => {
		expect(() => provider.prepareHeaders(new Headers(), null)).toThrow();
		expect(() =>
			provider.prepareHeaders(
				new Headers(),
				createOAuthAccount("grok-build", {
					refresh_token: "grok-cli:other-user",
				}),
			),
		).toThrow();
		const expired = new GrokBuildProvider(
			() =>
				parseGrokCredential({
					"https://auth.x.ai::cli-client": {
						...value,
						expires_at: "2020-01-01T00:00:00Z",
					},
				}),
			async () => {},
		);
		expect(() => expired.prepareHeaders(new Headers(), account())).toThrow();
	});
	it("accepts only a single matching first-party OAuth scope", () => {
		expect(credential().user_id).toBe(identity);
		for (const invalid of [
			null,
			{},
			{ bad: value },
			{
				"https://auth.x.ai::cli-client": { ...value, auth_mode: "api_key" },
			},
			{
				"https://auth.x.ai::cli-client": {
					...value,
					oidc_issuer: "https://evil.example",
				},
			},
			{
				...store,
				"https://auth.x.ai::second": { ...value, oidc_client_id: "second" },
			},
		])
			expect(() => parseGrokCredential(invalid)).toThrow();
	});
	it("lets the CLI refresh its own token and checks identity again", async () => {
		let current = { ...value, expires_at: "2020-01-01T00:00:00Z" };
		const refreshed = new GrokBuildProvider(
			() =>
				parseGrokCredential({
					"https://auth.x.ai::cli-client": current,
				}),
			async () => {
				current = value;
			},
		);
		expect((await refreshed.refreshToken(account())).accessToken).toBe(
			value.key,
		);
		const wrong = new GrokBuildProvider(credential, async () => {});
		expect(
			wrong.refreshToken(createOAuthAccount("grok-build")),
		).rejects.toThrow();
	});
	it("honors Retry-After as seconds rather than a Unix timestamp", () => {
		const before = Date.now();
		const limit = provider.parseRateLimit(
			new Response(null, {
				status: 429,
				headers: { "retry-after": "60" },
			}),
		);
		expect(limit.isRateLimited).toBe(true);
		expect(limit.resetTime).toBeGreaterThanOrEqual(before + 60_000);
		expect(provider.parseRateLimit(new Response()).isRateLimited).toBe(false);
	});
});

describe("Grok weekly subscription quota", () => {
	const now = Date.parse("2026-10-02T14:15:00Z");
	const config = {
		currentPeriod: {
			type: "USAGE_PERIOD_TYPE_WEEKLY",
			start: "2026-10-02T14:12:57Z",
			end: "2026-10-09T14:12:57Z",
		},
	};
	it("uses authoritative usage and the actual weekly reset", () => {
		const quota = parseGrokQuota(
			{ config: { ...config, creditUsagePercent: 17.4 } },
			now,
		);
		expect(quota.source).toBe("grok-build");
		expect(quota.windows[0]?.usedPercent).toBe(17.4);
		expect(quota.windows[0]?.resetAt).toBe(
			Date.parse(config.currentPeriod.end),
		);
		expect(budgetProfileSchema.parse({ mode: "grok" }).mode).toBe("grok");
	});
	it("accepts protobuf-omitted zero only with a valid current weekly period", () => {
		expect(parseGrokQuota({ config }, now).windows[0]?.usedPercent).toBe(0);
		for (const invalid of [
			{},
			{ config: {} },
			{ config: { ...config, creditUsagePercent: -1 } },
			{
				config: {
					...config,
					currentPeriod: {
						...config.currentPeriod,
						type: "USAGE_PERIOD_TYPE_MONTHLY",
					},
				},
			},
		])
			expect(() => parseGrokQuota(invalid, now)).toThrow();
		expect(() =>
			parseGrokQuota({ config }, Date.parse("2026-10-10T00:00:00Z")),
		).toThrow();
	});
});
