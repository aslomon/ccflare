import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { budgetProfileSchema, emptyBudgetState } from "@ccflare/core";
import { migrateBudgets } from "./budget-migration";
import { BudgetRepository } from "./repositories/budget.repository";

function setup() {
	const db = new Database(":memory:");
	db.exec(
		"CREATE TABLE accounts (id TEXT PRIMARY KEY); INSERT INTO accounts VALUES ('a');",
	);
	migrateBudgets(db);
	return { db, repo: new BudgetRepository(db) };
}
describe("persisted account budgets", () => {
	it("reads legacy state but writes v2 separately so the previous release can roll back", () => {
		const { db, repo } = setup();
		const legacy = JSON.stringify({ ...emptyBudgetState(), error: "legacy" });
		db.query(
			"INSERT INTO quota_budgets(scope_id,group_id,value) VALUES ('local','g',?)",
		).run(legacy);
		expect(repo.state("g").error).toBe("legacy");
		repo.saveState("g", {
			...repo.state("g"),
			error: "new-state",
			actualWorkTotal: 42,
		});
		expect(repo.state("g").actualWorkTotal).toBe(42);
		expect(
			db
				.query<{ value: string }, []>(
					"SELECT value FROM quota_budgets WHERE group_id='g'",
				)
				.get()?.value,
		).toBe(legacy);
		db.query(
			"INSERT INTO budget_sessions(scope_id,pool_id,value) VALUES ('local','p',?)",
		).run(JSON.stringify({ accountId: "a", deadline: 100, credits: {} }));
		repo.saveSession("p", { ...repo.session("p"), deadline: 200 });
		expect(
			db
				.query<{ value: string }, []>(
					"SELECT value FROM budget_sessions WHERE pool_id='p'",
				)
				.get()?.value,
		).toBe(JSON.stringify({ accountId: "a", deadline: 100, credits: {} }));
		db.close();
	});
	it("migrates idempotently and preserves state over repository recreation", () => {
		const { db, repo } = setup();
		migrateBudgets(db);
		repo.saveProfile("a", budgetProfileSchema.parse({ groupId: "shared" }));
		repo.saveState("shared", emptyBudgetState());
		const other = new BudgetRepository(db);
		expect(other.profile("a")?.groupId).toBe("shared");
		expect(other.state("shared").weeklyCostPerWork).toBeGreaterThan(0);
		db.close();
	});
	it("atomically reserves shared capacity and expires bounded leases", () => {
		const { db, repo } = setup();
		repo.reserve("a", "group", "one", 1, 1, 100, 500);
		repo.reserve("a", "group", "two", 1, 2, 100, 500);
		expect(repo.reservedPercent("group", 101)).toBe(3);
		repo.finish("one", 200);
		expect(repo.reservedPercent("group", 201)).toBe(3);
		expect(repo.reservedPercent("group", 501)).toBe(0);
		db.close();
	});
	it("only absorbs completed reservations older than a confirmed observation", () => {
		const { db, repo } = setup();
		repo.reserve("a", "g", "one", 1, 1, 100, 1000);
		repo.reserve("a", "g", "two", 1, 2, 100, 1000);
		repo.finish("one", 200);
		repo.reconcile("g", 300);
		expect(repo.reservedPercent("g", 301)).toBe(2);
		db.close();
	});
	it("keeps database scopes isolated", () => {
		const { db, repo } = setup();
		repo.saveState("g", { ...emptyBudgetState(), error: "test" });
		expect(new BudgetRepository(db, "other").state("g").error).toBeNull();
		db.close();
	});
});
