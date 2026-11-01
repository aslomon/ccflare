import type { Database } from "bun:sqlite";

/** Additive migration; existing account pause flags remain manual state. */
export function migrateBudgets(db: Database): void {
	db.transaction(() => {
		db.exec(`CREATE TABLE IF NOT EXISTS account_budgets (
   scope_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
   value TEXT NOT NULL, PRIMARY KEY(scope_id, account_id));
   CREATE TABLE IF NOT EXISTS quota_budgets (
   scope_id TEXT NOT NULL, group_id TEXT NOT NULL, value TEXT NOT NULL,
   PRIMARY KEY(scope_id, group_id));
   CREATE TABLE IF NOT EXISTS budget_sessions (
   scope_id TEXT NOT NULL, pool_id TEXT NOT NULL, value TEXT NOT NULL,
   PRIMARY KEY(scope_id, pool_id));
   CREATE TABLE IF NOT EXISTS budget_reservations (
   scope_id TEXT NOT NULL, id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
   group_id TEXT NOT NULL, work REAL NOT NULL, percent REAL NOT NULL,
   created_at INTEGER NOT NULL, finished_at INTEGER, expires_at INTEGER NOT NULL,
   PRIMARY KEY(scope_id,id));
   CREATE INDEX IF NOT EXISTS idx_budget_reservations_group ON budget_reservations(scope_id,group_id,expires_at);`);
		migrateBudgetTelemetry(db);
	}).immediate();
}

function migrateBudgetTelemetry(db: Database): void {
	db.exec(`CREATE TABLE IF NOT EXISTS quota_budgets_v2 (
   scope_id TEXT NOT NULL, group_id TEXT NOT NULL, value TEXT NOT NULL,
   PRIMARY KEY(scope_id, group_id));
   CREATE TABLE IF NOT EXISTS budget_sessions_v2 (
   scope_id TEXT NOT NULL, pool_id TEXT NOT NULL, value TEXT NOT NULL,
   PRIMARY KEY(scope_id, pool_id));
   CREATE TABLE IF NOT EXISTS budget_attempts (
   scope_id TEXT NOT NULL, id TEXT NOT NULL,
   account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
   group_id TEXT NOT NULL, request_id TEXT, model TEXT,
   estimated_work REAL NOT NULL, admitted_work REAL NOT NULL, admitted_percent REAL NOT NULL, actual_work REAL,
   created_at INTEGER NOT NULL, completed_at INTEGER,
   PRIMARY KEY(scope_id,id));
   CREATE INDEX IF NOT EXISTS idx_budget_attempts_request ON budget_attempts(scope_id,request_id,account_id);
   CREATE INDEX IF NOT EXISTS idx_budget_attempts_time ON budget_attempts(scope_id,created_at);
   CREATE INDEX IF NOT EXISTS idx_budget_attempts_account ON budget_attempts(scope_id,account_id,created_at);
   CREATE TABLE IF NOT EXISTS budget_history (
   id INTEGER PRIMARY KEY AUTOINCREMENT, scope_id TEXT NOT NULL,
   account_id TEXT NOT NULL, observed_at INTEGER NOT NULL, value TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS idx_budget_history_scope ON budget_history(scope_id,id);
   CREATE INDEX IF NOT EXISTS idx_budget_history_account ON budget_history(scope_id,account_id,id);`);
}
