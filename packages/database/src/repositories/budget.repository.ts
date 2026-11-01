import type { Database } from "bun:sqlite";
import {
	budgetProfileSchema,
	budgetSessionSchema,
	budgetStateSchema,
	emptyBudgetState,
} from "@ccflare/core";
import type { BudgetProfile, BudgetState } from "@ccflare/types";
import { BudgetTelemetryRepository } from "./budget-telemetry.repository";

export class BudgetRepository {
	readonly telemetry: BudgetTelemetryRepository;
	constructor(
		private readonly db: Database,
		private readonly scope = "local",
	) {
		this.telemetry = new BudgetTelemetryRepository(db, scope);
	}

	private read(
		table:
			| "account_budgets"
			| "quota_budgets"
			| "budget_sessions"
			| "quota_budgets_v2"
			| "budget_sessions_v2",
		key: string,
		id: string,
	): unknown {
		const row = this.db
			.query<{ value: string }, [string, string]>(
				`SELECT value FROM ${table} WHERE scope_id=? AND ${key}=?`,
			)
			.get(this.scope, id);
		return row ? JSON.parse(row.value) : null;
	}
	private save(
		table:
			| "account_budgets"
			| "quota_budgets"
			| "budget_sessions"
			| "quota_budgets_v2"
			| "budget_sessions_v2",
		key: string,
		id: string,
		value: unknown,
	): void {
		this.db
			.query(
				`INSERT INTO ${table}(scope_id,${key},value) VALUES (?,?,?) ON CONFLICT(scope_id,${key}) DO UPDATE SET value=excluded.value`,
			)
			.run(this.scope, id, JSON.stringify(value));
	}
	profile(id: string): BudgetProfile | null {
		const value = this.read("account_budgets", "account_id", id);
		return value === null ? null : budgetProfileSchema.parse(value);
	}
	saveProfile(id: string, profile: BudgetProfile): void {
		this.save(
			"account_budgets",
			"account_id",
			id,
			budgetProfileSchema.parse(profile),
		);
	}
	state(group: string): BudgetState {
		const value =
			this.read("quota_budgets_v2", "group_id", group) ??
			this.read("quota_budgets", "group_id", group);
		return value === null ? emptyBudgetState() : budgetStateSchema.parse(value);
	}
	saveState(group: string, state: BudgetState): void {
		this.save(
			"quota_budgets_v2",
			"group_id",
			group,
			budgetStateSchema.parse(state),
		);
	}
	session(pool: string) {
		const value =
			this.read("budget_sessions_v2", "pool_id", pool) ??
			this.read("budget_sessions", "pool_id", pool);
		return value === null
			? budgetSessionSchema.parse({ accountId: "", deadline: 0, credits: {} })
			: budgetSessionSchema.parse(value);
	}
	saveSession(
		pool: string,
		session: ReturnType<BudgetRepository["session"]>,
	): void {
		this.save(
			"budget_sessions_v2",
			"pool_id",
			pool,
			budgetSessionSchema.parse(session),
		);
	}
	atomic<T>(operation: () => T): T {
		return this.db.transaction(operation).immediate();
	}
	reservedPercent(group: string, now: number): number {
		const row = this.db
			.query<{ total: number }, [string, string, number]>(
				"SELECT COALESCE(SUM(percent),0) AS total FROM budget_reservations WHERE scope_id=? AND group_id=? AND expires_at>?",
			)
			.get(this.scope, group, now);
		return row?.total ?? 0;
	}
	reservedWork(group: string, now: number): number {
		return (
			this.db
				.query<{ total: number }, [string, string, number]>(
					"SELECT COALESCE(SUM(work),0) AS total FROM budget_reservations WHERE scope_id=? AND group_id=? AND expires_at>?",
				)
				.get(this.scope, group, now)?.total ?? 0
		);
	}
	reservedModelWork(group: string, model: string, now: number): number {
		return (
			this.db
				.query<{ total: number }, [string, string, number, string]>(
					`SELECT COALESCE(SUM(r.work),0) AS total FROM budget_reservations r
   LEFT JOIN budget_attempts a ON a.scope_id=r.scope_id AND a.id=r.id
   WHERE r.scope_id=? AND r.group_id=? AND r.expires_at>? AND (a.model IS NULL OR instr(a.model,?)>0)`,
				)
				.get(this.scope, group, now, model)?.total ?? 0
		);
	}
	reserve(
		account: string,
		group: string,
		id: string,
		work: number,
		percent: number,
		now: number,
		expiresAt: number,
		details?: {
			model: string | null;
			requestId: string | null;
			estimatedWork: number;
		},
	): void {
		this.db
			.query(
				"INSERT INTO budget_reservations(scope_id,id,account_id,group_id,work,percent,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)",
			)
			.run(this.scope, id, account, group, work, percent, now, expiresAt);
		if (details)
			this.telemetry.admit(
				{
					id,
					account_id: account,
					group_id: group,
					model: details.model,
					estimated_work: details.estimatedWork,
					admitted_work: work,
					admitted_percent: percent,
					actual_work: null,
					created_at: now,
				},
				details.requestId,
			);
	}
	settle(id: string, work: number, percent: number): void {
		this.db
			.query(
				"UPDATE budget_reservations SET work=?,percent=? WHERE scope_id=? AND id=?",
			)
			.run(work, percent, this.scope, id);
	}
	finish(id: string, now: number): void {
		this.db
			.query(
				"UPDATE budget_reservations SET finished_at=? WHERE scope_id=? AND id=? AND finished_at IS NULL",
			)
			.run(now, this.scope, id);
	}
	renew(id: string, expiresAt: number): void {
		this.db
			.query(
				"UPDATE budget_reservations SET expires_at=? WHERE scope_id=? AND id=? AND finished_at IS NULL",
			)
			.run(expiresAt, this.scope, id);
	}
	reconcile(group: string, before: number): void {
		this.db
			.query(
				"DELETE FROM budget_reservations WHERE scope_id=? AND group_id=? AND finished_at IS NOT NULL AND finished_at<?",
			)
			.run(this.scope, group, before);
	}
	prune(now: number): void {
		this.db
			.query(
				"DELETE FROM budget_reservations WHERE scope_id=? AND expires_at<=?",
			)
			.run(this.scope, now);
	}
	moneyUsage(
		ids: string[],
		from: number,
		until: number,
	): { total: number; unknown: number } {
		const placeholders = ids.map(() => "?").join(",");
		if (!ids.length) return { total: 0, unknown: 0 };
		return (
			this.db
				.query<
					{ total: number; unknown: number },
					Array<string | number>
				>(`SELECT COALESCE(SUM(cost_usd),0) AS total,
   COALESCE(SUM(CASE WHEN cost_usd IS NULL AND (COALESCE(input_tokens,0)+COALESCE(output_tokens,0)+COALESCE(cache_read_input_tokens,0)+COALESCE(cache_creation_input_tokens,0)+COALESCE(reasoning_tokens,0))>0 THEN 1 ELSE 0 END),0) AS unknown
   FROM requests WHERE account_used IN (${placeholders}) AND timestamp>=? AND timestamp<?`)
				.get(...ids, from, until) ?? { total: 0, unknown: 0 }
		);
	}
}
