import { createHash } from "node:crypto";
import { budgetProfileSchema } from "@ccflare/core";
import {
	type Account,
	type BudgetProfile,
	getProviderDefaultBaseUrl,
} from "@ccflare/types";

export function accountOrigin(account: Account): string {
	const fallback = getProviderDefaultBaseUrl(account.provider);
	try {
		return new URL(account.base_url ?? fallback).origin;
	} catch {
		return "invalid";
	}
}
export function inferBudgetProfile(account: Account): BudgetProfile {
	const origin = accountOrigin(account);
	const mode =
		account.provider === "grok-build" &&
		origin === "https://cli-chat-proxy.grok.com"
			? "grok"
			: account.provider === "lmstudio"
				? "local"
				: isCodexEndpoint(account)
					? "codex"
					: isZaiCodingEndpoint(account)
						? "zai"
						: account.provider === "claude-code" &&
								origin === "https://api.anthropic.com"
							? "claude"
							: "auto";
	return budgetProfileSchema.parse({
		mode,
		models:
			mode === "grok"
				? ["grok-*"]
				: mode === "zai"
					? ["glm-*"]
					: mode === "codex"
						? ["gpt-*", "codex-*"]
						: mode === "claude"
							? ["claude-*"]
							: [],
	});
}
export function credentialGroup(account: Account): string {
	const credential = account.api_key ?? account.refresh_token ?? account.id;
	return `auto-${createHash("sha256")
		.update(`${accountOrigin(account)}:${account.auth_method}:${credential}`)
		.digest("hex")
		.slice(0, 32)}`;
}
export function poolKey(account: Account): string {
	let path = "";
	try {
		path = new URL(account.base_url ?? accountOrigin(account)).pathname.replace(
			/\/+$/,
			"",
		);
	} catch {
		path = "invalid";
	}
	return `${account.provider}:${accountOrigin(account)}:${path}`;
}
export function isZaiCodingEndpoint(account: Account): boolean {
	if (accountOrigin(account) !== "https://api.z.ai" || !account.base_url)
		return false;
	const path = new URL(account.base_url).pathname.replace(/\/+$/, "");
	return (
		(account.provider === "anthropic" &&
			(path === "/api/anthropic" || path === "/api/anthropic/v1")) ||
		(account.provider === "openai" && path === "/api/coding/paas/v4")
	);
}

export function isCodexEndpoint(account: Account): boolean {
	if (
		account.provider !== "codex" ||
		account.auth_method !== "oauth" ||
		accountOrigin(account) !== "https://chatgpt.com"
	)
		return false;
	const url = new URL(account.base_url ?? getProviderDefaultBaseUrl("codex"));
	return url.pathname.replace(/\/+$/, "") === "/backend-api/codex";
}
