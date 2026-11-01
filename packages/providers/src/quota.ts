import { quotaSnapshotSchema } from "@ccflare/core";
import type { QuotaSnapshot } from "@ccflare/types";
import { z } from "zod";

const claudeWindow = z.object({
	utilization: z.number().finite().nonnegative(),
	resets_at: z.string().datetime({ offset: true }).nullable(),
});
const claudeUsage = z
	.object({
		seven_day: claudeWindow,
		five_hour: claudeWindow.nullable().optional(),
	})
	.passthrough();
const zaiUsage = z.object({
	success: z.literal(true),
	code: z.literal(200),
	data: z.object({
		limits: z
			.array(
				z.object({
					type: z.string(),
					unit: z.number().int(),
					number: z.number().int().positive(),
					usage: z.number().finite().positive(),
					currentValue: z.number().finite().nonnegative(),
					percentage: z.number().finite().nonnegative(),
					nextResetTime: z.number().int().positive().optional(),
				}),
			)
			.max(32),
	}),
});

export function parseClaudeQuota(value: unknown, now: number): QuotaSnapshot {
	const parsed = claudeUsage.parse(value);
	if (!parsed.seven_day) throw new Error("weekly_quota_missing");
	return quotaSnapshotSchema.parse({
		observedAt: now,
		source: "claude-oauth",
		windows: Object.entries(parsed)
			.filter(
				([key, window]) =>
					window &&
					(key === "five_hour" ||
						(key.startsWith("seven_day") && key !== "seven_day_breakdown")),
			)
			.map(([key, value]) => {
				const window = claudeWindow.parse(value);
				return {
					key,
					usedPercent: window.utilization,
					resetAt: window.resets_at ? Date.parse(window.resets_at) : null,
					model: key.startsWith("seven_day_") ? key.slice(10) : null,
				};
			}),
	});
}
export function parseZaiQuota(value: unknown, now: number): QuotaSnapshot {
	const parsed = zaiUsage.parse(value);
	const limits = parsed.data.limits.filter(
		(l) =>
			l.type === "CREDIT_LIMIT" &&
			((l.unit === 6 && l.number === 1) || (l.unit === 3 && l.number === 5)),
	);
	if (!limits.some((l) => l.unit === 6))
		throw new Error("weekly_quota_missing");
	return quotaSnapshotSchema.parse({
		observedAt: now,
		source: "zai-coding",
		windows: limits.map((l) => ({
			key: l.unit === 6 ? "seven_day" : "five_hour",
			usedPercent: Math.max(l.percentage, (l.currentValue / l.usage) * 100),
			resetAt: l.nextResetTime ?? null,
			model: null,
		})),
	});
}

/** Fixed trusted origins, bounded bodies, and no redirect carrying credentials. */
export async function readProviderQuota(
	mode: "claude" | "zai",
	token: string,
): Promise<QuotaSnapshot> {
	const url =
		mode === "claude"
			? "https://api.anthropic.com/api/oauth/usage"
			: "https://api.z.ai/api/monitor/usage/quota/limit";
	const headers = new Headers({
		Authorization: mode === "claude" ? `Bearer ${token}` : token,
		Accept: "application/json",
	});
	if (mode === "claude") headers.set("anthropic-beta", "oauth-2025-04-20");
	const response = await fetch(url, {
		headers,
		signal: AbortSignal.timeout(15_000),
		redirect: "error",
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`usage_http_${response.status}`);
	}
	const value = await readQuotaBody(response);
	return mode === "claude"
		? parseClaudeQuota(value, Date.now())
		: parseZaiQuota(value, Date.now());
}

export async function readQuotaBody(response: Response): Promise<unknown> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("usage_empty");
	let length = 0;
	const chunks: Uint8Array[] = [];
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			length += chunk.value.length;
			if (length > 65_536) {
				await reader.cancel();
				throw new Error("usage_too_large");
			}
			chunks.push(chunk.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return JSON.parse(new TextDecoder().decode(bytes));
}
