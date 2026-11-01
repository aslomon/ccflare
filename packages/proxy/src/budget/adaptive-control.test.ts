import { describe, expect, it, spyOn } from "bun:test";
import { budgetPolicySchema } from "@ccflare/core";
import { BudgetRepository, DatabaseOperations } from "@ccflare/database";
import type { QuotaSnapshot } from "@ccflare/types";
import { BudgetControl } from "./control";
import { poolKey } from "./profiles";

function setup() {
	const dbOps = new DatabaseOperations(":memory:");
	const accounts = ["first", "second", "third"].map((name) =>
		dbOps.createOAuthAccount({
			name,
			provider: "claude-code",
			accessToken: name,
			refreshToken: name,
		}),
	);
	const repo = new BudgetRepository(dbOps.getDatabase());
	const control = new BudgetControl(
		dbOps,
		repo,
		budgetPolicySchema.parse({ enabled: true }),
	);
	const now = Date.now();
	const quota: QuotaSnapshot = {
		observedAt: now,
		source: "claude-oauth",
		windows: [
			{
				key: "seven_day",
				usedPercent: 10,
				resetAt: now + 604_800_000,
				model: null,
			},
			{
				key: "five_hour",
				usedPercent: 0,
				resetAt: now + 18_000_000,
				model: null,
			},
		],
	};
	for (const account of accounts) control.observe(account, quota);
	return { dbOps, accounts, repo, control };
}

describe("request-driven adaptive routing", () => {
	it("does not invent additional forecast capacity when identical credentials are added", () => {
		const { dbOps, accounts, control } = setup();
		const before = control.view(accounts[0]).forecast.poolCapacityPerHour;
		const duplicate = dbOps.createOAuthAccount({
			name: "alias",
			provider: "claude-code",
			accessToken: "first",
			refreshToken: "first",
		});
		expect(control.group(duplicate)).toBe(control.group(accounts[0]));
		expect(control.view(duplicate).forecast.poolCapacityPerHour).toBeCloseTo(
			before,
			2,
		);
		dbOps.close();
	});
	it("keeps Sonnet reservations out of an Opus-only weekly window", () => {
		const { dbOps, accounts, repo, control } = setup();
		const account = accounts[0],
			state = repo.state(control.group(account));
		if (!state.quota) throw new Error("missing quota");
		control.observe(account, {
			...state.quota,
			observedAt: state.quota.observedAt + 1,
			windows: [
				...state.quota.windows,
				{
					key: "seven_day_opus",
					model: "opus",
					usedPercent: 83,
					resetAt: Date.now() + 604_800_000,
				},
			],
		});
		expect(control.reserve(account, "claude-sonnet", 40)).not.toBeNull();
		expect(control.view(account, "claude-opus", 1).eligible).toBe(true);
		dbOps.close();
	});
	it("uses another group under a burst even when no group can fit the whole request in its allowance", () => {
		const { dbOps, accounts, control } = setup();
		const chosen = control.order(accounts, "claude-sonnet", 20)[0];
		expect(control.reserve(chosen, "claude-sonnet", 20)).not.toBeNull();
		expect(control.order(accounts, "claude-sonnet", 20)[0].id).not.toBe(
			chosen.id,
		);
		dbOps.close();
	});
	it("uses real provider increases to reduce allowance and makes active checks due within a minute", () => {
		const { dbOps, accounts, repo, control } = setup();
		const account = accounts[0];
		control.reserve(account, "claude-sonnet", 1);
		const before = repo.state(control.group(account));
		expect(before.nextCheckAt).toBeLessThanOrEqual(Date.now() + 60_000);
		if (!before.quota) throw new Error("missing quota");
		control.observe(account, {
			...before.quota,
			observedAt: before.quota.observedAt + 60_000,
			windows: before.quota.windows.map((window) =>
				window.key === "seven_day" ? { ...window, usedPercent: 15 } : window,
			),
		});
		expect(
			repo.state(control.group(account)).pacing.balancePercent,
		).toBeLessThan(before.pacing.balancePercent);
		dbOps.close();
	});
	it("preserves earned credit while an account is temporarily absent", () => {
		const { dbOps, accounts, repo, control } = setup();
		repo.saveSession(poolKey(accounts[0]), {
			...repo.session(poolKey(accounts[0])),
			credits: { [accounts[2].id]: 12 },
		});
		control.order(accounts.slice(0, 2), "claude-sonnet");
		expect(repo.session(poolKey(accounts[0])).credits[accounts[2].id]).toBe(12);
		dbOps.close();
	});
	it("does not charge fairness credit merely for selecting an unused account", () => {
		const { dbOps, accounts, repo, control } = setup();
		const chosen = control.order(accounts, "claude-sonnet")[0];
		expect(repo.session(poolKey(chosen)).credits[chosen.id] ?? 0).toBe(0);
		dbOps.close();
	});
	it("switches before the sticky deadline when concurrent admissions spend the allowance", () => {
		const { dbOps, accounts, control } = setup();
		const chosen = control.order(accounts, "claude-sonnet", 1)[0];
		const deadline = control.view(chosen).deadline;
		for (let index = 0; index < 20; index++) {
			const next = control.order(accounts, "claude-sonnet", 1)[0];
			if (next.id !== chosen.id) break;
			expect(control.reserve(next, "claude-sonnet", 1)).not.toBeNull();
		}
		expect(deadline).toBeGreaterThan(Date.now());
		expect(control.order(accounts, "claude-sonnet", 1)[0].id).not.toBe(
			chosen.id,
		);
		expect(control.view(chosen).eligible).toBe(true);
		dbOps.close();
	});
	it("replenishes a bounded allowance during quiet time without extending the session deadline", () => {
		const { dbOps, accounts, control } = setup();
		const chosen = control.order(accounts, "claude-sonnet", 1)[0];
		control.reserve(chosen, "claude-sonnet", 5);
		const before = control.view(chosen);
		const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 600_000);
		try {
			const quiet = control.view(chosen);
			expect(quiet.pacing.balancePercent).toBeGreaterThan(
				before.pacing.balancePercent,
			);
			expect(quiet.deadline).toBe(before.deadline);
		} finally {
			clock.mockRestore();
			dbOps.close();
		}
	});
	it("reconciles cache-heavy measured work once, separately from a maximum reservation", () => {
		const { dbOps, accounts, repo, control } = setup();
		const account = accounts[0];
		const reservation = control.reserve(
			account,
			"claude-sonnet",
			20,
			undefined,
			"request-one",
		);
		expect(reservation).not.toBeNull();
		const before = repo.reservedWork(control.group(account), Date.now());
		const fact = {
			requestId: "request-one",
			accountId: account.id,
			model: "claude-sonnet",
			inputTokens: 1000,
			outputTokens: 250,
			cacheReadInputTokens: 100_000,
			cacheCreationInputTokens: 0,
			reasoningTokens: 0,
			costUsd: null,
		};
		expect(control.recordUsage(fact)).toBe(true);
		expect(control.recordUsage(fact)).toBe(false);
		const state = repo.state(control.group(account));
		expect(state.actualWorkTotal).toBeCloseTo(0.6, 6);
		expect(repo.reservedWork(control.group(account), Date.now())).toBeLessThan(
			before,
		);
		expect(state.workModels["claude-sonnet"]?.samples).toBe(1);
		dbOps.close();
	});
});
