import { describe, expect, it } from "bun:test";
import type { BudgetState, QuotaSnapshot } from "@ccflare/types";
import {
	budgetPolicySchema,
	budgetProfileSchema,
	decideBudget,
	emptyBudgetState,
} from "./budget-policy";

const now = 1_790_000_000_000;
const hour = 3_600_000;
const policy = () => budgetPolicySchema.parse({ enabled: true });
const profile = () => budgetProfileSchema.parse({});
function state(used = 10, hours = 72): BudgetState {
	const quota: QuotaSnapshot = {
		observedAt: now,
		source: "claude-oauth",
		windows: [
			{
				key: "seven_day",
				usedPercent: used,
				resetAt: now + hours * hour,
				model: null,
			},
			{ key: "five_hour", usedPercent: 10, resetAt: now + hour, model: null },
		],
	};
	return { ...emptyBudgetState(), quota };
}
const decide = (value: BudgetState, reserved = 0, work = 0, at = now) =>
	decideBudget(value, profile(), policy(), at, null, reserved, work);

describe("adaptive budget policy", () => {
	it("keeps a weekly pause through provider reset timestamp rounding", () => {
		const value = state(84);
		value.weeklyBlockedReset =
			(value.quota?.windows[0].resetAt ?? now) + 30_000;
		expect(decide(value).reason).toBe("weekly_limit");
	});
	it("projects measured consumption and blocks unknown financial accounting", () => {
		expect(
			decide({
				...state(),
				weeklyBurnPerHour: 1,
				burnSampleDurationMs: policy().minSessionMs,
			}).predictedAtReset,
		).toBe(82);
		expect(decide({ ...state(), error: "usage_price_unknown" }).eligible).toBe(
			false,
		);
	});
	it("keeps a forecast unknown while an observed rate lacks a full learning window", () => {
		expect(
			decide({ ...state(), weeklyBurnPerHour: 50 }).predictedAtReset,
		).toBeNull();
	});
	it("rejects cutoffs above 90 and unknown policy keys", () => {
		expect(budgetPolicySchema.safeParse({ cutoffPercent: 91 }).success).toBe(
			false,
		);
		expect(budgetPolicySchema.safeParse({ surprise: true }).success).toBe(
			false,
		);
	});
	it("defaults to an 85 percent cutoff and 20–90 minute sessions", () => {
		expect(policy().cutoffPercent).toBe(85);
		expect(policy().minSessionMs).toBe(20 * 60_000);
		expect(policy().maxSessionMs).toBe(90 * 60_000);
	});
	it("does not interpret missing quota as zero usage", () => {
		expect(decide(emptyBudgetState()).reason).toBe("usage_unknown");
	});
	it("blocks old telemetry and unverified resets", () => {
		expect(decide(state(), 0, 0, now + policy().maxAgeMs + 1).reason).toBe(
			"usage_stale",
		);
		expect(decide(state(10, -1)).reason).toBe("reset_pending");
	});
	it("blocks at the weekly cutoff and counts reserved work before admission", () => {
		expect(decide(state(85)).reason).toBe("weekly_limit");
		expect(decide(state(83), 2).eligible).toBe(false);
		expect(decide(state(82), 0, 200).eligible).toBe(false);
	});
	it("latches a weekly pause until a genuinely different future reset", () => {
		const value = state(84);
		value.weeklyBlockedReset = now + 72 * hour;
		expect(decide(value).reason).toBe("weekly_limit");
		value.quota = state(1, 168).quota;
		expect(decide(value).eligible).toBe(true);
	});
	it("prioritizes sustainable remaining budget, including reset timing", () => {
		expect(decide(state(30, 24)).score).toBeGreaterThan(
			decide(state(15, 144)).score,
		);
	});
	it("normalizes percentages by actual consumption per unit of work", () => {
		const expensive = state();
		expensive.weeklyCostPerWork = 2;
		expect(decide(state()).score).toBeGreaterThan(decide(expensive).score);
	});
	it("never learns zero cost from rounded provider percentages", () => {
		expect(emptyBudgetState().weeklyCostPerWork).toBeGreaterThan(0);
	});
	it("blocks a short-window exhaustion even with abundant weekly budget", () => {
		const value = state();
		if (value.quota) value.quota.windows[1].usedPercent = 95;
		expect(decide(value).reason).toBe("short_window_limit");
	});
	it("requires a weekly quota instead of inventing one from short-window usage", () => {
		const value = state();
		if (value.quota) value.quota.windows = value.quota.windows.slice(1);
		expect(decide(value).reason).toBe("weekly_quota_missing");
	});
	it("enforces model capability and relevant model-specific quotas", () => {
		const p = profile();
		p.models = ["glm-5.3"];
		expect(
			decideBudget(state(), p, policy(), now, "claude-sonnet", 0, 0).reason,
		).toBe("model_unavailable");
		const value = state();
		value.quota?.windows.push({
			key: "seven_day_opus",
			usedPercent: 90,
			resetAt: now + hour,
			model: "opus",
		});
		expect(
			decideBudget(value, profile(), policy(), now, "claude-opus", 0, 0)
				.eligible,
		).toBe(false);
		expect(
			decideBudget(value, profile(), policy(), now, "claude-sonnet", 0, 0)
				.eligible,
		).toBe(true);
	});
	it("requires a configured allowance and anchor for money budgets", () => {
		expect(budgetProfileSchema.safeParse({ mode: "money" }).success).toBe(
			false,
		);
		expect(
			budgetProfileSchema.safeParse({
				mode: "money",
				weeklyUsd: 20,
				weekAnchor: now,
			}).success,
		).toBe(true);
	});
	it("allows a bounded first request for an unused account whose window has not started", () => {
		const value = state(0);
		if (value.quota) value.quota.windows[0].resetAt = null;
		expect(decide(value, 0, 1).eligible).toBe(true);
		expect(decide(value, 0.3, 1).eligible).toBe(false);
	});
});
