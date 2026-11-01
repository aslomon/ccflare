import { expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonFetchMock, createOAuthAccount } from "../../test-helpers";
import {
	parseGrokCredential,
	readGrokCredential,
	refreshGrokCredential,
} from "./credential";
import { GrokBuildProvider } from "./provider";
import { readGrokQuota } from "./quota";

const raw = {
	key: "synthetic-token",
	auth_mode: "oidc",
	user_id: "user",
	expires_at: "2099-01-01T00:00:00Z",
	oidc_issuer: "https://auth.x.ai",
	oidc_client_id: "cli",
};
const store = { "https://auth.x.ai::cli": raw };

it("reads only bounded private credential files and redacts invalid content", () => {
	const directory = mkdtempSync(join(tmpdir(), "grok-credential-test-"));
	const path = join(directory, "auth.json");
	try {
		writeFileSync(path, JSON.stringify(store), { mode: 0o600 });
		expect(readGrokCredential(path).user_id).toBe("user");
		chmodSync(path, 0o644);
		expect(() => readGrokCredential(path)).toThrow("grok_login_required");
		chmodSync(path, 0o600);
		writeFileSync(path, "private-malformed-content");
		expect(() => readGrokCredential(path)).toThrow("grok_login_required");
		writeFileSync(path, "x".repeat(65_537));
		expect(() => readGrokCredential(path)).toThrow("grok_login_required");
		expect(() => readGrokCredential(directory)).toThrow("grok_login_required");
		expect(() => readGrokCredential(join(directory, "missing"))).toThrow(
			"grok_login_required",
		);
	} finally {
		rmSync(directory, { recursive: true });
	}
});

it("refreshes through the native CLI with bounded resources and no API fallback", async () => {
	await refreshGrokCredential(async (binary, argumentsList, options) => {
		expect(binary.endsWith("/.grok/bin/grok")).toBe(true);
		expect(argumentsList).toEqual(["models"]);
		expect(options.timeout).toBe(20_000);
		expect(options.env.XAI_API_KEY).toBe("");
		expect(options.env.GROK_CLI_CHAT_PROXY_BASE_URL).toBe(
			"https://cli-chat-proxy.grok.com/v1",
		);
	});
	await expect(
		refreshGrokCredential(async () => {
			throw new Error("private-provider-response");
		}),
	).rejects.toThrow("grok_login_required");
});

it("requests only the fixed billing origin and bounds errors and response size", async () => {
	const account = createOAuthAccount("grok-build", {
		refresh_token: "grok-cli:user",
	});
	const provider = new GrokBuildProvider(
		() => parseGrokCredential(store),
		async () => {},
	);
	const now = Date.now();
	const payload = {
		config: {
			creditUsagePercent: 2,
			currentPeriod: {
				type: "USAGE_PERIOD_TYPE_WEEKLY",
				start: new Date(now - 60_000).toISOString(),
				end: new Date(now + 86_400_000).toISOString(),
			},
		},
	};
	const success = createJsonFetchMock(payload, (request) => {
		expect(request.url).toBe(
			"https://cli-chat-proxy.grok.com/v1/billing?format=credits",
		);
		expect(request.redirect).toBe("error");
		expect(request.headers.get("authorization")).toBe("Bearer synthetic-token");
	});
	expect(
		(await readGrokQuota(account, provider, success)).windows[0]?.usedPercent,
	).toBe(2);
	await expect(
		readGrokQuota(
			account,
			provider,
			createJsonFetchMock({ error: "private-error" }, undefined, {
				status: 401,
			}),
		),
	).rejects.toThrow("usage_http_401");
	await expect(
		readGrokQuota(
			account,
			provider,
			createJsonFetchMock({ padding: "x".repeat(65_537) }),
		),
	).rejects.toThrow("usage_too_large");
});
