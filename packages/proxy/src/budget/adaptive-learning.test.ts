import { describe, expect, it } from "bun:test";
import { budgetPolicySchema, emptyBudgetState } from "@ccflare/core";
import type { QuotaSnapshot } from "@ccflare/types";
import { updateObservation } from "./observations";

const now = 1_790_000_000_000;
const policy = budgetPolicySchema.parse({ enabled: true });
function quota(weekly: number, short: number, minutes: number): QuotaSnapshot {
	return {
		observedAt: now + minutes * 60_000,
		source: "claude-oauth",
		windows: [
			{
				key: "seven_day",
				usedPercent: weekly,
				resetAt: now + 604_800_000,
				model: null,
			},
			{
				key: "five_hour",
				usedPercent: short,
				resetAt: now + 18_000_000,
				model: null,
			},
		],
	};
}

describe("independent measured quota windows", () => {
	it("fits a model-specific quota only to matching completed model work", () => {
		const initial = quota(10, 0, 0);
		initial.windows.push({
			key: "seven_day_opus",
			usedPercent: 1,
			resetAt: now + 604_800_000,
			model: "opus",
		});
		const state = updateObservation(emptyBudgetState(), initial, policy);
		const next = quota(11, 1, 20);
		next.windows.push({ ...initial.windows[2], usedPercent: 2 });
		const learned = updateObservation(
			{
				...state,
				actualWorkTotal: 30,
				modelWorkTotal: { "claude-opus": 1, "claude-sonnet": 29 },
			},
			next,
			policy,
		);
		expect(learned.windowLearning.seven_day_opus?.costPerWork).toBe(1);
		expect(learned.windowLearning.seven_day?.costPerWork).toBeCloseTo(
			1 / 30,
			6,
		);
	});
	it("matches a delayed weekly delta with all its work despite earlier short-window deltas", () => {
		let state = updateObservation(emptyBudgetState(), quota(10, 0, 0), policy);
		for (let index = 1; index <= 3; index++) {
			state = updateObservation(
				{ ...state, actualWorkTotal: index * 10 },
				quota(index === 3 ? 11 : 10, index, index * 20),
				policy,
			);
		}
		expect(state.weeklyCostPerWork).toBeCloseTo(1 / 30, 6);
		expect(state.shortCostPerWork).toBeCloseTo(0.1, 6);
		expect(state.windowLearning.seven_day?.samples).toBe(1);
		expect(state.windowLearning.five_hour?.samples).toBe(3);
	});
	it("does not fit local request cost to a rise without any locally measured work", () => {
		const first = updateObservation(
			emptyBudgetState(),
			quota(10, 0, 0),
			policy,
		);
		const state = updateObservation(first, quota(15, 10, 20), policy);
		expect(state.windowLearning.seven_day?.samples).toBe(0);
		expect(state.windowLearning.seven_day?.unattributedPercent).toBe(5);
		expect(state.weeklyCostPerWork).toBe(first.weeklyCostPerWork);
	});
	it("includes quiet intervals instead of retaining an old active burn indefinitely", () => {
		const first = updateObservation(
			emptyBudgetState(),
			quota(10, 0, 0),
			policy,
		);
		const active = updateObservation(first, quota(11, 0, 20), policy);
		const idle = updateObservation(active, quota(11, 0, 140), policy);
		expect(active.weeklyBurnPerHour).toBe(3);
		expect(idle.weeklyBurnPerHour).toBeLessThan(1);
	});
	it("starts a fresh work baseline after reset without learning the negative delta", () => {
		const initial = updateObservation(
			emptyBudgetState(),
			quota(80, 0, 0),
			policy,
		);
		const reset = quota(0, 0, 20);
		reset.windows[0].resetAt = now + 1_209_600_000;
		const state = updateObservation(
			{ ...initial, actualWorkTotal: 50 },
			reset,
			policy,
		);
		expect(state.windowLearning.seven_day?.workCursor).toBe(50);
		expect(state.windowLearning.seven_day?.samples).toBe(0);
		expect(state.weeklyBurnPerHour).toBe(0);
	});
});
