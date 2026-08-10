import { z } from "zod";
import type { PayloadStorePolicy } from "./payload-store-types";

const MEBIBYTE = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

const payloadStoreEnvironmentSchema = z
	.object({
		CF_PAYLOAD_STORE_BUDGET_BYTES: z.coerce
			.number()
			.int()
			.positive()
			.optional(),
		CF_PAYLOAD_STORE_TARGET_BYTES: z.coerce
			.number()
			.int()
			.positive()
			.optional(),
		CF_PAYLOAD_STORE_DATABASE_HARD_LIMIT_BYTES: z.coerce
			.number()
			.int()
			.positive()
			.optional(),
		CF_PAYLOAD_STORE_MAX_RAW_BYTES: z.coerce
			.number()
			.int()
			.positive()
			.optional(),
		CF_PAYLOAD_STORE_MIN_FREE_BYTES: z.coerce.number().int().min(0).optional(),
		DATA_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).optional(),
	})
	.strict();

interface PayloadStoreEnvironment {
	CF_PAYLOAD_STORE_BUDGET_BYTES?: string;
	CF_PAYLOAD_STORE_TARGET_BYTES?: string;
	CF_PAYLOAD_STORE_DATABASE_HARD_LIMIT_BYTES?: string;
	CF_PAYLOAD_STORE_MAX_RAW_BYTES?: string;
	CF_PAYLOAD_STORE_MIN_FREE_BYTES?: string;
	DATA_RETENTION_DAYS?: string;
}

function formatZodError(validationError: z.ZodError): string {
	return validationError.issues
		.map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`)
		.join("; ");
}

export function parsePayloadStorePolicy(
	environment: PayloadStoreEnvironment,
): { data: PayloadStorePolicy; error: null } | { data: null; error: string } {
	const parsed = payloadStoreEnvironmentSchema.safeParse(environment);
	if (!parsed.success)
		return { data: null, error: formatZodError(parsed.error) };

	const budgetBytes =
		parsed.data.CF_PAYLOAD_STORE_BUDGET_BYTES ?? 512 * MEBIBYTE;
	const targetBytes =
		parsed.data.CF_PAYLOAD_STORE_TARGET_BYTES ?? 384 * MEBIBYTE;
	const databaseHardLimitBytes =
		parsed.data.CF_PAYLOAD_STORE_DATABASE_HARD_LIMIT_BYTES ?? 1024 * MEBIBYTE;
	const maxRawBytes = parsed.data.CF_PAYLOAD_STORE_MAX_RAW_BYTES ?? MEBIBYTE;
	if (targetBytes >= budgetBytes) {
		return {
			data: null,
			error: "CF_PAYLOAD_STORE_TARGET_BYTES must be below budget",
		};
	}
	if (budgetBytes >= databaseHardLimitBytes) {
		return {
			data: null,
			error: "CF_PAYLOAD_STORE_BUDGET_BYTES must be below database hard limit",
		};
	}
	if (maxRawBytes >= budgetBytes) {
		return {
			data: null,
			error: "CF_PAYLOAD_STORE_MAX_RAW_BYTES must be below budget",
		};
	}

	return {
		data: {
			maxRawBytes,
			budgetBytes,
			targetBytes,
			databaseHardLimitBytes,
			minimumFreeBytes:
				parsed.data.CF_PAYLOAD_STORE_MIN_FREE_BYTES ?? 64 * MEBIBYTE,
			retentionMs: (parsed.data.DATA_RETENTION_DAYS ?? 7) * DAY_MS,
		},
		error: null,
	};
}

export function loadPayloadStorePolicy(): PayloadStorePolicy {
	const result = parsePayloadStorePolicy({
		CF_PAYLOAD_STORE_BUDGET_BYTES: process.env.CF_PAYLOAD_STORE_BUDGET_BYTES,
		CF_PAYLOAD_STORE_TARGET_BYTES: process.env.CF_PAYLOAD_STORE_TARGET_BYTES,
		CF_PAYLOAD_STORE_DATABASE_HARD_LIMIT_BYTES:
			process.env.CF_PAYLOAD_STORE_DATABASE_HARD_LIMIT_BYTES,
		CF_PAYLOAD_STORE_MAX_RAW_BYTES: process.env.CF_PAYLOAD_STORE_MAX_RAW_BYTES,
		CF_PAYLOAD_STORE_MIN_FREE_BYTES:
			process.env.CF_PAYLOAD_STORE_MIN_FREE_BYTES,
		DATA_RETENTION_DAYS: process.env.DATA_RETENTION_DAYS,
	});
	if (!result.data)
		throw new Error(`Invalid payload store policy: ${result.error}`);
	return result.data;
}
