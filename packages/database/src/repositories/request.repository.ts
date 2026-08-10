import type { Database } from "bun:sqlite";
import { Logger } from "@ccflare/logger";
import {
	type AccountProvider,
	extractRequestLinkageFromPayload,
	type HttpMethod,
	isAccountProvider,
	isHttpMethod,
	type RequestSummary,
	toRequestSummary,
} from "@ccflare/types";
import {
	type RequestRow,
	type RequestWithAccountName,
	toRequest,
	toRequestWithAccountName,
} from "../models/request-row";
import {
	type PayloadManifest,
	type PayloadStore,
	parsePayloadManifest,
} from "../payload-store";
import { BaseRepository } from "./base.repository";

const log = new Logger("RequestRepository");

export interface RequestData {
	id: string;
	method: HttpMethod;
	path: string;
	provider: AccountProvider;
	upstreamPath: string;
	accountUsed: string | null;
	statusCode: number | null;
	success: boolean;
	errorMessage: string | null;
	responseTime: number;
	failoverAttempts: number;
	usage?: {
		model?: string;
		promptTokens?: number;
		completionTokens?: number;
		totalTokens?: number;
		costUsd?: number | null;
		inputTokens?: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		outputTokens?: number;
		reasoningTokens?: number;
		tokensPerSecond?: number;
	};
	timings?: {
		ttftMs?: number | null;
		proxyOverheadMs?: number | null;
		upstreamTtfbMs?: number | null;
		streamingDurationMs?: number | null;
	};
}

interface PersistRequestData extends RequestData {
	timestamp?: number;
	payload?: unknown;
	linkagePayload?: unknown;
	payloadTruncated?: boolean;
}

export class RequestRepository extends BaseRepository<RequestData> {
	constructor(
		db: Database,
		private readonly payloadStore: PayloadStore | null = null,
		private readonly allowInlinePayloads = true,
	) {
		super(db);
	}

	saveMeta(
		id: string,
		method: HttpMethod,
		path: string,
		provider: AccountProvider,
		upstreamPath: string,
		accountUsed: string | null,
		statusCode: number | null,
		timestamp?: number,
	): void {
		this.run(
			`
			INSERT INTO requests (
				id, timestamp, method, path, provider, upstream_path, account_used, 
				status_code, success, error_message, response_time_ms, failover_attempts
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0)
		`,
			[
				id,
				timestamp ?? Date.now(),
				method,
				path,
				provider,
				upstreamPath,
				accountUsed,
				statusCode,
			],
		);
	}

	save(data: PersistRequestData): void {
		const { usage, timings } = data;
		const linkage = extractRequestLinkageFromPayload(
			data.linkagePayload ?? data.payload,
		);
		const responseChainId = this.resolveResponseChainId(
			linkage.previousResponseId,
			linkage.responseId,
			data.id,
		);

		this.db.run("BEGIN");

		try {
			this.run(
				`
				INSERT OR IGNORE INTO requests (
					id, timestamp, method, path, provider, upstream_path, account_used,
					status_code, success, error_message, response_time_ms, failover_attempts
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0)
			`,
				[
					data.id,
					data.timestamp ?? Date.now(),
					data.method,
					data.path,
					data.provider,
					data.upstreamPath,
					data.accountUsed,
					data.statusCode,
				],
			);

			this.run(
				`
				UPDATE requests
				SET
					method = ?,
					path = ?,
					provider = ?,
					upstream_path = ?,
					account_used = ?,
					status_code = ?,
					success = ?,
					error_message = ?,
					response_time_ms = ?,
					failover_attempts = ?,
					model = ?,
					prompt_tokens = ?,
					completion_tokens = ?,
					total_tokens = ?,
					cost_usd = ?,
					input_tokens = ?,
					cache_read_input_tokens = ?,
					cache_creation_input_tokens = ?,
					output_tokens = ?,
					reasoning_tokens = ?,
					output_tokens_per_second = ?,
					ttft_ms = ?,
					proxy_overhead_ms = ?,
					upstream_ttfb_ms = ?,
					streaming_duration_ms = ?,
					response_id = ?,
					previous_response_id = ?,
					response_chain_id = ?,
					client_session_id = ?
				WHERE id = ?
			`,
				[
					data.method,
					data.path,
					data.provider,
					data.upstreamPath,
					data.accountUsed,
					data.statusCode,
					data.success ? 1 : 0,
					data.errorMessage,
					data.responseTime,
					data.failoverAttempts,
					usage?.model ?? null,
					usage?.promptTokens ?? null,
					usage?.completionTokens ?? null,
					usage?.totalTokens ?? null,
					usage?.costUsd ?? null,
					usage?.inputTokens ?? null,
					usage?.cacheReadInputTokens ?? null,
					usage?.cacheCreationInputTokens ?? null,
					usage?.outputTokens ?? null,
					usage?.reasoningTokens ?? null,
					usage?.tokensPerSecond ?? null,
					timings?.ttftMs ?? null,
					timings?.proxyOverheadMs ?? null,
					timings?.upstreamTtfbMs ?? null,
					timings?.streamingDurationMs ?? null,
					linkage.responseId,
					linkage.previousResponseId,
					responseChainId,
					linkage.clientSessionId,
					data.id,
				],
			);

			this.db.run("COMMIT");
		} catch (error) {
			this.db.run("ROLLBACK");
			throw error;
		}

		this.savePayloadSafely(data.id, data.payload, data.payloadTruncated);
	}

