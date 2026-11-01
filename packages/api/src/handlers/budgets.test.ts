import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@ccflare/config";
import { budgetPolicySchema } from "@ccflare/core";
import { BudgetRepository, DatabaseOperations } from "@ccflare/database";
import { BudgetControl } from "@ccflare/proxy";
import { createBudgetHandlers } from "./budgets";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function setup() {
	const dir = mkdtempSync(join(tmpdir(), "ccflare-budget-api-"));
	dirs.push(dir);
	const dbOps = new DatabaseOperations(join(dir, "test.db"));
	const config = new Config(join(dir, "config.json"));
	const control = new BudgetControl(
		dbOps,
		new BudgetRepository(dbOps.getDatabase()),
		budgetPolicySchema.parse({ enabled: true }),
	);
	const account = dbOps.createApiKeyAccount({
		name: "GLM",
		provider: "anthropic",
		apiKey: "secret-never-serialize",
		baseUrl: "https://api.z.ai/api/anthropic",
	});
	return {
		dbOps,
		account,
		control,
		handlers: createBudgetHandlers(dbOps, config, control),
	};
}
describe("budget management API", () => {
	it("bounds history reads and checks account existence before querying history", async () => {
		const { dbOps, handlers, control, account } = setup();
		control.observe(account, {
			observedAt: Date.now(),
			source: "zai-coding",
			windows: [
				{
					key: "seven_day",
					usedPercent: 10,
					resetAt: Date.now() + 86_400_000,
					model: null,
				},
			],
		});
		expect(
			handlers.history(
				new Request("http://localhost/api/budgets/history?limit=201"),
			).status,
		).toBe(400);
		expect(
			handlers.history(
				new Request("http://localhost/api/budgets/history?accountId=missing"),
			).status,
		).toBe(404);
		const response = handlers.history(
			new Request(
				`http://localhost/api/budgets/history?accountId=${account.id}&limit=1`,
			),
		);
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toContain("quota");
		expect(text).not.toContain("secret-never-serialize");
		dbOps.close();
	});
	it("exposes quota status without serializing credentials", async () => {
		const { dbOps, handlers } = setup();
		const text = await handlers.get().text();
		expect(text).not.toContain("secret-never-serialize");
		expect(text).toContain("usage_unknown");
		dbOps.close();
	});
	it("rejects invalid policy updates above 90 percent", async () => {
		const { dbOps, handlers } = setup();
		const response = await handlers.policy(
			new Request("http://localhost", {
				method: "POST",
				body: JSON.stringify({ cutoffPercent: 99 }),
			}),
		);
		expect(response.status).toBe(400);
		dbOps.close();
	});
	it("checks account existence before profile updates", async () => {
		const { dbOps, handlers } = setup();
		expect(
			(
				await handlers.profile(
					new Request("http://localhost", { method: "PATCH", body: "{}" }),
					"missing",
				)
			).status,
		).toBe(404);
		dbOps.close();
	});
	it("rejects provider mismatches and saves valid profiles", async () => {
		const { dbOps, handlers, account } = setup();
		const req = (body: unknown) =>
			new Request("http://localhost", {
				method: "PATCH",
				body: JSON.stringify(body),
			});
		expect(
			(await handlers.profile(req({ mode: "claude" }), account.id)).status,
		).toBe(400);
		expect(
			(
				await handlers.profile(
					req({ mode: "zai", models: ["glm-5.3"] }),
					account.id,
				)
			).status,
		).toBe(200);
		dbOps.close();
	});
});
