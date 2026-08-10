import { z } from "zod";

const DEFAULT_MAX_BYTES_PER_BODY = 256 * 1024;
const HARD_MAX_BYTES_PER_BODY = 1024 * 1024;
const MIN_MAX_BYTES_PER_BODY = 1024;

const rawPayloadEnvironmentSchema = z
	.object({
		CF_RAW_PAYLOAD_CAPTURE: z.enum(["0", "1"]).optional(),
		CF_RAW_PAYLOAD_MAX_BYTES: z
			.string()
			.regex(/^\d+$/)
			.transform(Number)
			.pipe(
				z
					.number()
					.int()
					.min(MIN_MAX_BYTES_PER_BODY)
					.max(HARD_MAX_BYTES_PER_BODY),
			)
			.optional(),
	})
	.strict();

export interface RawPayloadCapturePolicy {
	enabled: boolean;
	maxBytesPerBody: number;
}

export interface RawPayloadCaptureSnapshot {
	capturedBodies: number;
	droppedDisabledBodies: number;
	truncatedBodies: number;
	droppedBytes: number;
}

export interface RawPayloadCaptureCounters {
	recordCaptured(truncatedBytes: number): void;
	recordDisabled(): void;
	snapshot(): RawPayloadCaptureSnapshot;
}

interface RawPayloadEnvironment {
	CF_RAW_PAYLOAD_CAPTURE?: string;
	CF_RAW_PAYLOAD_MAX_BYTES?: string;
}

type RawPayloadCapturePolicyResult =
	| { data: RawPayloadCapturePolicy; error: null }
	| { data: null; error: string };

export interface LimitedCapturedBytes {
	bytes: Uint8Array | null;
	persistRawPayload: boolean;
	truncated: boolean;
}

export interface BoundedResponseBody {
	bytes: Uint8Array | null;
	truncated: boolean;
	droppedBytes: number;
}

function formatValidationError(error: z.ZodError): string {
	return error.issues
		.map(
			(issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`,
		)
		.join("; ");
}

export function parseRawPayloadCapturePolicy(
	environment: RawPayloadEnvironment,
): RawPayloadCapturePolicyResult {
	const result = rawPayloadEnvironmentSchema.safeParse(environment);
	if (!result.success) {
		return { data: null, error: formatValidationError(result.error) };
	}

	return {
		data: {
			enabled: result.data.CF_RAW_PAYLOAD_CAPTURE === "1",
			maxBytesPerBody:
				result.data.CF_RAW_PAYLOAD_MAX_BYTES ?? DEFAULT_MAX_BYTES_PER_BODY,
		},
		error: null,
	};
}

export function loadRawPayloadCapturePolicy(): RawPayloadCapturePolicy {
	const result = parseRawPayloadCapturePolicy({
		CF_RAW_PAYLOAD_CAPTURE: process.env.CF_RAW_PAYLOAD_CAPTURE,
		CF_RAW_PAYLOAD_MAX_BYTES: process.env.CF_RAW_PAYLOAD_MAX_BYTES,
	});
	if (result.data === null) {
		throw new Error(
			`Invalid raw payload capture configuration: ${result.error}`,
		);
	}
	return result.data;
}

export function createRawPayloadCaptureCounters(): RawPayloadCaptureCounters {
	const state: RawPayloadCaptureSnapshot = {
		capturedBodies: 0,
		droppedDisabledBodies: 0,
		truncatedBodies: 0,
		droppedBytes: 0,
	};

	return {
		recordCaptured(truncatedBytes) {
			state.capturedBodies += 1;
			if (truncatedBytes > 0) {
				state.truncatedBodies += 1;
				state.droppedBytes += truncatedBytes;
			}
		},
		recordDisabled() {
			state.droppedDisabledBodies += 1;
		},
		snapshot() {
			return { ...state };
		},
	};
}

export function limitCapturedBytes(
	bytes: Uint8Array | null,
	policy: RawPayloadCapturePolicy,
	counters: RawPayloadCaptureCounters,
): LimitedCapturedBytes {
	if (!bytes || bytes.byteLength === 0) {
		return { bytes: null, persistRawPayload: policy.enabled, truncated: false };
	}

	const retainedLength = Math.min(bytes.byteLength, policy.maxBytesPerBody);
	const droppedBytes = bytes.byteLength - retainedLength;
	if (policy.enabled) counters.recordCaptured(droppedBytes);
	else counters.recordDisabled();

	return {
		bytes: bytes.subarray(0, retainedLength),
		persistRawPayload: policy.enabled,
		truncated: droppedBytes > 0,
	};
}

function combineBoundedChunks(
	chunks: Uint8Array[],
	totalBytes: number,
): Uint8Array | null {
	if (totalBytes === 0) return null;
	const combined = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return combined;
}

export async function readBoundedResponseBody(
	response: Response,
	maxBytes: number,
): Promise<BoundedResponseBody> {
	const reader = response.body?.getReader();
	if (!reader) return { bytes: null, truncated: false, droppedBytes: 0 };

	const chunks: Uint8Array[] = [];
	let retainedBytes = 0;
	let droppedBytes = 0;
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		if (!value) continue;
		const remaining = Math.max(0, maxBytes - retainedBytes);
		const retained = value.subarray(0, remaining);
		if (retained.byteLength > 0) chunks.push(retained);
		retainedBytes += retained.byteLength;
		droppedBytes += value.byteLength - retained.byteLength;
	}

	return {
		bytes: combineBoundedChunks(chunks, retainedBytes),
		truncated: droppedBytes > 0,
		droppedBytes,
	};
}
