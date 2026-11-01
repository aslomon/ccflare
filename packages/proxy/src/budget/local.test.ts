import { expect, it } from "bun:test";
import { budgetPolicySchema, budgetProfileSchema } from "@ccflare/core";
import { BudgetRepository, DatabaseOperations } from "@ccflare/database";
import { BudgetControl } from "./control";
import { reserveBudgetRequest } from "./request";

it("admits local accounts without weekly telemetry and preserves model/manual restrictions", async () => {
	const db = new DatabaseOperations(":memory:");
	const account = db.createApiKeyAccount({
		name: "local",
		provider: "lmstudio",
		apiKey: "local",
	});
	const control = new BudgetControl(
		db,
		new BudgetRepository(db.getDatabase()),
		budgetPolicySchema.parse({ enabled: true }),
	);
	control.setProfile(
		account,
		budgetProfileSchema.parse({ mode: "local", models: ["qwen/*"] }),
	);
	expect(control.view(account, "qwen/test").eligible).toBe(true);
	expect(control.view(account, "qwen/test").weeklyUsed).toBeNull();
	expect(control.order([account], "claude-sonnet")).toEqual([]);
	expect(control.order([account], "qwen/test")).toEqual([account]);
	const buffer = new TextEncoder().encode(
		JSON.stringify({ model: "qwen/test", max_tokens: 100 }),
	).buffer;
	expect(await reserveBudgetRequest(control, account, buffer)).toBe(
		"unmanaged",
	);
	const cloud = db.createApiKeyAccount({
		name: "cloud",
		provider: "anthropic",
		apiKey: "cloud",
	});
	expect(() =>
		control.setProfile(cloud, budgetProfileSchema.parse({ mode: "local" })),
	).toThrow();
});
