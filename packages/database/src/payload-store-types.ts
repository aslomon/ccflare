import { z } from "zod";

export const SEGMENT_FILE_PATTERN = /^[a-f0-9]{64}\.json\.zst$/;

const payloadManifestSchema = z
	.object({
		storage: z.literal("zstd-segment"),
		version: z.literal(1),
		fileName: z.string().regex(SEGMENT_FILE_PATTERN),
		originalBytes: z.number().int().min(0),
		compressedBytes: z.number().int().min(0),
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
		truncated: z.boolean(),
		createdAt: z.string().datetime(),
		expiresAt: z.string().datetime(),
	})
	.strict();

export type PayloadManifest = z.infer<typeof payloadManifestSchema>;

export interface PayloadStorePolicy {
	maxRawBytes: number;
	budgetBytes: number;
	targetBytes: number;
	databaseHardLimitBytes: number;
	minimumFreeBytes: number;
	retentionMs: number;
}

export type PayloadStoreErrorCode =
	| "checksum_mismatch"
	| "compression_failed"
	| "database_limit_reached"
	| "decompression_failed"
	| "insufficient_free_space"
	| "invalid_manifest"
	| "invalid_payload"
	| "payload_too_large"
	| "segment_missing"
	| "storage_budget_exceeded"
	| "storage_failed";

export interface PayloadStoreError {
	code: PayloadStoreErrorCode;
	message: string;
}

export type PayloadStoreResult<T> =
	| { data: T; error: null }
	| { data: null; error: PayloadStoreError };

export interface PayloadStoreOptions {
	directory: string;
	databasePath: string;
	policy: PayloadStorePolicy;
	compress?: (bytes: Uint8Array) => Uint8Array;
	decompress?: (bytes: Uint8Array) => Uint8Array;
	readFrameContentSize?: (bytes: Uint8Array) => number | null;
	getFreeBytes?: () => number;
}

export interface PayloadStoreSnapshot {
	writable: boolean;
	storedBytes: number;
	storedSegments: number;
	databaseBytes: number;
	freeBytes: number;
	budgetBytes: number;
	targetBytes: number;
	databaseHardLimitBytes: number;
	lastError: PayloadStoreErrorCode | null;
}

export interface SavedPayload {
	manifest: PayloadManifest;
	evictedFileNames: string[];
}

export function parsePayloadManifest(value: unknown): PayloadManifest | null {
	const parsed = payloadManifestSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}
