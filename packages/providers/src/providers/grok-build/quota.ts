import { quotaSnapshotSchema } from "@ccflare/core";
import type { Account, QuotaSnapshot } from "@ccflare/types";
import { z } from "zod";
import { readQuotaBody } from "../../quota";
import { GROK_BUILD_BASE_URL } from "./credential";
import { GrokBuildProvider } from "./provider";

const billingSchema = z.object({
	config: z.object({
		// Protobuf JSON omits the zero scalar; require a current weekly period first.
		creditUsagePercent: z.number().finite().min(0).max(10_000).default(0),
		currentPeriod: z.object({
			type: z.literal("USAGE_PERIOD_TYPE_WEEKLY"),
			start: z.string().datetime({ offset: true }),
			end: z.string().datetime({ offset: true }),
		}),
	}),
});

export function parseGrokQuota(value: unknown, now: number): QuotaSnapshot {
	const { config } = billingSchema.parse(value);
	const start = Date.parse(config.currentPeriod.start);
	const resetAt = Date.parse(config.currentPeriod.end);
	if (start > now || resetAt <= now || resetAt - start > 8 * 86_400_000)
		throw new Error("usage_weekly_period_invalid");
	return quotaSnapshotSchema.parse({
		observedAt: now,
		source: "grok-build",
		windows: [
			{
				key: "seven_day",
				usedPercent: config.creditUsagePercent,
				resetAt,
				model: null,
			},
		],
	});
}

export async function readGrokQuota(
	account: Account,
	provider = new GrokBuildProvider(),
	request: typeof fetch = fetch,
): Promise<QuotaSnapshot> {
	await provider.refreshToken(account);
	const headers = provider.prepareHeaders(
		new Headers({ Accept: "application/json" }),
		account,
	);
	const response = await request(
		`${GROK_BUILD_BASE_URL}/billing?format=credits`,
		{
			headers,
			signal: AbortSignal.timeout(15_000),
			redirect: "error",
		},
	);
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`usage_http_${response.status}`);
	}
	return parseGrokQuota(await readQuotaBody(response), Date.now());
}
