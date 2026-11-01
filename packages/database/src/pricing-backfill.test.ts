import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import type { CostEstimateResult } from "@ccflare/core";
import { applyRepricingPlan, prepareRepricingPlan } from "./pricing-backfill";

const db = new Database(":memory:");
db.run(`CREATE TABLE requests (id TEXT PRIMARY KEY, timestamp INTEGER, model TEXT,
 provider TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_input_tokens INTEGER,
 cache_creation_input_tokens INTEGER, prompt_tokens INTEGER, completion_tokens INTEGER, cost_usd REAL)`);
afterEach(() => db.run("DELETE FROM requests"));

function insert(id: string, model: string | null, cost: number | null): void {
	db.query(
		"INSERT INTO requests VALUES (?,100,?,'claude-code',10,2,0,0,10,2,?)",
	).run(id, model, cost);
}
async function estimate(): Promise<CostEstimateResult> {
	return { costUsd: 0.25, status: "estimated", source: "openrouter" };
}

test("prepares an auditable preview without changing stored prices", async () => {
	insert("known", "claude-opus-5-5", 5);
	insert("missing", null, 0);
	const result = await prepareRepricingPlan(db, 200, estimate);
	expect(result.error).toBeNull();
	expect(result.data?.changes).toHaveLength(2);
	expect(
		db.query("SELECT cost_usd FROM requests WHERE id='known'").get(),
	).toEqual({ cost_usd: 5 });
});

test("applies prices while preserving the recorded tokens", async () => {
	insert("known", "claude-opus-5-5", 5);
	const result = await prepareRepricingPlan(db, 200, estimate);
	if (!result.data) throw new Error(result.error);
	expect(applyRepricingPlan(db, result.data).data).toEqual({
		updated: 1,
		skipped: 0,
	});
	expect(
		db.query("SELECT cost_usd,input_tokens,output_tokens FROM requests").get(),
	).toEqual({ cost_usd: 0.25, input_tokens: 10, output_tokens: 2 });
});

test("does not overwrite usage that changed after the preview", async () => {
	insert("known", "claude-opus-5-5", 5);
	const result = await prepareRepricingPlan(db, 200, estimate);
	if (!result.data) throw new Error(result.error);
	db.run("UPDATE requests SET input_tokens=99");
	expect(applyRepricingPlan(db, result.data).data).toEqual({
		updated: 0,
		skipped: 1,
	});
	expect(db.query("SELECT cost_usd FROM requests").get()).toEqual({
		cost_usd: 5,
	});
});

test("rejects invalid plans before any write", () => {
	insert("known", "claude-opus-5-5", 5);
	expect(
		applyRepricingPlan(db, { changes: [{ newCost: -1 }] }).error,
	).not.toBeNull();
	expect(db.query("SELECT cost_usd FROM requests").get()).toEqual({
		cost_usd: 5,
	});
});

test("rolls back earlier updates when a later plan row is outside the cutoff", async () => {
	insert("first", "claude-opus-5-5", 5);
	insert("second", "claude-opus-5-5", 5);
	const result = await prepareRepricingPlan(db, 200, estimate);
	if (!result.data) throw new Error(result.error);
	const plan = {
		...result.data,
		changes: result.data.changes.map((row, index) =>
			index === 1 ? { ...row, timestamp: 201 } : row,
		),
	};
	expect(applyRepricingPlan(db, plan).error).not.toBeNull();
	expect(db.query("SELECT SUM(cost_usd) AS total FROM requests").get()).toEqual(
		{ total: 10 },
	);
});

test("rejects invalid stored usage and respects the selected cutoff", async () => {
	insert("first", "claude-opus-5-5", 5);
	expect((await prepareRepricingPlan(db, 50, estimate)).data?.scannedRows).toBe(
		0,
	);
	db.run("UPDATE requests SET input_tokens=-1");
	expect((await prepareRepricingPlan(db, 200, estimate)).error).not.toBeNull();
});

test("retains local zero costs and marks missing model usage as unknown", async () => {
	insert("local", null, 0);
	db.run("UPDATE requests SET provider='lmstudio'");
	insert("missing", null, 0);
	const result = await prepareRepricingPlan(db, 200, estimate);
	expect(result.data?.changes).toHaveLength(1);
	expect(result.data?.changes[0]).toMatchObject({
		id: "missing",
		newCost: null,
		source: "none",
	});
});

test("rolls back when the transaction's time bound is reached", async () => {
	insert("known", "claude-opus-5-5", 5);
	const result = await prepareRepricingPlan(db, 200, estimate);
	if (!result.data) throw new Error(result.error);
	const now = spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(5001);
	try {
		expect(applyRepricingPlan(db, result.data).error).toContain("time bound");
		expect(db.query("SELECT cost_usd FROM requests").get()).toEqual({
			cost_usd: 5,
		});
	} finally {
		now.mockRestore();
	}
});

test("bounds the number of rows in one repricing plan", async () => {
	db.run(`WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<100001)
 INSERT INTO requests SELECT printf('%06d',n),100,NULL,'lmstudio',0,0,0,0,0,0,0 FROM numbers`);
	const result = await prepareRepricingPlan(db, 200, estimate);
	expect(result.error).toContain("100000 rows");
});
