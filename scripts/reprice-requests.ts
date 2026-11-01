import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { applyRepricingPlan, prepareRepricingPlan } from "@ccflare/database";
import { z } from "zod";

function options() {
	const input: Record<string, string | boolean> = {};
	const args = process.argv.slice(2);
	for (let index = 0; index < args.length; index += 1) {
		const name = args[index];
		if (name === "--apply") input.apply = true;
		else if (["--db", "--plan", "--until"].includes(name)) {
			const value = args[++index];
			if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
			input[name.slice(2)] = value;
		} else throw new Error(`Unknown argument: ${name}`);
	}
	return z.object({
		db: z.string().min(1), plan: z.string().min(1), apply: z.boolean().default(false),
		until: z.coerce.number().int().nonnegative().default(Date.now()),
	}).parse(input);
}

async function main(): Promise<void> {
	const config = options();
	const database = new Database(resolve(config.db), { readonly: !config.apply, create: false, strict: true });
	try {
		if (config.apply) {
			const file = Bun.file(resolve(config.plan));
			if (file.size > 64 * 1024 * 1024) throw new Error("Repricing plan exceeds 64 MiB");
			const plan: unknown = JSON.parse(await file.text());
			const result = applyRepricingPlan(database, plan);
			if (result.error !== null) throw new Error(result.error);
			process.stdout.write(`${JSON.stringify(result.data)}\n`);
			return;
		}
		const result = await prepareRepricingPlan(database, config.until);
		if (result.error !== null) throw new Error(result.error);
		const plan = result.data;
		mkdirSync(dirname(resolve(config.plan)), { recursive: true, mode: 0o700 });
		writeFileSync(resolve(config.plan), JSON.stringify(plan), { mode: 0o600, flag: "wx" });
		process.stdout.write(`${JSON.stringify({ scannedRows: plan.scannedRows,
			changedRows: plan.changes.length, summary: plan.summary, basis: plan.basis })}\n`);
	} finally {
		database.close();
	}
}

if (import.meta.main) {
	try { await main(); }
	catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
