import { describe, expect, it } from "bun:test";
import type { BudgetHistoryFact } from "@ccflare/types";
import { DatabaseOperations } from "./database-operations";
import { BudgetRepository } from "./repositories/budget.repository";

const now = 1_790_000_000_000;
function setup() {
	const dbOps = new DatabaseOperations(":memory:");
	const account = dbOps.createApiKeyAccount({
		name: "test",
		provider: "anthropic",
		apiKey: "test",
	});
	return { dbOps, account, repo: new BudgetRepository(dbOps.getDatabase()) };
}
function fact(accountId: string, time = now): BudgetHistoryFact {
	return {
		kind: "selection",
		observedAt: time,
		accountId,
		groupId: "group",
		model: "test-model",
		reason: "pace_exhausted",
		quota: null,
		reservedPercent: 1,
		actualWorkTotal: 1,
		balancePercent: 0,
		ratePercentPerHour: 1,
		deadline: null,
	};
}
describe("bounded budget telemetry", () => {
	it("paginates quota decisions with exclusive stable cursors and isolated scopes", () => {
		const { dbOps, account, repo } = setup();
		for (let index = 0; index < 3; index++)
			repo.telemetry.append(fact(account.id, now + index));
		const page = repo.telemetry.history({ limit: 2, accountId: account.id });
		expect(page.entries.length).toBe(2);
		expect(page.nextBefore).not.toBeNull();
		const next = repo.telemetry.history({
			limit: 2,
			before: page.nextBefore ?? undefined,
		});
		expect(next.entries.length).toBe(1);
		expect(next.entries[0].id).toBeLessThan(page.entries[1].id);
		expect(
			new BudgetRepository(dbOps.getDatabase(), "other").telemetry.history({
				limit: 10,
			}).entries,
		).toEqual([]);
		dbOps.close();
	});
	it("retains only bounded metadata and removes facts older than fourteen days", () => {
		const { dbOps, account, repo } = setup();
		repo.telemetry.append(fact(account.id, now - 15 * 86_400_000));
		repo.telemetry.append(fact(account.id));
		repo.telemetry.prune(now);
		expect(repo.telemetry.history({ limit: 10 }).entries.length).toBe(1);
		expect(() => repo.telemetry.history({ limit: 201 })).toThrow();
		expect(() => repo.telemetry.history({ limit: 10, before: -1 })).toThrow();
		dbOps.close();
	});
	it("binds websocket usage once and includes measured or conservative work in demand", () => {
		const { dbOps, account, repo } = setup();
		repo.reserve(account.id, "g", "lease", 20, 2, now, now + 1000, {
			requestId: null,
			model: "model",
			estimatedWork: 20,
		});
		repo.telemetry.bind("lease", "request-one");
		repo.telemetry.bind("lease", "request-two");
		expect(repo.telemetry.attempt("request-two", account.id)).toBeNull();
		expect(repo.telemetry.workSince([account.id], now - 1)).toBe(20);
		expect(repo.telemetry.settle("lease", 1, now + 1)).toBe(true);
		expect(repo.telemetry.settle("lease", 2, now + 2)).toBe(false);
		expect(repo.telemetry.workSince([account.id], now - 1)).toBe(1);
		dbOps.close();
	});
});