	private savePayloadSafely(
		id: string,
		payload: unknown,
		truncated = false,
	): void {
		if (payload === undefined) return;

		try {
			this.savePayload(id, payload, truncated);
		} catch (error) {
			log.warn(`Failed to persist request payload for ${id}`, error);
		}
	}

	private resolveResponseChainId(
		previousResponseId: string | null,
		responseId: string | null,
		requestId: string,
	): string {
		if (previousResponseId) {
			const parentRow = this.get<{ response_chain_id: string | null }>(
				`
					SELECT response_chain_id
					FROM requests
					WHERE response_id = ?
					LIMIT 1
				`,
				[previousResponseId],
			);

			return parentRow?.response_chain_id ?? previousResponseId;
		}

		return responseId ?? requestId;
	}

	updateUsage(requestId: string, usage: RequestData["usage"]): void {
		if (!usage) return;

		this.run(
			`
			UPDATE requests
			SET 
				model = COALESCE(?, model),
				prompt_tokens = COALESCE(?, prompt_tokens),
				completion_tokens = COALESCE(?, completion_tokens),
				total_tokens = COALESCE(?, total_tokens),
				cost_usd = COALESCE(?, cost_usd),
				input_tokens = COALESCE(?, input_tokens),
				cache_read_input_tokens = COALESCE(?, cache_read_input_tokens),
				cache_creation_input_tokens = COALESCE(?, cache_creation_input_tokens),
				output_tokens = COALESCE(?, output_tokens),
				reasoning_tokens = COALESCE(?, reasoning_tokens),
				output_tokens_per_second = COALESCE(?, output_tokens_per_second)
			WHERE id = ?
		`,
			[
				usage.model ?? null,
				usage.promptTokens ?? null,
				usage.completionTokens ?? null,
				usage.totalTokens ?? null,
				usage.costUsd ?? null,
				usage.inputTokens ?? null,
				usage.cacheReadInputTokens ?? null,
				usage.cacheCreationInputTokens ?? null,
				usage.outputTokens ?? null,
				usage.reasoningTokens ?? null,
				usage.tokensPerSecond ?? null,
				requestId,
			],
		);
	}

	// Payload management
	savePayload(id: string, data: unknown, truncated = false): void {
		if (!this.payloadStore) {
			if (this.allowInlinePayloads) this.saveInlinePayload(id, data);
			return;
		}

		const saved = this.payloadStore.save(id, data, { truncated });
		if (!saved.data) throw new Error(saved.error.message);
		this.deleteEvictedManifestRows(saved.data.evictedFileNames);
		this.upsertPayloadJson(id, JSON.stringify(saved.data.manifest));
	}

	private saveInlinePayload(id: string, data: unknown): void {
		this.upsertPayloadJson(id, JSON.stringify(data));
	}

	private upsertPayloadJson(id: string, json: string): void {
		this.run(
			`
			INSERT INTO request_payloads (id, json)
			VALUES (?, ?)
			ON CONFLICT(id) DO UPDATE SET json = excluded.json
		`,
			[id, json],
		);
	}

	private deleteEvictedManifestRows(fileNames: string[]): void {
		if (fileNames.length === 0) return;
		const evicted = new Set(fileNames);
		for (const row of this.query<{ id: string; json: string }>(
			`SELECT id, json FROM request_payloads`,
		)) {
			const manifest = this.parseManifestJson(row.json);
			if (manifest && evicted.has(manifest.fileName)) {
				this.run(`DELETE FROM request_payloads WHERE id = ?`, [row.id]);
			}
		}
	}

