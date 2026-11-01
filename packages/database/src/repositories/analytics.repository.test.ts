import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { ensureSchema, runMigrations } from "../migrations";
import { AnalyticsRepository } from "./analytics.repository";

function insertAccount(db: Database): string {
	const accountId = "analytics-account";
	db.run(
		`INSERT INTO accounts (
			id, name, provider, auth_method, api_key, created_at, weight
		) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[
			accountId,
			"Analytics Account",
			"openai",
			"api_key",
			"sk-test",
			Date.now(),
			1,
		],
	);
	return accountId;
}

function insertRequest(
	db: Database,
	request: {
		id: string;
		timestamp: number;
		accountId: string;
		statusCode: number | null;
		success: number | null;
		responseTimeMs: number | null;
		costUsd?: number | null;
	},
): void {
	db.run(
		`INSERT INTO requests (
			id,
			timestamp,
			method,
			path,
			provider,
			upstream_path,
			account_used,
			status_code,
			success,
			error_message,
			response_time_ms,
			failover_attempts,
			total_tokens,
			cost_usd
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			request.id,
			request.timestamp,
			"POST",
			"/v1/openai/responses",
			"openai",
			"/responses",
			request.accountId,
			request.statusCode,
			request.success,
			null,
			request.responseTimeMs,
			0,
			10,
			request.costUsd === undefined ? 0.25 : request.costUsd,
		],
	);
}

describe("AnalyticsRepository", () => {
	it("excludes in-flight requests from total success-rate denominators", () => {
		const db = new Database(":memory:");

		try {
			ensureSchema(db);
			runMigrations(db);

			const accountId = insertAccount(db);
			const now = Date.now();

			insertRequest(db, {
				id: "request-success",
				timestamp: now - 3_000,
				accountId,
				statusCode: 200,
				success: 1,
				responseTimeMs: 120,
			});
			insertRequest(db, {
				id: "request-failure",
				timestamp: now - 2_000,
				accountId,
				statusCode: 429,
				success: 0,
				responseTimeMs: 250,
			});
			insertRequest(db, {
				id: "request-inflight",
				timestamp: now - 1_000,
				accountId,
				statusCode: null,
				success: null,
				responseTimeMs: null,
			});

			const repository = new AnalyticsRepository(db);
			const analytics = repository.getAnalytics({
				startMs: now - 10_000,
				bucketMs: 10_000,
			});

			expect(analytics.totals.requests).toBe(3);
			expect(analytics.totals.successRate).toBe(50);
			expect(analytics.accountPerformance).toEqual([
				expect.objectContaining({
					name: "Analytics Account",
					requests: 3,
					successRate: 50,
				}),
			]);
		} finally {
			db.close();
		}
	});

	it("reports token-bearing requests whose cost could not be priced", () => {
		const db = new Database(":memory:");

		try {
			ensureSchema(db);
			runMigrations(db);

			const accountId = insertAccount(db);
			const now = Date.now();

			insertRequest(db, {
				id: "request-priced",
				timestamp: now - 2_000,
				accountId,
				statusCode: 200,
				success: 1,
				responseTimeMs: 120,
				costUsd: 0.25,
			});
			insertRequest(db, {
				id: "request-unpriced",
				timestamp: now - 1_000,
				accountId,
				statusCode: 200,
				success: 1,
				responseTimeMs: 100,
				costUsd: null,
			});

			const repository = new AnalyticsRepository(db);
			const analytics = repository.getAnalytics({
				startMs: now - 10_000,
				bucketMs: 10_000,
			});

			expect(analytics.totals.totalCostUsd).toBe(0.25);
			expect(analytics.totals.unpricedRequests).toBe(1);
			expect(analytics.totals.requestsWithoutUsage).toBe(2);
		} finally {
			db.close();
		}
	});
});
