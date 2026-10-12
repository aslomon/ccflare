import { quotaSnapshotSchema } from "@ccflare/core";
import type { QuotaSnapshot, QuotaWindow } from "@ccflare/types";
import { z } from "zod";
import { readQuotaBody } from "../../quota";
import { codexAccountId } from "./headers";

const windowSchema = z.object({
	used_percent: z.number().finite().min(0).max(100),
	limit_window_seconds: z.union([z.literal(18_000), z.literal(604_800)]),
	reset_at: z
		.number()
		.int()
		.positive()
		.max(Number.MAX_SAFE_INTEGER / 1000),
});
const meterSchema = z.object({
	allowed: z.boolean(),
	limit_reached: z.boolean(),
	primary_window: windowSchema,
	secondary_window: windowSchema.nullable().optional(),
});
const modelSlug = z
	.string()
	.min(1)
	.max(50)
	.regex(/^[a-zA-Z0-9_.-]+$/);
const usageSchema = z.object({
	rate_limit: meterSchema,
	additional_rate_limits: z
		.array(
			z.object({
				limit_name: modelSlug,
				normal_model_slug: modelSlug,
				rate_limit: meterSchema,
			}),
		)
		.max(32)
		.nullish(),
});

function meterWindows(
	meter: z.infer<typeof meterSchema>,
	model: string | null,
): QuotaWindow[] {
	const windows = [meter.primary_window, meter.secondary_window].filter(
		(window): window is z.infer<typeof windowSchema> =>
			window !== null && window !== undefined,
	);
	if (!windows.some((window) => window.limit_window_seconds === 604_800)) {
		if (model !== null) return [];
		throw new Error("usage_parse_weekly_missing");
	}
	return windows.map((window) => {
		const key =
			window.limit_window_seconds === 604_800 ? "seven_day" : "five_hour";
		return {
			key: model ? `${key}_${model}` : key,
			usedPercent:
				!meter.allowed || meter.limit_reached ? 100 : window.used_percent,
			resetAt: window.reset_at * 1000,
			model,
		};
	});
}

function mergeWindows(windows: QuotaWindow[]): QuotaWindow[] {
	const merged = new Map<string, QuotaWindow>();
	for (const window of windows) {
		const previous = merged.get(window.key);
		merged.set(
			window.key,
			previous
				? {
						...window,
						usedPercent: Math.max(previous.usedPercent, window.usedPercent),
						resetAt: Math.min(
							previous.resetAt ?? Infinity,
							window.resetAt ?? Infinity,
						),
					}
				: window,
		);
	}
	return [...merged.values()];
}

export function parseCodexQuota(value: unknown, now: number): QuotaSnapshot {
	const result = usageSchema.safeParse(value);
	if (!result.success) throw new Error("usage_parse_invalid");
	const parsed = result.data;
	const windows = meterWindows(parsed.rate_limit, null);
	for (const extra of parsed.additional_rate_limits ?? []) {
		for (const model of new Set([extra.normal_model_slug, extra.limit_name]))
			windows.push(...meterWindows(extra.rate_limit, model));
	}

	const snapshot = quotaSnapshotSchema.safeParse({
		observedAt: now,
		source: "codex-oauth",
		windows: mergeWindows(windows),
	});
	if (!snapshot.success) throw new Error("usage_parse_snapshot_invalid");
	return snapshot.data;
}

/** Subscription allowance only; credits never bypass the ordinary limit. */
export async function readCodexQuota(token: string): Promise<QuotaSnapshot> {
	const headers = new Headers({
		Authorization: `Bearer ${token}`,
		Accept: "application/json",
	});
	const accountId = codexAccountId(token);
	if (accountId) headers.set("ChatGPT-Account-Id", accountId);
	const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
		headers,
		signal: AbortSignal.timeout(15_000),
		redirect: "error",
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`usage_http_${response.status}`);
	}
	return parseCodexQuota(await readQuotaBody(response), Date.now());
}
