import { describe, expect, it } from "bun:test";
import {
	ACCOUNT_PROVIDER_OPTIONS,
	ACCOUNT_PROVIDERS,
	API_KEY_PROVIDERS,
	getProviderDisplayLabel,
	getProviderMetadata,
	isApiKeyProvider,
	isOAuthProvider,
	OAUTH_PROVIDERS,
} from "./provider-metadata";

describe("provider metadata", () => {
	it("derives provider subsets from the canonical metadata registry", () => {
		expect(ACCOUNT_PROVIDERS).toEqual([
			"anthropic",
			"openai",
			"claude-code",
			"codex",
			"grok-build",
			"lmstudio",
		]);
		expect(API_KEY_PROVIDERS).toEqual(["anthropic", "openai", "lmstudio"]);
		expect(OAUTH_PROVIDERS).toEqual(["claude-code", "codex", "grok-build"]);
		expect(isApiKeyProvider("anthropic")).toBe(true);
		expect(isApiKeyProvider("claude-code")).toBe(false);
		expect(isOAuthProvider("codex")).toBe(true);
		expect(isOAuthProvider("openai")).toBe(false);
	});

	it("provides labels, auth methods, default base URLs, and special requirements", () => {
		expect(ACCOUNT_PROVIDER_OPTIONS).toEqual([
			{ value: "anthropic", label: "Anthropic" },
			{ value: "openai", label: "OpenAI" },
			{ value: "claude-code", label: "Claude Code" },
			{ value: "codex", label: "Codex" },
			{ value: "grok-build", label: "Grok Build" },
			{ value: "lmstudio", label: "LM Studio (local)" },
		]);
		expect(getProviderDisplayLabel("claude-code")).toBe("Claude Code");
		expect(getProviderMetadata("anthropic")).toMatchObject({
			canonicalName: "anthropic",
			displayLabel: "Anthropic",
			authMethod: "api_key",
			supportsOAuth: false,
			supportsWebSocket: false,
			defaultBaseUrl: "https://api.anthropic.com",
			specialRequirements: [],
		});
		expect(getProviderMetadata("codex")).toMatchObject({
			canonicalName: "codex",
			displayLabel: "Codex",
			authMethod: "oauth",
			supportsOAuth: true,
			supportsWebSocket: true,
			defaultBaseUrl: "https://chatgpt.com/backend-api/codex",
			specialRequirements: ["Requires Codex OAuth authentication"],
		});
	});
});
