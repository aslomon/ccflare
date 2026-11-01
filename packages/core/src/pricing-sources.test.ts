import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateCostResult } from "./pricing";

const originalFetch = globalThis.fetch;
const originalRefresh = process.env.CF_PRICING_REFRESH_HOURS;
const originalTemporaryDirectory = process.env.TMPDIR;
let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "ccflare-price-sources-"));
	process.env.TMPDIR = directory;
	process.env.CF_PRICING_REFRESH_HOURS = "-1";
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalRefresh === undefined)
		delete process.env.CF_PRICING_REFRESH_HOURS;
	else process.env.CF_PRICING_REFRESH_HOURS = originalRefresh;
	if (originalTemporaryDirectory === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = originalTemporaryDirectory;
	rmSync(directory, { recursive: true, force: true });
});

function catalogue(data: unknown): void {
	globalThis.fetch = Object.assign(async () => Response.json(data), {
		preconnect: originalFetch.preconnect,
	});
}

test("uses OpenRouter cache prices for native Claude model identifiers", async () => {
	catalogue({
		data: [
			{
				id: "anthropic/claude-sonnet-5.5",
				pricing: {
					prompt: "0.000002",
					completion: "0.00001",
					input_cache_read: "0.0000001",
					input_cache_write: "0.0000025",
				},
			},
		],
	});
	expect(
		await estimateCostResult("claude-sonnet-5-5", {
			inputTokens: 100,
			outputTokens: 50,
			cacheReadInputTokens: 1_000_000,
			cacheCreationInputTokens: 100,
		}),
	).toEqual({ costUsd: 0.10095, status: "estimated", source: "openrouter" });
});

test("counts cached tokens toward Haiku's long-context threshold", async () => {
	catalogue({
		data: [
			{
				id: "anthropic/claude-haiku-5.5",
				pricing: {
					prompt: "0.0000001",
					completion: "0.0000005",
					input_cache_read: "0.00000001",
					overrides: [
						{
							min_prompt_tokens: 100000,
							prompt: "0.0000005",
							completion: "0.0000025",
							input_cache_read: "0.00000005",
						},
					],
				},
			},
		],
	});
	expect(
		(
			await estimateCostResult("claude-haiku-5-5", {
				cacheReadInputTokens: 100000,
				outputTokens: 1,
			})
		).costUsd,
	).toBe(0.0010005);
	expect(
		(
			await estimateCostResult("claude-haiku-5-5", {
				cacheReadInputTokens: 100001,
				outputTokens: 1,
			})
		).costUsd,
	).toBeCloseTo(0.00500255, 12);
});

test("uses the originating provider instead of an earlier reseller", async () => {
	catalogue({
		reseller: {
			models: {
				"gpt-4o": {
					id: "gpt-4o",
					name: "GPT-4o",
					cost: { input: 99, output: 99 },
				},
			},
		},
		openai: {
			models: {
				"gpt-4o": {
					id: "gpt-4o",
					name: "GPT-4o",
					cost: { input: 2.5, output: 10 },
				},
			},
		},
	});
	expect(
		(await estimateCostResult("gpt-4o", { inputTokens: 1_000_000 })).costUsd,
	).toBe(2.5);
});

test("recognizes Grok Build model aliases", async () => {
	catalogue({
		data: [
			{
				id: "x-ai/grok-4.7",
				pricing: {
					prompt: "0.000002",
					completion: "0.000006",
					input_cache_read: "0.0000005",
				},
			},
		],
	});
	expect(
		(await estimateCostResult("grok-4.7-build", { inputTokens: 1_000_000 }))
			.costUsd,
	).toBe(2);
});

test("preserves base cache rates when a context override only changes input", async () => {
	catalogue({
		data: [
			{
				id: "openai/gpt-6.1-sol",
				pricing: {
					prompt: "0.000002",
					completion: "0.00001",
					input_cache_read: "0.0000001",
					overrides: [{ min_prompt_tokens: 272000, prompt: "0.000004" }],
				},
			},
		],
	});
	expect(
		(
			await estimateCostResult("gpt-6.1-sol", {
				inputTokens: 1,
				cacheReadInputTokens: 272000,
				outputTokens: 1,
			})
		).costUsd,
	).toBeCloseTo(0.027214, 12);
});

test("applies Grok's context tier at the inclusive threshold", async () => {
	catalogue({
		data: [
			{
				id: "x-ai/grok-4.7",
				pricing: {
					prompt: "0.000002",
					completion: "0.000006",
					overrides: [
						{
							min_prompt_tokens: 200000,
							prompt: "0.000004",
							completion: "0.000012",
						},
					],
				},
			},
		],
	});
	expect(
		(await estimateCostResult("grok-4.7-build", { inputTokens: 200000 }))
			.costUsd,
	).toBe(0.8);
});

test("refuses arithmetic overflow instead of persisting an invalid dollar value", async () => {
	catalogue({
		openai: {
			models: {
				"gpt-4o": { id: "gpt-4o", name: "GPT-4o", cost: { input: 1e308 } },
			},
		},
	});
	expect(
		(await estimateCostResult("gpt-4o", { inputTokens: 100 })).costUsd,
	).toBeNull();
});
