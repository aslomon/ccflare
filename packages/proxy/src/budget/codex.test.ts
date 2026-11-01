import { describe, expect, it } from "bun:test";
import { budgetPolicySchema } from "@ccflare/core";
import { BudgetRepository, DatabaseOperations } from "@ccflare/database";
import { parseCodexQuota } from "@ccflare/providers";
import { BudgetControl } from "./control";

describe("Codex adaptive account routing", () => {
	it("onboards only trusted Codex subscriptions and preserves the weekly cutoff/manual pause", () => {
		const db = new DatabaseOperations(":memory:");
		try {
			const account = db.createOAuthAccount({
				name: "second",
				provider: "codex",
				accessToken: "test",
				refreshToken: "test",
			});
			const repo = new BudgetRepository(db.getDatabase());
			const control = new BudgetControl(
				db,
				repo,
				budgetPolicySchema.parse({ enabled: true }),
			);
			expect(control.profile(account).mode).toBe("codex");
			const snapshot = (used: number) =>
				parseCodexQuota(
					{
						rate_limit: {
							allowed: true,
							limit_reached: false,
							primary_window: {
								used_percent: used,
								limit_window_seconds: 604800,
								reset_at: Math.floor(Date.now() / 1000) + 604800,
							},
							secondary_window: null,
						},
					},
					Date.now(),
				);
			control.observe(account, snapshot(0));
			expect(control.view(account, "gpt-example-sol").eligible).toBe(true);
			control.observe(account, snapshot(85));
			expect(control.view(account, "gpt-example-sol").eligible).toBe(false);
			db.pauseAccount(account.id);
			expect(
				control.view(db.getAccount(account.id) ?? account).manualPaused,
			).toBe(true);
			const other = db.createOAuthAccount({
				name: "custom",
				provider: "codex",
				accessToken: "test2",
				refreshToken: "test2",
				baseUrl: "https://example.com",
			});
			expect(control.profile(other).mode).toBe("auto");
			expect(() =>
				control.setProfile(other, { ...control.profile(other), mode: "codex" }),
			).toThrow();
		} finally {
			db.close();
		}
	});
});
