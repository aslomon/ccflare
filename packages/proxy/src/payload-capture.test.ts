import { describe, expect, it } from "bun:test";
import {
	createRawPayloadCaptureCounters,
	limitCapturedBytes,
	parseRawPayloadCapturePolicy,
	readBoundedResponseBody,
} from "./payload-capture";

describe("parseRawPayloadCapturePolicy", () => {
	it("keeps raw payload persistence disabled by default", () => {
		const result = parseRawPayloadCapturePolicy({});

		expect(result.error).toBeNull();
		expect(result.data).toEqual({
			enabled: false,
			maxBytesPerBody: 256 * 1024,
		});
	});

	it("accepts only explicit enablement and a bounded byte limit", () => {
		const result = parseRawPayloadCapturePolicy({
			CF_RAW_PAYLOAD_CAPTURE: "1",
			CF_RAW_PAYLOAD_MAX_BYTES: "4096",
		});

		expect(result.error).toBeNull();
		expect(result.data).toEqual({ enabled: true, maxBytesPerBody: 4096 });
	});

	it("rejects permissive booleans and limits above the hard cap", () => {
		const invalidBoolean = parseRawPayloadCapturePolicy({
			CF_RAW_PAYLOAD_CAPTURE: "true",
		});
		const oversized = parseRawPayloadCapturePolicy({
			CF_RAW_PAYLOAD_CAPTURE: "1",
			CF_RAW_PAYLOAD_MAX_BYTES: String(1024 * 1024 + 1),
		});

		expect(invalidBoolean.data).toBeNull();
		expect(invalidBoolean.error).toContain("CF_RAW_PAYLOAD_CAPTURE");
		expect(oversized.data).toBeNull();
		expect(oversized.error).toContain("CF_RAW_PAYLOAD_MAX_BYTES");
	});
});

describe("limitCapturedBytes", () => {
	it("caps bytes before callers encode or serialize them", () => {
		const counters = createRawPayloadCaptureCounters();
		const result = limitCapturedBytes(
			new Uint8Array([1, 2, 3, 4, 5, 6]),
			{ enabled: true, maxBytesPerBody: 4 },
			counters,
		);

		expect(Array.from(result.bytes ?? [])).toEqual([1, 2, 3, 4]);
		expect(result.truncated).toBe(true);
		expect(counters.snapshot()).toMatchObject({
			capturedBodies: 1,
			truncatedBodies: 1,
			droppedBytes: 2,
		});
	});

	it("marks raw persistence as dropped while retaining bounded analytics bytes", () => {
		const counters = createRawPayloadCaptureCounters();
		const result = limitCapturedBytes(
			new Uint8Array([1, 2, 3]),
			{ enabled: false, maxBytesPerBody: 4 },
			counters,
		);

		expect(Array.from(result.bytes ?? [])).toEqual([1, 2, 3]);
		expect(result.persistRawPayload).toBe(false);
		expect(counters.snapshot().droppedDisabledBodies).toBe(1);
	});
});

describe("readBoundedResponseBody", () => {
	it("retains at most the configured bytes from a non-streaming response", async () => {
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array([1, 2, 3]));
					controller.enqueue(new Uint8Array([4, 5, 6]));
					controller.close();
				},
			}),
		);

		const result = await readBoundedResponseBody(response, 4);

		expect(Array.from(result.bytes ?? [])).toEqual([1, 2, 3, 4]);
		expect(result.truncated).toBe(true);
		expect(result.droppedBytes).toBe(2);
	});
});
