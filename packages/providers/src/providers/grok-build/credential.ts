import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const credentialSchema = z.object({
	key: z.string().min(1).max(16_384),
	auth_mode: z.literal("oidc"),
	user_id: z.string().min(1).max(200),
	expires_at: z.string().datetime({ offset: true }),
	oidc_issuer: z.literal("https://auth.x.ai"),
	oidc_client_id: z.string().min(1).max(200),
});
export type GrokCredential = z.infer<typeof credentialSchema>;
export const GROK_BUILD_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const runFile = promisify(execFile);

export function parseGrokCredential(value: unknown): GrokCredential {
	const store = z.record(z.unknown()).safeParse(value);
	if (!store.success || Object.keys(store.data).length > 8)
		throw new Error("grok_login_required");
	const credentials = Object.entries(store.data).flatMap(([scope, entry]) => {
		const parsed = credentialSchema.safeParse(entry);
		return parsed.success &&
			scope === `${parsed.data.oidc_issuer}::${parsed.data.oidc_client_id}`
			? [parsed.data]
			: [];
	});
	if (credentials.length !== 1 || !credentials[0])
		throw new Error("grok_login_required");
	return credentials[0];
}

export function readGrokCredential(
	path = join(homedir(), ".grok", "auth.json"),
): GrokCredential {
	try {
		const stat = statSync(path);
		if (!stat.isFile() || stat.size > 65_536 || (stat.mode & 0o077) !== 0)
			throw new Error("grok_login_required");
		return parseGrokCredential(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		throw new Error("grok_login_required");
	}
}

/** The native CLI remains the sole refresh-token writer. */
type CredentialRunner = (
	binary: string,
	argumentsList: string[],
	options: {
		timeout: number;
		maxBuffer: number;
		env: NodeJS.ProcessEnv;
	},
) => Promise<unknown>;

export async function refreshGrokCredential(
	run: CredentialRunner = runFile,
): Promise<void> {
	try {
		await run(join(homedir(), ".grok", "bin", "grok"), ["models"], {
			timeout: 20_000,
			maxBuffer: 65_536,
			env: {
				...process.env,
				GROK_CLI_CHAT_PROXY_BASE_URL: GROK_BUILD_BASE_URL,
				GROK_DISABLE_AUTOUPDATER: "1",
				XAI_API_KEY: "",
			},
		});
	} catch {
		throw new Error("grok_login_required");
	}
}
