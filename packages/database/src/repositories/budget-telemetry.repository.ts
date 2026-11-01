import type { Database } from "bun:sqlite";
import {
	budgetHistoryFactSchema,
	budgetHistoryQuerySchema,
} from "@ccflare/core";
import type {
	BudgetHistoryFact,
	BudgetHistoryPage,
	BudgetHistoryQuery,
} from "@ccflare/types";

export interface BudgetAttempt {
	id: string;
	account_id: string;
	group_id: string;
	model: string | null;
	estimated_work: number;
	admitted_work: number;
	admitted_percent: number;
	actual_work: number | null;
	created_at: number;
}
export class BudgetTelemetryRepository {
	constructor(
		private readonly db: Database,
		private readonly scope: string,
	) {}
	admit(attempt: BudgetAttempt, requestId: string | null): void {
		this.db
			.query(`INSERT INTO budget_attempts
   (scope_id,id,account_id,group_id,request_id,model,estimated_work,admitted_work,admitted_percent,created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?)`)
			.run(
				this.scope,
				attempt.id,
				attempt.account_id,
				attempt.group_id,
				requestId,
				attempt.model,
				attempt.estimated_work,
				attempt.admitted_work,
				attempt.admitted_percent,
				attempt.created_at,
			);
	}
	bind(id: string, requestId: string): void {
		this.db
			.query(
				"UPDATE budget_attempts SET request_id=? WHERE scope_id=? AND id=? AND request_id IS NULL",
			)
			.run(requestId, this.scope, id);
	}
	attempt(requestId: string, accountId: string): BudgetAttempt | null {
		return this.db
			.query<BudgetAttempt, [string, string, string]>(
				`SELECT id,account_id,group_id,model,estimated_work,admitted_work,admitted_percent,actual_work,created_at
   FROM budget_attempts WHERE scope_id=? AND request_id=? AND account_id=? AND actual_work IS NULL
   ORDER BY created_at DESC LIMIT 1`,
			)
			.get(this.scope, requestId, accountId);
	}
	settle(id: string, work: number, now: number): boolean {
		return (
			this.db
				.query(
					"UPDATE budget_attempts SET actual_work=?,completed_at=? WHERE scope_id=? AND id=? AND actual_work IS NULL",
				)
				.run(work, now, this.scope, id).changes === 1
		);
	}
	workSince(ids: string[], from: number): number {
		if (ids.length === 0 || ids.length > 100) return 0;
		return (
			this.db
				.query<{ total: number }, Array<string | number>>(
					`SELECT COALESCE(SUM(COALESCE(actual_work,admitted_work)),0) AS total FROM budget_attempts
   WHERE scope_id=? AND created_at>=? AND account_id IN (${ids.map(() => "?").join(",")})`,
				)
				.get(this.scope, from, ...ids)?.total ?? 0
		);
	}
	append(fact: BudgetHistoryFact): void {
		const parsed = budgetHistoryFactSchema.parse(fact);
		this.db
			.query(
				"INSERT INTO budget_history(scope_id,account_id,observed_at,value) VALUES (?,?,?,?)",
			)
			.run(
				this.scope,
				parsed.accountId,
				parsed.observedAt,
				JSON.stringify(parsed),
			);
	}
	history(query: BudgetHistoryQuery): BudgetHistoryPage {
		const parsed = budgetHistoryQuerySchema.parse(query);
		const conditions = ["scope_id=?"];
		const parameters: Array<string | number> = [this.scope];
		if (parsed.accountId) {
			conditions.push("account_id=?");
			parameters.push(parsed.accountId);
		}
		if (parsed.before) {
			conditions.push("id<?");
			parameters.push(parsed.before);
		}
		const rows = this.db
			.query<{ id: number; value: string }, Array<string | number>>(
				`SELECT id,value FROM budget_history WHERE ${conditions.join(" AND ")} ORDER BY id DESC LIMIT ?`,
			)
			.all(...parameters, parsed.limit + 1);
		const entries = rows.slice(0, parsed.limit).map((row) => ({
			id: row.id,
			...budgetHistoryFactSchema.parse(JSON.parse(row.value)),
		}));
		return {
			entries,
			nextBefore:
				rows.length > parsed.limit ? (entries.at(-1)?.id ?? null) : null,
		};
	}
	prune(now: number): void {
		const before = now - 14 * 86_400_000;
		this.db
			.query("DELETE FROM budget_history WHERE scope_id=? AND observed_at<?")
			.run(this.scope, before);
		this.db
			.query("DELETE FROM budget_attempts WHERE scope_id=? AND created_at<?")
			.run(this.scope, before);
		this.db
			.query(`DELETE FROM budget_history WHERE scope_id=? AND id <
   (SELECT id FROM budget_history WHERE scope_id=? ORDER BY id DESC LIMIT 1 OFFSET 49999)`)
			.run(this.scope, this.scope);
		this.db
			.query(`DELETE FROM budget_attempts WHERE scope_id=? AND rowid <
   (SELECT rowid FROM budget_attempts WHERE scope_id=? ORDER BY rowid DESC LIMIT 1 OFFSET 199999)`)
			.run(this.scope, this.scope);
	}
}
