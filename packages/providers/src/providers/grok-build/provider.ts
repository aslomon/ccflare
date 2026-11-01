import * as compression from "node:zlib";
import { type Account, isRecord } from "@ccflare/types";
import { BaseProvider } from "../../base";
import type { TokenRefreshResult } from "../../types";
import {
	GROK_BUILD_BASE_URL,
	type GrokCredential,
	readGrokCredential,
	refreshGrokCredential,
} from "./credential";

function supportsBoundedZstd(value: unknown): value is {
	zstdDecompressSync(
		input: Uint8Array,
		options: { maxOutputLength: number },
	): Uint8Array;
} {
	return isRecord(value) && typeof value.zstdDecompressSync === "function";
}

export class GrokBuildProvider extends BaseProvider {
	name = "grok-build";
	defaultBaseUrl = GROK_BUILD_BASE_URL;

	prepareBody(body: ArrayBuffer | null, headers?: Headers): ArrayBuffer | null {
		if (!body) return null;
		const encoding = headers?.get("content-encoding");
		if (!encoding || encoding === "identity") return body;
		if (encoding !== "zstd") throw new Error("grok_request_encoding_invalid");
		if (!supportsBoundedZstd(compression))
			throw new Error("grok_zstd_runtime_missing");
		return new Uint8Array(
			compression.zstdDecompressSync(new Uint8Array(body), {
				maxOutputLength: 16 * 1024 * 1024,
			}),
		).buffer;
	}

	isMetadataRequest(method: string, path: string): boolean {
		return (
			(method === "GET" &&
				/^\/(models|billing|settings|feedback\/config|bundle\/archive|subagents\/bundle)$/.test(
					path,
				)) ||
			(["GET", "POST"].includes(method) &&
				/^\/sessions\/[0-9a-f-]{36}\/(signals|turn-deltas)$/.test(path))
		);
	}
	constructor(
		private readonly readCredential: () => GrokCredential = readGrokCredential,
		private readonly refreshCredential: () => Promise<void> = refreshGrokCredential,
	) {
		super();
	}

	private credential(account: Account | null): GrokCredential {
		const credential = this.readCredential();
		if (
			account?.provider !== this.name ||
			account.refresh_token !== `grok-cli:${credential.user_id}`
		)
			throw new Error("grok_account_identity_mismatch");
		return credential;
	}

	buildUrl(path: string, query: string, account?: Account): string {
		if (
			account?.base_url &&
			account.base_url.replace(/\/+$/, "") !== this.defaultBaseUrl
		)
			throw new Error("grok_subscription_origin_required");
		return super.buildUrl(path, query, account);
	}

	prepareHeaders(headers: Headers, account: Account | null): Headers {
		const credential = this.credential(account);
		if (Date.parse(credential.expires_at) <= Date.now())
			throw new Error("grok_login_required");
		const prepared = super.prepareHeaders(headers, null);
		prepared.set("authorization", `Bearer ${credential.key}`);
		prepared.set("x-userid", credential.user_id);
		prepared.delete("x-api-key");
		prepared.delete("anthropic-version");
		prepared.delete("content-length");
		return prepared;
	}

	async refreshToken(account: Account): Promise<TokenRefreshResult> {
		let credential = this.credential(account);
		if (Date.parse(credential.expires_at) - Date.now() <= 300_000) {
			await this.refreshCredential();
			credential = this.credential(account);
		}
		const expiresAt = Date.parse(credential.expires_at);
		if (expiresAt <= Date.now()) throw new Error("grok_login_required");
		return {
			accessToken: credential.key,
			expiresAt,
			refreshToken: `grok-cli:${credential.user_id}`,
		};
	}
}
