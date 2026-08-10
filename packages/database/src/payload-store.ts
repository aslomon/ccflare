import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statfsSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	loadPayloadStorePolicy,
	parsePayloadStorePolicy,
} from "./payload-store-policy";
import {
	type PayloadManifest,
	type PayloadStoreError,
	type PayloadStoreErrorCode,
	type PayloadStoreOptions,
	type PayloadStoreResult,
	type PayloadStoreSnapshot,
	type SavedPayload,
	SEGMENT_FILE_PATTERN,
} from "./payload-store-types";
import { readZstdFrameContentSize } from "./zstd-frame";

export {
	type PayloadManifest,
	type PayloadStoreError,
	type PayloadStoreErrorCode,
	type PayloadStoreOptions,
	type PayloadStorePolicy,
	type PayloadStoreResult,
	type PayloadStoreSnapshot,
	parsePayloadManifest,
	type SavedPayload,
} from "./payload-store-types";
export { loadPayloadStorePolicy, parsePayloadStorePolicy };

function error(
	code: PayloadStoreErrorCode,
	message: string,
): PayloadStoreResult<never> {
	return { data: null, error: { code, message } };
}

function hashBytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function serializePayload(data: unknown): PayloadStoreResult<Uint8Array> {
	try {
		return {
			data: new TextEncoder().encode(JSON.stringify(data)),
			error: null,
		};
	} catch (serializationError) {
		return error(
			"invalid_payload",
			`Payload serialization failed: ${serializationError}`,
		);
	}
}

export class PayloadStore {
	private readonly compress: (bytes: Uint8Array) => Uint8Array;
	private readonly decompress: (bytes: Uint8Array) => Uint8Array;
	private readonly readFrameContentSize: (bytes: Uint8Array) => number | null;
	private readonly getFreeBytes: () => number;
	private lastError: PayloadStoreErrorCode | null = null;

	constructor(private readonly options: PayloadStoreOptions) {
		this.compress =
			options.compress ?? ((bytes) => Bun.zstdCompressSync(bytes));
		this.decompress =
			options.decompress ?? ((bytes) => Bun.zstdDecompressSync(bytes));
		this.readFrameContentSize =
			options.readFrameContentSize ?? readZstdFrameContentSize;
		this.ensureDirectory();
		this.getFreeBytes = options.getFreeBytes ?? (() => this.readFreeBytes());
	}

	save(
		id: string,
		data: unknown,
		metadata: { truncated?: boolean; expiresAt?: Date } = {},
	): PayloadStoreResult<SavedPayload> {
		const serialized = serializePayload(data);
		if (!serialized.data) return this.fail(serialized.error);
		if (serialized.data.byteLength > this.options.policy.maxRawBytes) {
			return this.fail({
				code: "payload_too_large",
				message: "Payload exceeds the raw storage limit",
			});
		}
		const guardError = this.checkStorageGuards();
		if (guardError) return this.fail(guardError);

		const compressed = this.compressSafely(serialized.data);
		if (!compressed.data) return this.fail(compressed.error);
		const fileName = `${createHash("sha256").update(id).digest("hex")}.json.zst`;
		const writeError = this.writeAtomically(fileName, compressed.data);
		if (writeError) return this.fail(writeError);

		const evictedFileNames = this.pruneToBudget();
		if (evictedFileNames.includes(fileName)) {
			return this.fail({
				code: "storage_budget_exceeded",
				message: "Payload cannot fit in the store target",
			});
		}
		const createdAt = new Date();
		this.lastError = null;
		return {
			data: {
				manifest: this.createManifest(
					fileName,
					serialized.data,
					compressed.data,
					{
						truncated: metadata.truncated ?? false,
						createdAt,
						expiresAt:
							metadata.expiresAt ??
							new Date(createdAt.getTime() + this.options.policy.retentionMs),
					},
				),
				evictedFileNames,
			},
			error: null,
		};
	}

	load(manifest: PayloadManifest): PayloadStoreResult<unknown> {
		if (manifest.originalBytes > this.options.policy.maxRawBytes) {
			return error(
				"payload_too_large",
				"Manifest exceeds the raw storage limit",
			);
		}
		const segment = this.readSegment(manifest);
		if (!segment.data) return segment;
		if (hashBytes(segment.data) !== manifest.sha256) {
			return error(
				"checksum_mismatch",
				"Payload segment checksum does not match",
			);
		}
		const declaredSize = this.readFrameContentSize(segment.data);
		if (declaredSize !== manifest.originalBytes) {
			return error(
				"invalid_manifest",
				"Zstd frame size does not match manifest",
			);
		}
		return this.decompressAndParse(segment.data, manifest.originalBytes);
	}

	remove(fileName: string): void {
		if (!SEGMENT_FILE_PATTERN.test(fileName)) return;
		rmSync(join(this.options.directory, fileName), { force: true });
	}

	snapshot(): PayloadStoreSnapshot {
		const entries = this.listSegments();
		const databaseBytes = this.readDatabaseBytes();
		const freeBytes = this.getFreeBytes();
		return {
			writable:
				databaseBytes < this.options.policy.databaseHardLimitBytes &&
				freeBytes >= this.options.policy.minimumFreeBytes,
			storedBytes: entries.reduce((total, entry) => total + entry.size, 0),
			storedSegments: entries.length,
			databaseBytes,
			freeBytes,
			budgetBytes: this.options.policy.budgetBytes,
			targetBytes: this.options.policy.targetBytes,
			databaseHardLimitBytes: this.options.policy.databaseHardLimitBytes,
			lastError: this.lastError,
		};
	}

