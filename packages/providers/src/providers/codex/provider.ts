import { Logger } from "@ccflare/logger";
import { type Account, getProviderDefaultBaseUrl } from "@ccflare/types";
import { deleteTransportHeaders } from "../../base";
import {
	executeTokenRefresh,
	type RefreshRequestConfig,
} from "../../token-refresh";
import type { TokenRefreshResult } from "../../types";
import {
	OPENAI_OAUTH_CLIENT_ID,
	OPENAI_OAUTH_TOKEN_URL,
} from "../openai/oauth";
import {
	OpenAIProvider,
	parseInteger,
	parseResetTime,
} from "../openai/provider";
import { codexAccountId } from "./headers";
import { CodexOAuthProvider } from "./oauth";

const CODEX_CLIENT_VERSION = "0.164.0";
const CODEX_USER_AGENT = `codex_cli_rs/${CODEX_CLIENT_VERSION} (Mac OS; arm64)`;
const CODEX_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CODEX_CLI_UA_PATTERN =
	/^codex_cli_rs\/((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))(\s|$)/;
const log = new Logger("CodexProvider");
const PROVIDER_NAME = "codex" as const;
const DEFAULT_BASE_URL = getProviderDefaultBaseUrl(PROVIDER_NAME);

const CODEX_REFRESH_CONFIG: RefreshRequestConfig = {
	tokenUrl: OPENAI_OAUTH_TOKEN_URL,
	contentType: "application/x-www-form-urlencoded",
	buildBody(refreshToken: string, _clientId: string) {
		return new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: OPENAI_OAUTH_CLIENT_ID,
		}).toString();
	},
	parseTokens(json: Record<string, unknown>, account: Account) {
		const expiresAt =
			(json.expires_at as number | undefined) ??
			Date.now() + ((json.expires_in as number | undefined) ?? 3600) * 1000;
		return {
			accessToken: json.access_token as string,
			expiresAt,
			refreshToken:
				(json.refresh_token as string | undefined) ??
				account.refresh_token ??
				"",
		};
	},
};

function resolveCodexClientIdentity(headers: Headers): {
	version: string;
	userAgent: string;
} {
	const incomingUserAgent = headers.get("user-agent");
	const uaVersion = incomingUserAgent?.match(CODEX_CLI_UA_PATTERN)?.[1];
	if (uaVersion && incomingUserAgent) {
		const incomingVersion = headers.get("version");
		if (!headers.has("version")) {
			return { version: uaVersion, userAgent: incomingUserAgent };
		}
		if (
			incomingVersion !== null &&
			CODEX_VERSION_PATTERN.test(incomingVersion) &&
			incomingVersion === uaVersion
		) {
			return { version: incomingVersion, userAgent: incomingUserAgent };
		}
	}

	return { version: CODEX_CLIENT_VERSION, userAgent: CODEX_USER_AGENT };
}

export class CodexProvider extends OpenAIProvider {
	name: string = PROVIDER_NAME;
	defaultBaseUrl: string = DEFAULT_BASE_URL;

	supportsWebSocket(upstreamPath: string): boolean {
		return upstreamPath === "/responses";
	}

	isStreamingResponse(response: Response, upstreamPath = ""): boolean {
		// Native Codex Responses can omit Content-Type while still returning SSE.
		return (
			super.isStreamingResponse(response) ||
			(upstreamPath === "/responses" &&
				response.ok &&
				!response.headers.has("content-type"))
		);
	}

	async refreshToken(
		account: Account,
		_clientId: string,
	): Promise<TokenRefreshResult> {
		return executeTokenRefresh(account, _clientId, CODEX_REFRESH_CONFIG, log);
	}

	prepareHeaders(headers: Headers, account: Account | null): Headers {
		const newHeaders = new Headers(headers);

		if (account?.access_token) {
			newHeaders.set("Authorization", `Bearer ${account.access_token}`);
		}

		newHeaders.delete("ChatGPT-Account-Id");
		const accountId = account?.access_token
			? codexAccountId(account.access_token)
			: null;
		if (accountId) newHeaders.set("ChatGPT-Account-Id", accountId);

		// Codex CLI identity is a pair. Forward the incoming UA only when its
		// semver matches a strict version header, or when that header is absent.
		// Any other combination is replaced by the fallback pair.
		const clientIdentity = resolveCodexClientIdentity(newHeaders);

		// Codex-specific headers
		newHeaders.set("originator", "codex_cli_rs");
		newHeaders.set("User-Agent", clientIdentity.userAgent);
		newHeaders.set("Version", clientIdentity.version);
		newHeaders.set("Openai-Beta", "responses=experimental");

		// Remove Anthropic-family headers that don't belong on Codex requests
		newHeaders.delete("x-api-key");
		newHeaders.delete("anthropic-version");

		deleteTransportHeaders(newHeaders);

		return newHeaders;
	}

	parseRateLimit(response: Response) {
		const primaryUsed = parseInteger(
			response.headers.get("x-codex-primary-used-percent"),
		);
		const secondaryUsed = parseInteger(
			response.headers.get("x-codex-secondary-used-percent"),
		);
		const resets = [
			parseResetTime(response.headers.get("x-codex-5h-reset-at")),
			parseResetTime(response.headers.get("x-codex-7d-reset-at")),
			parseResetTime(response.headers.get("x-codex-primary-reset-at")),
			parseResetTime(response.headers.get("x-codex-secondary-reset-at")),
		].filter((value): value is number => value !== undefined);

		if (
			primaryUsed !== undefined ||
			secondaryUsed !== undefined ||
			resets.length > 0
		) {
			const isRateLimited =
				response.status === 429 || primaryUsed === 100 || secondaryUsed === 100;

			return {
				isRateLimited,
				resetTime: resets.length > 0 ? Math.min(...resets) : undefined,
				statusHeader: isRateLimited ? "rate_limited" : "allowed",
			};
		}

		return super.parseRateLimit(response);
	}

	supportsOAuth(): boolean {
		return true;
	}

	getOAuthProvider() {
		return new CodexOAuthProvider();
	}
}