	getPayload(id: string): unknown | null {
		const row = this.get<{ json: string }>(
			`SELECT json FROM request_payloads WHERE id = ?`,
			[id],
		);

		if (!row) return null;

		try {
			const parsed: unknown = JSON.parse(row.json);
			const manifest = parsePayloadManifest(parsed);
			if (!manifest || !this.payloadStore) return parsed;
			const loaded = this.payloadStore.load(manifest);
			if (loaded.error !== null) {
				log.warn(
					`Failed to load request payload for ${id}: ${loaded.error.message}`,
				);
				return null;
			}
			return loaded.data;
		} catch (error) {
			log.warn(`Failed to parse request payload for ${id}`, error);
			return null;
		}
	}

	listPayloads(limit = 50): Array<{ id: string; json: string }> {
		const rows = this.query<{ id: string; json: string }>(
			`
			SELECT rp.id, rp.json 
			FROM request_payloads rp
			JOIN requests r ON rp.id = r.id
			ORDER BY r.timestamp DESC
			LIMIT ?
		`,
			[limit],
		);
		return this.hydrateRows(rows);
	}

	listPayloadsWithAccountNames(
		limit = 50,
	): Array<{ id: string; json: string; account_name: string | null }> {
		const rows = this.query<{
			id: string;
			json: string;
			account_name: string | null;
		}>(
			`
			SELECT rp.id, rp.json, a.name as account_name
			FROM request_payloads rp
			JOIN requests r ON rp.id = r.id
			LEFT JOIN accounts a ON r.account_used = a.id
			ORDER BY r.timestamp DESC
			LIMIT ?
		`,
			[limit],
		);
		return this.hydrateRows(rows);
	}

	listResponseChainPayloadsWithAccountNames(
		requestId: string,
	): Array<{ id: string; json: string; account_name: string | null }> {
		const rows = this.query<{
			id: string;
			json: string;
			account_name: string | null;
		}>(
			`
				WITH RECURSIVE chain AS (
					SELECT
						r.id,
						r.previous_response_id,
						0 AS depth,
						(',' || r.id || ',') AS visited
					FROM requests r
					WHERE r.id = ?
					UNION ALL
					SELECT
						parent.id,
						parent.previous_response_id,
						chain.depth + 1 AS depth,
						(chain.visited || parent.id || ',') AS visited
					FROM chain
					JOIN requests parent
						ON parent.response_id = chain.previous_response_id
					WHERE
						chain.previous_response_id IS NOT NULL
						AND instr(chain.visited, ',' || parent.id || ',') = 0
				)
				SELECT rp.id, rp.json, a.name AS account_name
				FROM chain
				JOIN requests r ON r.id = chain.id
				JOIN request_payloads rp ON rp.id = r.id
				LEFT JOIN accounts a ON r.account_used = a.id
				ORDER BY chain.depth DESC, r.timestamp ASC
			`,
			[requestId],
		);
		return this.hydrateRows(rows);
	}

	private hydrateRows<T extends { id: string; json: string }>(rows: T[]): T[] {
		return rows.flatMap((row) => {
			const hydratedJson = this.hydrateJson(row.id, row.json);
			return hydratedJson === null ? [] : [{ ...row, json: hydratedJson }];
		});
	}

	private hydrateJson(id: string, json: string): string | null {
		const manifest = this.parseManifestJson(json);
		if (!manifest || !this.payloadStore) return json;
		const loaded = this.payloadStore.load(manifest);
		if (loaded.error !== null) {
			log.warn(
				`Failed to hydrate request payload ${id}: ${loaded.error.message}`,
			);
			return null;
		}
		try {
			return JSON.stringify(loaded.data);
		} catch (error) {
			log.warn(`Failed to serialize hydrated request payload ${id}`, error);
			return null;
		}
	}

	private parseManifestJson(json: string): PayloadManifest | null {
		try {
			const parsed: unknown = JSON.parse(json);
			return parsePayloadManifest(parsed);
		} catch {
			return null;
		}
	}

	// Analytics queries
	getRecentRequests(limit = 100) {
		return this.query<RequestRow>(
			`
				SELECT *
				FROM requests
				ORDER BY timestamp DESC
				LIMIT ?
			`,
			[limit],
		).flatMap((row) => {
			if (!isHttpMethod(row.method) || !isAccountProvider(row.provider)) {
				return [];
			}

			return [toRequest(row)];
		});
	}

