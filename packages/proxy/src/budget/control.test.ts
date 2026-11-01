import { describe, expect, it, spyOn } from "bun:test";
import { budgetPolicySchema } from "@ccflare/core";
import { BudgetRepository, DatabaseOperations } from "@ccflare/database";
import type { QuotaSnapshot } from "@ccflare/types";
import { BudgetControl } from "./control";

function setup() {
	const dbOps = new DatabaseOperations(":memory:");
	const account = dbOps.createOAuthAccount({
		name: "one",
		provider: "claude-code",
		accessToken: "test",
		refreshToken: "test-refresh",
	});
	const repo = new BudgetRepository(dbOps.getDatabase());
	const control = new BudgetControl(
		dbOps,
		repo,
		budgetPolicySchema.parse({ enabled: true }),
	);
	return { dbOps, repo, control, account };
}
function quota(
	used: number,
	reset = Date.now() + 3 * 86_400_000,
): QuotaSnapshot {
	return {
		observedAt: Date.now(),
		source: "claude-oauth",
		windows: [
			{ key: "seven_day", usedPercent: used, resetAt: reset, model: null },
			{
				key: "five_hour",
				usedPercent: 10,
				resetAt: Date.now() + 3_600_000,
				model: null,
			},
		],
	};
}
describe("account budget control", () => {
	it("gives learning accounts sessions even beside a very cheap established account", () => {
		const { dbOps, control, repo, account } = setup();
		const second = dbOps.createOAuthAccount({
			name: "two",
			provider: "claude-code",
			accessToken: "two",
			refreshToken: "two",
		});
		const third = dbOps.createOAuthAccount({
			name: "three",
			provider: "claude-code",
			accessToken: "three",
			refreshToken: "three",
		});
		const start = Date.now();
		for (const item of [account, second, third]) {
			control.observe(item, quota(1, start + 7 * 86_400_000));
			const group = control.group(item);
			repo.saveState(group, {
				...repo.state(group),
				weeklyCostPerWork: item.id !== third.id ? 0.001 : 25,
				learnedSamples: item.id !== third.id ? 2 : 0,
			});
		}
		let now = start;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		const seen = new Set<string>();
		try {
			for (let i = 0; i < 24; i++) {
				const current = control.order(
					[account, second, third],
					"claude-sonnet",
				)[0];
				seen.add(current.id);
				now = (control.view(current).deadline ?? now) + 1;
				for (const item of [account, second, third]) {
					const group = control.group(item),
						state = repo.state(group);
					if (state.quota)
						repo.saveState(group, {
							...state,
							quota: {
								...state.quota,
								observedAt: now,
								windows: state.quota.windows.map((window) =>
									window.key === "five_hour"
										? { ...window, resetAt: now + 3_600_000 }
										: window,
								),
							},
						});
				}
			}
			expect(seen.size).toBe(3);
		} finally {
			clock.mockRestore();
			dbOps.close();
		}
	});
	it("does not inflate held short-window work when the learned weekly price changes", () => {
		const { dbOps, control, repo, account } = setup();
		control.observe(account, quota(10));
		expect(control.reserve(account, "claude-sonnet", 250)).not.toBeNull();
		const group = control.group(account);
		repo.saveState(group, {
			...repo.state(group),
			weeklyCostPerWork: 0.001,
			learnedSamples: 1,
		});
		expect(control.view(account).eligible).toBe(true);
		dbOps.close();
	});
	it("learns quota deltas when the provider reset timestamp drifts by milliseconds", () => {
		const { dbOps, control, repo, account } = setup();
		const reset = Date.now() + 3 * 86_400_000;
		const first = quota(10, reset);
		control.observe(account, first);
		expect(
			control.reserve(account, "claude-sonnet", 10, undefined, "measured"),
		).not.toBeNull();
		control.recordUsage({
			requestId: "measured",
			accountId: account.id,
			model: "claude-sonnet",
			inputTokens: 200_000,
			outputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			reasoningTokens: 0,
			costUsd: null,
		});
		control.observe(account, {
			...quota(11, reset + 100),
			observedAt: first.observedAt + control.policy.minSessionMs,
		});
		const state = repo.state(control.group(account));
		expect(state.learnedSamples).toBeGreaterThan(0);
		expect(state.weeklyBurnPerHour).toBeGreaterThan(0);
		dbOps.close();
	});
	it("reselects a session when the incoming request cannot fit remaining short-window reservations", () => {
		const { dbOps, control, account } = setup();
		const second = dbOps.createOAuthAccount({
			name: "two",
			provider: "claude-code",
			accessToken: "two",
			refreshToken: "two",
		});
		control.observe(account, quota(18));
		control.observe(second, quota(42));
		expect(control.order([account, second], "claude-sonnet")[0].id).toBe(
			account.id,
		);
		expect(control.reserve(account, "claude-sonnet", 263)).not.toBeNull();
		expect(control.view(account).eligible).toBe(true);
		expect(control.order([account, second], "claude-sonnet", 1)[0].id).toBe(
			second.id,
		);
		dbOps.close();
	});
	it("does not treat Z.ai pay-as-you-go endpoints as Coding Plan quota", () => {
		const { dbOps, control } = setup();
		const paid = dbOps.createApiKeyAccount({
			name: "paid",
			provider: "openai",
			apiKey: "paid",
			baseUrl: "https://api.z.ai/api/paas/v4",
		});
		expect(control.profile(paid).mode).toBe("auto");
		expect(() =>
			control.setProfile(paid, { ...control.profile(paid), mode: "zai" }),
		).toThrow("Incompatible");
		dbOps.close();
	});
	it("rotates unused eligible accounts without applying capacity to both frequency and duration", () => {
		const { dbOps, control, repo, account } = setup();
		const now = Date.now();
		const second = dbOps.createOAuthAccount({
			name: "two",
			provider: "claude-code",
			accessToken: "two",
			refreshToken: "two",
		});
		const third = dbOps.createOAuthAccount({
			name: "three",
			provider: "claude-code",
			accessToken: "three",
			refreshToken: "three",
		});
		for (const item of [account, second, third]) {
			control.observe(
				item,
				quota(item.id === account.id ? 2 : 65, now + 7 * 86_400_000),
			);
			const group = control.group(item);
			repo.saveState(group, { ...repo.state(group), learnedSamples: 2 });
		}
		let time = now;
		const clock = spyOn(Date, "now").mockImplementation(() => time);
		const seen = new Set<string>();
		const durations = new Map<string, number>();
		try {
			for (let index = 0; index < 6; index++) {
				const chosen = control.order(
					[account, second, third],
					"claude-sonnet",
				)[0];
				seen.add(chosen.id);
				const deadline = control.view(chosen).deadline;
				if (!deadline) throw new Error("Missing session");
				durations.set(chosen.id, deadline - time);
				time = deadline + 1;
				for (const item of [account, second, third])
					control.observe(item, {
						...quota(item.id === account.id ? 2 : 65, now + 7 * 86_400_000),
						observedAt: time,
					});
			}
			expect(seen.size).toBe(3);
			expect(durations.get(account.id)).toBe(durations.get(second.id));
			expect(durations.get(account.id)).toBeGreaterThanOrEqual(
				control.policy.minSessionMs,
			);
			expect(durations.get(account.id)).toBeLessThanOrEqual(
				control.policy.maxSessionMs,
			);
		} finally {
			clock.mockRestore();
			dbOps.close();
		}
	});
	it("prevents identical credentials from splitting their shared budget", () => {
		const { dbOps, control, account } = setup();
		dbOps.createOAuthAccount({
			name: "duplicate",
			provider: "claude-code",
			accessToken: "test",
			refreshToken: "test-refresh",
		});
		const profile = control.profile(account);
		expect(() =>
			control.setProfile(account, { ...profile, groupId: "separate" }),
		).toThrow("shared budget");
		dbOps.close();
	});
	it("blocks new accounts until validated telemetry arrives", () => {
		const { dbOps, control, account } = setup();
		expect(control.order([account], "claude-sonnet")).toEqual([]);
		control.observe(account, quota(2));
		expect(control.order([account], "claude-sonnet")[0].id).toBe(account.id);
		dbOps.close();
	});
	it("preserves manual pause through quota resets", () => {
		const { dbOps, control, account } = setup();
		dbOps.pauseAccount(account.id);
		const paused = dbOps.getAccount(account.id);
		if (!paused) throw new Error("missing");
		control.observe(paused, quota(0));
		expect(control.view(paused).reason).toBe("manual_pause");
		dbOps.close();
	});
	it("persists automatic weekly pauses and only clears after a verified reset", () => {
		const { dbOps, repo, control, account } = setup();
		const reset = Date.now() + 86_400_000;
		control.observe(account, quota(85, reset));
		control.observe(account, quota(84, reset));
		expect(control.view(account).automaticPaused).toBe(true);
		expect(
			new BudgetControl(dbOps, repo, control.policy).view(account).eligible,
		).toBe(false);
		control.observe(account, quota(1, reset + 7 * 86_400_000));
		expect(control.view(account).eligible).toBe(true);
		dbOps.close();
	});
	it("shares identical credentials and reserves each attempt atomically", () => {
		const { dbOps, control, account } = setup();
		const second = dbOps.createOAuthAccount({
			name: "two",
			provider: "claude-code",
			accessToken: "test",
			refreshToken: "test-refresh",
		});
		control.observe(account, quota(82));
		expect(control.group(account)).toBe(control.group(second));
		expect(control.reserve(account, "claude-sonnet", 60)).not.toBeNull();
		expect(control.reserve(second, "claude-sonnet", 60)).toBeNull();
		dbOps.close();
	});
	it("keeps sticky deadlines across restarts and never prolongs them on a read", () => {
		const { dbOps, repo, control, account } = setup();
		control.observe(account, quota(2));
		control.order([account], "claude-sonnet");
		const deadline = control.view(account, "claude-sonnet").deadline;
		const other = new BudgetControl(dbOps, repo, control.policy);
		other.order([account], "claude-sonnet");
		expect(other.view(account, "claude-sonnet").deadline).toBe(deadline);
		dbOps.close();
	});
	it("keeps GLM and Claude model pools separate despite a compatible protocol", () => {
		const { dbOps, control } = setup();
		const glm = dbOps.createApiKeyAccount({
			name: "glm",
			provider: "anthropic",
			apiKey: "test-zai",
			baseUrl: "https://api.z.ai/api/anthropic",
		});
		control.observe(glm, { ...quota(2), source: "zai-coding" });
		expect(control.order([glm], "claude-sonnet")).toEqual([]);
		expect(control.order([glm], "glm-5.3")).toHaveLength(1);
		dbOps.close();
	});
	it("does not learn a free request when usage is rounded to zero", () => {
		const { dbOps, control, repo, account } = setup();
		control.observe(account, quota(0));
		control.reserve(account, "claude-sonnet", 1);
		control.observe(account, quota(0));
		expect(
			repo.state(control.group(account)).weeklyCostPerWork,
		).toBeGreaterThan(0);
		dbOps.close();
	});
});
