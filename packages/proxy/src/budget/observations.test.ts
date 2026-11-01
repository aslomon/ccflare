import { describe, expect, it } from "bun:test";
import { budgetPolicySchema, emptyBudgetState } from "@ccflare/core";
import type { QuotaSnapshot } from "@ccflare/types";
import { updateObservation } from "./observations";

const now = 1_790_000_000_000;
const policy = budgetPolicySchema.parse({ enabled: true });
function quota(used: number, elapsed: number): QuotaSnapshot {
	return {
		observedAt: now + elapsed,
		source: "claude-oauth",
		windows: [
			{
				key: "seven_day",
				usedPercent: used,
				resetAt: now + 86_400_000,
				model: null,
			},
		],
	};
}

describe("forecast observations", () => {
	it("accumulates rounded changes until at least a full learning window", () => {
		const initial = updateObservation(emptyBudgetState(), quota(8, 0), policy);
		const early = updateObservation(initial, quota(9, 60_000), policy);
		expect(early.weeklyBurnPerHour).toBe(0);
		expect(early.burnObservedAt).toBe(now);
		const measured = updateObservation(
			early,
			quota(10, policy.minSessionMs),
			policy,
		);
		expect(measured.weeklyBurnPerHour).toBe(6);
	});
	it("discards an unqualified historical rate when upgrading persisted state", () => {
		const initial = updateObservation(emptyBudgetState(), quota(8, 0), policy);
		const upgraded = updateObservation(
			{ ...initial, weeklyBurnPerHour: 100 },
			quota(9, 60_000),
			policy,
		);
		expect(upgraded.weeklyBurnPerHour).toBe(0);
	});
});
