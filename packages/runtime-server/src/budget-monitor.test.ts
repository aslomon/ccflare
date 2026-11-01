import { describe, expect, it } from "bun:test";
import { budgetPolicySchema, budgetProfileSchema } from "@ccflare/core";
import { BudgetRepository, DatabaseOperations } from "@ccflare/database";
import { BudgetControl } from "@ccflare/proxy";
import type { QuotaSnapshot } from "@ccflare/types";
import { BudgetMonitor } from "./budget-monitor";

function setup() {
	const db = new DatabaseOperations(":memory:");
	const account = db.createOAuthAccount({
		name: "test",
		provider: "claude-code",
		accessToken: "test",
		refreshToken: "test",
	});
	const repo = new BudgetRepository(db.getDatabase());
	const control = new BudgetControl(
		db,
		repo,
		budgetPolicySchema.parse({ enabled: true }),
	);
	const quota: QuotaSnapshot = {
		observedAt: Date.now(),
		source: "claude-oauth",
		windows: [
			{
				key: "seven_day",
				usedPercent: 10,
				resetAt: Date.now() + 86_400_000,
				model: null,
			},
		],
	};
	return { db, account, repo, control, quota };
}
describe("budget monitor lifecycle", () => {
	it("blocks unpriced cached usage in explicit money budgets", async () => {
		const { db, control } = setup();
		const account = db.createApiKeyAccount({
			name: "paid",
			provider: "openai",
			apiKey: "paid-test",
		});
		control.setProfile(
			account,
			budgetProfileSchema.parse({
				mode: "money",
				models: ["gpt-*"],
				weeklyUsd: 20,
				weekAnchor: Date.now() - 3_600_000,
			}),
		);
		db.getDatabase()
			.query(
				"INSERT INTO requests(id,timestamp,method,path,account_used,input_tokens,output_tokens,cache_read_input_tokens,cost_usd) VALUES (?,?,?,?,?,0,0,100,NULL)",
			)
			.run(
				crypto.randomUUID(),
				Date.now() - 1000,
				"POST",
				"/v1/responses",
				account.id,
			);
		const monitor = new BudgetMonitor(control, async () => {
			throw new Error("usage_adapter_missing");
		});
		await monitor.tick();
		expect(control.view(account).reason).toBe("usage_price_unknown");
		expect(control.view(account).eligible).toBe(false);
		await monitor.dispose();
		db.close();
	});
	it("deduplicates shared credentials, respects poll deadlines and manual pauses", async () => {
		const { db, account, control, quota } = setup();
		db.createOAuthAccount({
			name: "duplicate",
			provider: "claude-code",
			accessToken: "test",
			refreshToken: "test",
		});
		const paused = db.createOAuthAccount({
			name: "paused",
			provider: "claude-code",
			accessToken: "paused",
			refreshToken: "paused",
		});
		db.pauseAccount(paused.id);
		let reads = 0;
		const monitor = new BudgetMonitor(control, async () => {
			reads++;
			return quota;
		});
		await monitor.tick();
		await monitor.tick();
		expect(reads).toBe(1);
		expect(control.view(account).eligible).toBe(true);
		await monitor.dispose();
		await monitor.tick(true);
		expect(reads).toBe(1);
		db.close();
	});
	it("backs off errors without replacing missing quota with zero", async () => {
		const { db, account, control, repo } = setup();
		const monitor = new BudgetMonitor(control, async () => {
			throw new Error("usage_http_401");
		});
		await monitor.tick();
		const state = repo.state(control.group(account));
		expect(state.failures).toBe(1);
		expect(state.nextCheckAt).toBeGreaterThan(Date.now());
		expect(control.view(account).reason).toBe("usage_http_401");
		await monitor.tick();
		expect(repo.state(control.group(account)).failures).toBe(1);
		await monitor.dispose();
		db.close();
	});
	it("preserves only allowlisted parser failure codes", async () => {
		for (const code of [
			"usage_parse_weekly_missing",
			"usage_parse_invalid",
			"usage_parse_snapshot_invalid",
			"usage_parse_private_payload",
		]) {
			const { db, account, control, repo } = setup();
			const monitor = new BudgetMonitor(control, async () => {
				throw new Error(code);
			});
			await monitor.tick();
			expect(repo.state(control.group(account)).error).toBe(
				code === "usage_parse_private_payload" ? "usage_check_failed" : code,
			);
			expect(control.view(account).eligible).toBe(false);
			await monitor.dispose();
			db.close();
		}
	});
	it("uses an explicitly configured local money budget and verified week boundaries", async () => {
		const { db, control } = setup();
		const account = db.createApiKeyAccount({
			name: "api",
			provider: "openai",
			apiKey: "test",
		});
		control.setProfile(
			account,
			budgetProfileSchema.parse({
				mode: "money",
				models: ["gpt-*"],
				weeklyUsd: 20,
				weekAnchor: Date.now() - 3_600_000,
			}),
		);
		const monitor = new BudgetMonitor(control, async () => {
			throw new Error("usage_adapter_missing");
		});
		await monitor.tick();
		expect(control.view(account).quota?.source).toBe("local-cost");
		expect(control.view(account).weeklyUsed).toBe(0);
		expect(control.view(account).eligible).toBe(true);
		await monitor.dispose();
		db.close();
	});
	it("starts one background lifecycle and supports a forced refresh", async () => {
		const { db, control, quota } = setup();
		let reads = 0;
		const monitor = new BudgetMonitor(control, async () => {
			reads++;
			return quota;
		});
		monitor.start();
		await control.refresh();
		await control.refresh();
		expect(reads).toBe(2);
		await monitor.dispose();
		db.close();
	});
});
