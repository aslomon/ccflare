import {
	readCodexQuota,
	readGrokQuota,
	readProviderQuota,
} from "@ccflare/providers";
import {
	getValidAccessToken,
	type ProxyContext,
	refreshAccessTokenSafe,
} from "@ccflare/proxy";
import type { Account, BudgetProfile, QuotaSnapshot } from "@ccflare/types";

export function createQuotaReader(context: ProxyContext) {
	return async (
		account: Account,
		profile: BudgetProfile,
	): Promise<QuotaSnapshot> => {
		if (profile.mode === "grok") return readGrokQuota(account);
		if (profile.mode === "zai") {
			if (!account.api_key) throw new Error("usage_no_credential");
			return readProviderQuota("zai", account.api_key);
		}
		if (profile.mode !== "claude" && profile.mode !== "codex")
			throw new Error("usage_adapter_missing");
		const read =
			profile.mode === "codex"
				? readCodexQuota
				: (token: string) => readProviderQuota("claude", token);
		const provider = context.providerRegistry.getProvider(account.provider);
		if (!provider) throw new Error("usage_provider_missing");
		const ctx = {
			...context,
			provider,
			providerName: account.provider,
			upstreamPath: "",
		};
		const token = await getValidAccessToken(account, ctx);
		try {
			return await read(token);
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "usage_http_401")
				throw error;
			return read(await refreshAccessTokenSafe(account, ctx));
		}
	};
}
