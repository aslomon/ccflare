import { afterEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	PayloadStore,
	type PayloadStorePolicy,
	parsePayloadStorePolicy,
} from "./payload-store";

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "ccflare-payload-store-"));
	temporaryDirectories.push(directory);
	return directory;
}

function createPolicy(
	overrides: Partial<PayloadStorePolicy> = {},
): PayloadStorePolicy {
	return {
		maxRawBytes: 1024 * 1024,
		budgetBytes: 512 * 1024 * 1024,
		targetBytes: 384 * 1024 * 1024,
		databaseHardLimitBytes: 1024 * 1024 * 1024,
		minimumFreeBytes: 64 * 1024 * 1024,
		retentionMs: 7 * 24 * 60 * 60 * 1000,
		...overrides,
	};
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("parsePayloadStorePolicy", () => {
	it("uses the enforced storage limits by default", () => {
		const result = parsePayloadStorePolicy({});

		expect(result.error).toBeNull();
		expect(result.data).toEqual(createPolicy());
	});

	it("rejects a target that is not below the hard budget", () => {
		const result = parsePayloadStorePolicy({
			CF_PAYLOAD_STORE_BUDGET_BYTES: "1024",
			CF_PAYLOAD_STORE_TARGET_BYTES: "1024",
		});

		expect(result.data).toBeNull();
		expect(result.error).toContain("TARGET");
	});

	it("maps explicit runtime guards into the storage policy", () => {
		const result = parsePayloadStorePolicy({
			CF_PAYLOAD_STORE_BUDGET_BYTES: "512",
			CF_PAYLOAD_STORE_TARGET_BYTES: "384",
			CF_PAYLOAD_STORE_DATABASE_HARD_LIMIT_BYTES: "1024",
			CF_PAYLOAD_STORE_MAX_RAW_BYTES: "128",
			CF_PAYLOAD_STORE_MIN_FREE_BYTES: "64",
			DATA_RETENTION_DAYS: "7",
		});

		expect(result.error).toBeNull();
		expect(result.data).toEqual({
			maxRawBytes: 128,
			budgetBytes: 512,
			targetBytes: 384,
			databaseHardLimitBytes: 1024,
			minimumFreeBytes: 64,
			retentionMs: 7 * 24 * 60 * 60 * 1000,
		});
	});
});

describe("PayloadStore", () => {
	it("writes a private zstd segment and transparently restores the payload", () => {
		const directory = createTemporaryDirectory();
		const databasePath = join(directory, "ccflare.db");
		writeFileSync(databasePath, "db");
		const store = new PayloadStore({
			directory: join(directory, "payloads"),
			databasePath,
			policy: createPolicy(),
		});
		const payload = { request: "hello", response: "world" };

		const saved = store.save("request-1", payload, { truncated: true });
		expect(saved.error).toBeNull();
		if (!saved.data) throw new Error("Expected payload manifest");
		expect(saved.data.manifest).toMatchObject({
			storage: "zstd-segment",
			version: 1,
			truncated: true,
		});
		const segmentPath = join(
			directory,
			"payloads",
			saved.data.manifest.fileName,
		);
		expect(statSync(segmentPath).mode & 0o777).toBe(0o600);
		expect(readFileSync(segmentPath).byteLength).toBe(
			saved.data.manifest.compressedBytes,
		);

		const loaded = store.load(saved.data.manifest);
		expect(loaded.error).toBeNull();
		expect(loaded.data).toEqual(payload);
	});

	it("rejects oversized payloads without writing a segment", () => {
		const directory = createTemporaryDirectory();
		const store = new PayloadStore({
			directory,
			databasePath: join(directory, "ccflare.db"),
			policy: createPolicy({ maxRawBytes: 32 }),
		});

		const saved = store.save("request-large", { value: "x".repeat(100) });

		expect(saved.data).toBeNull();
		expect(saved.error?.code).toBe("payload_too_large");
		expect(store.snapshot().storedSegments).toBe(0);
	});

	it("rejects corrupt segments before parsing payload JSON", () => {
		const directory = createTemporaryDirectory();
		const store = new PayloadStore({
			directory,
			databasePath: join(directory, "ccflare.db"),
			policy: createPolicy(),
		});
		const saved = store.save("request-corrupt", { value: "safe" });
		if (!saved.data) throw new Error("Expected payload manifest");
		const segmentPath = join(directory, saved.data.manifest.fileName);
		chmodSync(segmentPath, 0o600);
		const corrupted = readFileSync(segmentPath);
		corrupted[corrupted.byteLength - 1] ^= 0xff;
		writeFileSync(segmentPath, corrupted);

		const loaded = store.load(saved.data.manifest);

		expect(loaded.data).toBeNull();
		expect(loaded.error?.code).toBe("checksum_mismatch");
	});

	it("checks the declared output size before calling the decompressor", () => {
		const directory = createTemporaryDirectory();
		let decompressionCalls = 0;
		const store = new PayloadStore({
			directory,
			databasePath: join(directory, "ccflare.db"),
			policy: createPolicy({ maxRawBytes: 16 }),
			decompress() {
				decompressionCalls += 1;
				return new Uint8Array();
			},
		});
		const saved = store.save("request-size", { value: "ok" });
		if (!saved.data) throw new Error("Expected payload manifest");

		const loaded = store.load({
			...saved.data.manifest,
			originalBytes: 17,
		});

		expect(loaded.error?.code).toBe("payload_too_large");
		expect(decompressionCalls).toBe(0);
	});

	it("prunes oldest segments to the low-water target when the budget is reached", () => {
		const directory = createTemporaryDirectory();
		const store = new PayloadStore({
			directory,
			databasePath: join(directory, "ccflare.db"),
			policy: createPolicy({ budgetBytes: 150, targetBytes: 90 }),
			compress: (bytes) => bytes,
			decompress: (bytes) => bytes,
			readFrameContentSize: (bytes) => bytes.byteLength,
		});
		const first = store.save("request-old", { value: "a".repeat(45) });
		const second = store.save("request-middle", { value: "b".repeat(45) });
		const third = store.save("request-new", { value: "c".repeat(45) });

		expect(first.error).toBeNull();
		expect(second.error).toBeNull();
		expect(third.error).toBeNull();
		if (!third.data) throw new Error("Expected payload manifest");
		expect(third.data.evictedFileNames.length).toBeGreaterThan(0);
		expect(store.snapshot().storedBytes).toBeLessThanOrEqual(90);
	});

	it("fails closed when the database or free-space guard is exceeded", () => {
		const directory = createTemporaryDirectory();
		const databasePath = join(directory, "ccflare.db");
		writeFileSync(databasePath, "database");
		const store = new PayloadStore({
			directory: join(directory, "payloads"),
			databasePath,
			policy: createPolicy({ databaseHardLimitBytes: 4 }),
			getFreeBytes: () => 0,
		});

		const saved = store.save("request-guarded", { value: "small" });

		expect(saved.data).toBeNull();
		expect(saved.error?.code).toBe("database_limit_reached");
		expect(store.snapshot()).toMatchObject({
			writable: false,
			lastError: "database_limit_reached",
		});
	});
});
