import { describe, expect, it } from "bun:test";
import { readZstdFrameContentSize } from "./zstd-frame";

describe("readZstdFrameContentSize", () => {
	it("reads the declared size from Bun zstd frames", () => {
		const input = new TextEncoder().encode("bounded payload".repeat(64));
		const compressed = Bun.zstdCompressSync(input);

		expect(readZstdFrameContentSize(compressed)).toBe(input.byteLength);
	});

	it("rejects frames without a bounded declared content size", () => {
		const frameWithoutContentSize = new Uint8Array([
			0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00,
		]);

		expect(readZstdFrameContentSize(frameWithoutContentSize)).toBeNull();
	});

	it("rejects invalid or truncated frames", () => {
		expect(readZstdFrameContentSize(new Uint8Array([1, 2, 3, 4]))).toBeNull();
		expect(
			readZstdFrameContentSize(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0xe0])),
		).toBeNull();
	});
});