	listSummaries(limit = 100): RequestSummary[] {
		return this.query<RequestRow & { account_name: string | null }>(
			`
				SELECT r.*, a.name as account_name
				FROM requests r
				LEFT JOIN accounts a ON r.account_used = a.id
				ORDER BY r.timestamp DESC
				LIMIT ?
			`,
			[limit],
		).flatMap((row) => {
			if (!isHttpMethod(row.method) || !isAccountProvider(row.provider)) {
				return [];
			}

			return [
				{
					...toRequestSummary(toRequest(row)),
					accountName: row.account_name ?? null,
				},
			];
		});
	}

	listWithAccountNames(limit = 100): RequestWithAccountName[] {
		return this.query<RequestRow & { account_name: string | null }>(
			`
				SELECT r.*, a.name as account_name
				FROM requests r
				LEFT JOIN accounts a ON r.account_used = a.id
				ORDER BY r.timestamp DESC
				LIMIT ?
			`,
			[limit],
		).flatMap((row) => {
			if (!isHttpMethod(row.method) || !isAccountProvider(row.provider)) {
				return [];
			}

			return [toRequestWithAccountName(row)];
		});
	}

	getRequestStats(since?: number): {
		totalRequests: number;
		successfulRequests: number;
		failedRequests: number;
		avgResponseTime: number | null;
	} {
		const whereClause = since ? "WHERE timestamp > ?" : "";
		const params = since ? [since] : [];

		const result = this.get<{
			total_requests: number;
			successful_requests: number;
			failed_requests: number;
			avg_response_time: number | null;
		}>(
			`
			SELECT 
				COUNT(*) as total_requests,
				SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successful_requests,
				SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failed_requests,
				AVG(response_time_ms) as avg_response_time
			FROM requests
			${whereClause}
		`,
			params,
		);

		return {
			totalRequests: result?.total_requests ?? 0,
			successfulRequests: result?.successful_requests ?? 0,
			failedRequests: result?.failed_requests ?? 0,
			avgResponseTime: result?.avg_response_time ?? null,
		};
	}

	/**
	 * Aggregate statistics with optional time range
	 * Consolidates duplicate SQL queries from stats handlers
	 */
	aggregateStats(rangeMs?: number): {
		totalRequests: number;
		completedRequests: number;
		successfulRequests: number;
		avgResponseTime: number | null;
		totalTokens: number;
		totalCostUsd: number;
		inputTokens: number;
		outputTokens: number;
		cacheReadInputTokens: number;
		cacheCreationInputTokens: number;
		avgTokensPerSecond: number | null;
	} {
		const whereClause = rangeMs ? "WHERE timestamp > ?" : "";
		const params = rangeMs ? [Date.now() - rangeMs] : [];

		const result = this.get<{
			total_requests: number;
			completed_requests: number;
			successful_requests: number;
			avg_response_time: number | null;
			total_tokens: number | null;
			total_cost_usd: number | null;
			input_tokens: number | null;
			output_tokens: number | null;
			cache_read_input_tokens: number | null;
			cache_creation_input_tokens: number | null;
			avg_tokens_per_second: number | null;
		}>(
			`
			SELECT 
				COUNT(*) as total_requests,
				SUM(CASE WHEN success IS NOT NULL THEN 1 ELSE 0 END) as completed_requests,
				SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successful_requests,
				AVG(response_time_ms) as avg_response_time,
				SUM(
					COALESCE(
						total_tokens,
						COALESCE(input_tokens, 0) +
							COALESCE(output_tokens, 0) +
							COALESCE(cache_read_input_tokens, 0) +
							COALESCE(cache_creation_input_tokens, 0)
					)
				) as total_tokens,
				SUM(cost_usd) as total_cost_usd,
				SUM(input_tokens) as input_tokens,
				SUM(output_tokens) as output_tokens,
				SUM(cache_read_input_tokens) as cache_read_input_tokens,
				SUM(cache_creation_input_tokens) as cache_creation_input_tokens,
				AVG(output_tokens_per_second) as avg_tokens_per_second
			FROM requests
			${whereClause}
		`,
			params,
		);

		return {
			totalRequests: result?.total_requests ?? 0,
			completedRequests: result?.completed_requests ?? 0,
			successfulRequests: result?.successful_requests ?? 0,
			avgResponseTime: result?.avg_response_time ?? null,
			totalTokens: result?.total_tokens ?? 0,
			totalCostUsd: result?.total_cost_usd ?? 0,
			inputTokens: result?.input_tokens ?? 0,
			outputTokens: result?.output_tokens ?? 0,
			cacheReadInputTokens: result?.cache_read_input_tokens ?? 0,
			cacheCreationInputTokens: result?.cache_creation_input_tokens ?? 0,
			avgTokensPerSecond: result?.avg_tokens_per_second ?? null,
		};
	}

