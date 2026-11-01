import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { configureGrokClient } from "../packages/providers/src/providers/grok-build/client-config";
import { readGrokCredential } from "../packages/providers/src/providers/grok-build/credential";

const apiBaseUrl = "http://127.0.0.1:8081";
const accountsSchema = z.array(
	z.object({
		id: z.string(),
		name: z.string(),
		provider: z.string(),
		auth_method: z.string(),
	}),
);

async function request(path: string, body?: unknown): Promise<unknown> {
	const response = await fetch(`${apiBaseUrl}${path}`, {
		method: body ? "POST" : "GET",
		redirect: "error",
		signal: AbortSignal.timeout(20_000),
		headers: { "Content-Type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
	if (!response.ok) throw new Error(`grok_setup_http_${response.status}`);
	return response.json();
}

async function registerAccount(): Promise<void> {
	const credential = readGrokCredential();
	const suffix = createHash("sha256")
		.update(credential.user_id)
		.digest("hex")
		.slice(0, 12);
	const name = `grok-build-${suffix}`;
	const accounts = accountsSchema.parse(await request("/api/accounts"));
	const existing = accounts.find((account) => account.name === name);
	if (
		existing &&
		(existing.provider !== "grok-build" || existing.auth_method !== "oauth")
	)
		throw new Error("grok_setup_account_conflict");
	if (!existing) {
		const result = await request("/api/accounts", {
			name,
			provider: "grok-build",
			auth_method: "oauth",
			access_token: credential.key,
			refresh_token: `grok-cli:${credential.user_id}`,
		});
		z.object({ success: z.literal(true) }).parse(result);
	}
	process.stdout.write(`Grok Build account registered: ${name}\n`);
}

async function configureClient(): Promise<void> {
	const path = join(homedir(), ".grok", "config.toml");
	const original = await readFile(path, "utf8");
	const updated = configureGrokClient(original);
	if (original !== updated) {
		const temporary = `${path}.${process.pid}.tmp`;
		await writeFile(temporary, updated, { mode: 0o600, flag: "wx" });
		await rename(temporary, path);
	}
	process.stdout.write(
		"Grok Build configured: ccflare, auto permissions, sandbox off\n",
	);
}

try {
	if (process.argv.includes("--configure-only")) await configureClient();
	else {
		await registerAccount();
		await configureClient();
	}
} catch {
	process.stderr.write(
		"Grok setup failed. Check ccflare and run grok login, then rerun ccflare-grok-setup.\n",
	);
	process.exitCode = 1;
}
