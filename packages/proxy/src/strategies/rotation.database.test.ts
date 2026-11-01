import { afterEach, expect, it, setSystemTime } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "@ccflare/database";
import type { RequestMeta } from "@ccflare/types";
import { SessionStrategy } from "./index";

afterEach(() => setSystemTime());

it("rotates with the real provider query and persists the session across a database reopen", () => {
	const directory = mkdtempSync(join(tmpdir(), "ccflare-rotation-"));
	const path = join(directory, "ccflare.db");
	const start = 1_800_000_000_000;
	const request: RequestMeta = {
		id: "db-rotation",
		method: "POST",
		path: "/v1/claude-code/v1/messages",
		timestamp: start,
	};
	const window = { minMs: 1_200_000, maxMs: 1_200_000 };
	let database = new DatabaseOperations(path);
	try {
		setSystemTime(start);
		const first = database.createAccount({
			name: "first",
			provider: "claude-code",
			auth_method: "oauth",
		});
		setSystemTime(start + 1);
		const second = database.createAccount({
			name: "second",
			provider: "claude-code",
			auth_method: "oauth",
		});
		const strategy = new SessionStrategy(18_000_000, window);
		strategy.initialize(database);
		expect(
			strategy.select(
				database.getAvailableAccountsByProvider("claude-code"),
				request,
			)[0]?.id,
		).toBe(first.id);
		database.updateAccountUsage(first.id);
		database.close();
		database = new DatabaseOperations(path);
		const restarted = new SessionStrategy(18_000_000, window);
		restarted.initialize(database);
		setSystemTime(start + 1_200_000);
		expect(
			restarted.select(
				database.getAvailableAccountsByProvider("claude-code"),
				request,
			)[0]?.id,
		).toBe(first.id);
		setSystemTime(start + 1_200_001);
		expect(
			restarted.select(
				database.getAvailableAccountsByProvider("claude-code"),
				request,
			)[0]?.id,
		).toBe(second.id);
		database.pauseAccount(second.id);
		expect(
			restarted.select(
				database.getAvailableAccountsByProvider("claude-code"),
				request,
			)[0]?.id,
		).toBe(first.id);
	} finally {
		database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