	private fail<T>(storeError: PayloadStoreError): PayloadStoreResult<T> {
		this.lastError = storeError.code;
		return { data: null, error: storeError };
	}

	private ensureDirectory(): void {
		mkdirSync(this.options.directory, { recursive: true, mode: 0o700 });
		chmodSync(this.options.directory, 0o700);
	}

	private readFreeBytes(): number {
		const stats = statfsSync(this.options.directory);
		return stats.bavail * stats.bsize;
	}

	private readDatabaseBytes(): number {
		return ["", "-wal", "-shm"].reduce((total, suffix) => {
			const path = `${this.options.databasePath}${suffix}`;
			return total + (existsSync(path) ? statSync(path).size : 0);
		}, 0);
	}

	private checkStorageGuards(): PayloadStoreError | null {
		if (
			this.readDatabaseBytes() >= this.options.policy.databaseHardLimitBytes
		) {
			return {
				code: "database_limit_reached",
				message: "Database hard limit reached",
			};
		}
		if (this.getFreeBytes() < this.options.policy.minimumFreeBytes) {
			return {
				code: "insufficient_free_space",
				message: "Free-space guard reached",
			};
		}
		return null;
	}

	private compressSafely(bytes: Uint8Array): PayloadStoreResult<Uint8Array> {
		try {
			const compressed = this.compress(bytes);
			if (compressed.byteLength > this.options.policy.budgetBytes) {
				return error(
					"storage_budget_exceeded",
					"Compressed payload exceeds store budget",
				);
			}
			return { data: compressed, error: null };
		} catch (compressionError) {
			return error(
				"compression_failed",
				`Zstd compression failed: ${compressionError}`,
			);
		}
	}

	private writeAtomically(
		fileName: string,
		bytes: Uint8Array,
	): PayloadStoreError | null {
		const finalPath = join(this.options.directory, fileName);
		const temporaryPath = `${finalPath}.${crypto.randomUUID()}.tmp`;
		try {
			writeFileSync(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
			renameSync(temporaryPath, finalPath);
			chmodSync(finalPath, 0o600);
			return null;
		} catch (writeError) {
			rmSync(temporaryPath, { force: true });
			return {
				code: "storage_failed",
				message: `Segment write failed: ${writeError}`,
			};
		}
	}

	private listSegments(): Array<{
		fileName: string;
		size: number;
		mtimeMs: number;
	}> {
		return readdirSync(this.options.directory, { withFileTypes: true }).flatMap(
			(entry) => {
				if (!entry.isFile() || !SEGMENT_FILE_PATTERN.test(entry.name))
					return [];
				const stats = statSync(join(this.options.directory, entry.name));
				return [
					{ fileName: entry.name, size: stats.size, mtimeMs: stats.mtimeMs },
				];
			},
		);
	}

	private pruneToBudget(): string[] {
		const entries = this.listSegments();
		let storedBytes = entries.reduce((total, entry) => total + entry.size, 0);
		if (storedBytes <= this.options.policy.budgetBytes) return [];
		const evicted: string[] = [];
		for (const entry of entries.sort(
			(left, right) => left.mtimeMs - right.mtimeMs,
		)) {
			this.remove(entry.fileName);
			evicted.push(entry.fileName);
			storedBytes -= entry.size;
			if (storedBytes <= this.options.policy.targetBytes) break;
		}
		return evicted;
	}

	private createManifest(
		fileName: string,
		raw: Uint8Array,
		compressed: Uint8Array,
		metadata: { truncated: boolean; createdAt: Date; expiresAt: Date },
	): PayloadManifest {
		return {
			storage: "zstd-segment",
			version: 1,
			fileName,
			originalBytes: raw.byteLength,
			compressedBytes: compressed.byteLength,
			sha256: hashBytes(compressed),
			truncated: metadata.truncated,
			createdAt: metadata.createdAt.toISOString(),
			expiresAt: metadata.expiresAt.toISOString(),
		};
	}

	private readSegment(
		manifest: PayloadManifest,
	): PayloadStoreResult<Uint8Array> {
		const path = join(this.options.directory, manifest.fileName);
		if (!existsSync(path))
			return error("segment_missing", "Payload segment is missing");
		try {
			const bytes = readFileSync(path);
			if (bytes.byteLength !== manifest.compressedBytes) {
				return error(
					"invalid_manifest",
					"Compressed size does not match manifest",
				);
			}
			return { data: bytes, error: null };
		} catch (readError) {
			return error("storage_failed", `Segment read failed: ${readError}`);
		}
	}

	private decompressAndParse(
		compressed: Uint8Array,
		expectedBytes: number,
	): PayloadStoreResult<unknown> {
		try {
			const raw = this.decompress(compressed);
			if (
				raw.byteLength !== expectedBytes ||
				raw.byteLength > this.options.policy.maxRawBytes
			) {
				return error(
					"payload_too_large",
					"Decompressed size exceeds manifest bounds",
				);
			}
			const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
			return { data: parsed, error: null };
		} catch (decompressionError) {
			return error(
				"decompression_failed",
				`Payload decode failed: ${decompressionError}`,
			);
		}
	}
}