	/**
	 * Get top models by usage
	 */
	getTopModels(limit = 10): Array<{ model: string; count: number }> {
		return this.query<{ model: string; count: number }>(
			`
			SELECT model, COUNT(*) as count
			FROM requests
			WHERE model IS NOT NULL
			GROUP BY model
			ORDER BY count DESC
			LIMIT ?
		`,
			[limit],
		);
	}

	/**
	 * Get recent error messages
	 */
	getRecentErrors(limit = 10): string[] {
		const errors = this.query<{ error_message: string }>(
			`
			SELECT error_message
			FROM (
				SELECT
					error_message,
					MAX(timestamp) as latest_timestamp
				FROM requests
				WHERE error_message IS NOT NULL
					AND error_message != ''
				GROUP BY error_message
			)
			ORDER BY latest_timestamp DESC
			LIMIT ?
		`,
			[limit],
		);
		return errors.map((e: { error_message: string }) => e.error_message);
	}

	getRequestsByAccount(since?: number): Array<{
		accountId: string;
		accountName: string | null;
		requestCount: number;
		successRate: number;
	}> {
		const whereClause = since ? "WHERE r.timestamp > ?" : "";
		const params = since ? [since] : [];

		return this.query<{
			account_id: string;
			account_name: string | null;
			request_count: number;
			success_rate: number;
		}>(
			`
			SELECT 
				r.account_used as account_id,
				a.name as account_name,
				COUNT(*) as request_count,
				SUM(CASE WHEN r.success = 1 THEN 1 ELSE 0 END) * 100.0 /
					NULLIF(SUM(CASE WHEN r.success IS NOT NULL THEN 1 ELSE 0 END), 0) as success_rate
			FROM requests r
			LEFT JOIN accounts a ON r.account_used = a.id
			${whereClause}
			GROUP BY r.account_used
			ORDER BY request_count DESC
		`,
			params,
		).map((row) => ({
			accountId: row.account_id,
			accountName: row.account_name,
			requestCount: row.request_count,
			successRate: row.success_rate,
		}));
	}

	deleteOlderThan(cutoffTs: number): number {
		const manifests = this.selectPayloadManifests(
			`SELECT rp.json FROM request_payloads rp JOIN requests r ON r.id = rp.id WHERE r.timestamp < ?`,
			[cutoffTs],
		);
		const removed = this.runWithChanges(
			`DELETE FROM requests WHERE timestamp < ?`,
			[cutoffTs],
		);
		this.removeManifestFiles(manifests);
		return removed;
	}

	clear(): number {
		const manifests = this.selectPayloadManifests(
			`SELECT json FROM request_payloads`,
		);
		const removed = this.runWithChanges(`DELETE FROM requests`);
		this.removeManifestFiles(manifests);
		return removed;
	}

	deleteOrphanedPayloads(): number {
		const manifests = this.selectPayloadManifests(
			`SELECT json FROM request_payloads WHERE id NOT IN (SELECT id FROM requests)`,
		);
		const removed = this.runWithChanges(
			`DELETE FROM request_payloads WHERE id NOT IN (SELECT id FROM requests)`,
		);
		this.removeManifestFiles(manifests);
		return removed;
	}

	deletePayloadsOlderThan(cutoffTs: number): number {
		const manifests = this.selectPayloadManifests(
			`SELECT rp.json FROM request_payloads rp JOIN requests r ON r.id = rp.id WHERE r.timestamp < ?`,
			[cutoffTs],
		);
		const removed = this.runWithChanges(
			`DELETE FROM request_payloads WHERE id IN (SELECT id FROM requests WHERE timestamp < ?)`,
			[cutoffTs],
		);
		this.removeManifestFiles(manifests);
		return removed;
	}

	private selectPayloadManifests(
		sql: string,
		params: Array<string | number | boolean | null | Buffer> = [],
	): PayloadManifest[] {
		return this.query<{ json: string }>(sql, params).flatMap((row) => {
			const manifest = this.parseManifestJson(row.json);
			return manifest ? [manifest] : [];
		});
	}

	private removeManifestFiles(manifests: PayloadManifest[]): void {
		if (!this.payloadStore) return;
		for (const manifest of manifests)
			this.payloadStore.remove(manifest.fileName);
	}
}
