import type { Database } from "bun:sqlite";
import {
	type CostEstimateResult,
	estimateCostResult,
	type TokenBreakdown,
} from "@ccflare/core";
import { z } from "zod";

type Estimate = (
	model: string,
	tokens: TokenBreakdown,
) => Promise<CostEstimateResult>;
type Result<T> = { data: T; error: null } | { data: null; error: string };
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const money = z.number().finite().nonnegative().nullable();
const rowSchema = z.object({
	id: z.string().min(1).max(200),
	timestamp: count,
	model: z.string().max(200).nullable(),
	provider: z.string().max(200).nullable(),
	inputTokens: count,
	outputTokens: count,
	cacheReadInputTokens: count,
	cacheCreationInputTokens: count,
	oldCost: money,
});
const changeSchema = rowSchema.extend({
	newCost: money,
	source: z.enum(["openrouter", "models.dev", "local", "none"]),
});
const summarySchema = z.object({
	model: z.string().nullable(),
	provider: z.string().nullable(),
	requests: count,
	oldCost: z.number().finite().nonnegative(),
	newCost: z.number().finite().nonnegative(),
	unpriced: count,
});
export const repricingPlanSchema = z.object({
	createdAt: count,
	until: count,
	scannedRows: count.max(100000),
	basis: z.literal(
		"Current standard API token prices; subscription billing and unrecorded surcharges are excluded",
	),
	changes: z.array(changeSchema).max(100000),
	summary: z.array(summarySchema).max(10000),
});
type Row = z.infer<typeof rowSchema>;
type Plan = z.infer<typeof repricingPlanSchema>;
type Summary = z.infer<typeof summarySchema>;

function failure(error: unknown): { data: null; error: string } {
	return {
		data: null,
		error: error instanceof Error ? error.message : String(error),
	};
}

async function collectChanges(
	rows: Row[],
	changes: Plan["changes"],
	groups: Map<string, Summary>,
	estimate: Estimate,
): Promise<void> {
	for (const row of rows) {
		const result = await quote(row, estimate);
		updateSummary(groups, row, result.costUsd);
		const equal =
			row.oldCost === result.costUsd ||
			(row.oldCost !== null &&
				result.costUsd !== null &&
				Math.abs(row.oldCost - result.costUsd) < 1e-12);
		if (!equal)
			changes.push({ ...row, newCost: result.costUsd, source: result.source });
	}
}

function finishPlan(
	until: number,
	scannedRows: number,
	changes: Plan["changes"],
	groups: Map<string, Summary>,
): Plan {
	return repricingPlanSchema.parse({
		createdAt: Date.now(),
		until,
		scannedRows,
		basis:
			"Current standard API token prices; subscription billing and unrecorded surcharges are excluded",
		changes,
		summary: [...groups.values()],
	});
}

function* requestBatches(db: Database, until: number): Generator<Row[]> {
	const query = db.query<
		unknown,
		[number, string]
	>(`SELECT id,timestamp,model,provider,
 COALESCE(input_tokens,prompt_tokens,0) AS inputTokens,
 COALESCE(output_tokens,completion_tokens,0) AS outputTokens,
 COALESCE(cache_read_input_tokens,0) AS cacheReadInputTokens,
 COALESCE(cache_creation_input_tokens,0) AS cacheCreationInputTokens,
 cost_usd AS oldCost FROM requests WHERE timestamp<=? AND id>? ORDER BY id LIMIT 500`);
	let cursor = "";
	while (true) {
		const rows = query
			.all(until, cursor)
			.map((value) => rowSchema.parse(value));
		if (!rows.length) return;
		yield rows;
		cursor = rows[rows.length - 1].id;
	}
}

function updateSummary(
	groups: Map<string, Summary>,
	row: Row,
	cost: number | null,
): void {
	const key = JSON.stringify([row.provider, row.model]);
	const previous = groups.get(key) ?? {
		model: row.model,
		provider: row.provider,
		requests: 0,
		oldCost: 0,
		newCost: 0,
		unpriced: 0,
	};
	groups.set(key, {
		...previous,
		requests: previous.requests + 1,
		oldCost: previous.oldCost + (row.oldCost ?? 0),
		newCost: previous.newCost + (cost ?? 0),
		unpriced: previous.unpriced + (cost === null ? 1 : 0),
	});
}

async function quote(
	row: Row,
	estimate: Estimate,
): Promise<CostEstimateResult> {
	if (row.provider === "lmstudio")
		return { costUsd: 0, status: "estimated", source: "local" };
	if (!row.model || row.model === "unknown")
		return { costUsd: null, status: "unavailable", source: "none" };
	const result = await estimate(row.model, row);
	if (result.costUsd === null && row.oldCost !== null)
		throw new Error(`Current API price unavailable for ${row.model}`);
	return result;
}

export async function prepareRepricingPlan(
	db: Database,
	until: number,
	estimate: Estimate = estimateCostResult,
): Promise<Result<Plan>> {
	try {
		count.parse(until);
		const changes: Plan["changes"] = [];
		const groups = new Map<string, Summary>();
		let scannedRows = 0;
		for (const rows of requestBatches(db, until)) {
			scannedRows += rows.length;
			if (scannedRows > 100000)
				throw new Error("Repricing is limited to 100000 rows per plan");
			await collectChanges(rows, changes, groups, estimate);
		}
		return {
			data: finishPlan(until, scannedRows, changes, groups),
			error: null,
		};
	} catch (error) {
		return failure(error);
	}
}

function bindings(row: Plan["changes"][number]): (string | number | null)[] {
	return [
		row.newCost,
		row.id,
		row.timestamp,
		row.model,
		row.provider,
		row.oldCost,
		row.inputTokens,
		row.outputTokens,
		row.cacheReadInputTokens,
		row.cacheCreationInputTokens,
	];
}

function executeChanges(
	db: Database,
	plan: Plan,
): { updated: number; skipped: number } {
	const statement =
		db.query(`UPDATE requests SET cost_usd=? WHERE id=? AND timestamp=?
 AND model IS ? AND provider IS ? AND cost_usd IS ?
 AND COALESCE(input_tokens,prompt_tokens,0)=? AND COALESCE(output_tokens,completion_tokens,0)=?
 AND COALESCE(cache_read_input_tokens,0)=? AND COALESCE(cache_creation_input_tokens,0)=?`);
	const result = db
		.transaction(() => {
			let updated = 0;
			const deadline = Date.now() + 5000;
			for (const row of plan.changes) {
				if (row.timestamp > plan.until)
					throw new Error("Plan includes a row beyond its cutoff");
				if (Date.now() > deadline)
					throw new Error("Repricing transaction exceeded its time bound");
				updated += statement.run(...bindings(row)).changes;
			}
			return { updated, skipped: plan.changes.length - updated };
		})
		.immediate();
	return result;
}

export function applyRepricingPlan(
	db: Database,
	value: unknown,
): Result<{ updated: number; skipped: number }> {
	try {
		return {
			data: executeChanges(db, repricingPlanSchema.parse(value)),
			error: null,
		};
	} catch (error) {
		return failure(error);
	}
}
