import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUFFER_SIZES } from "@ccflare/core";
import type { LogEvent } from "@ccflare/types";
import { LogFileWriter } from "./file-writer";

let directory: string;
let logFile: string;
let previousTemporaryDirectory: string | undefined;
let writer: LogFileWriter;

function event(msg: string): LogEvent {
	return { ts: 1, level: "INFO", msg };
}

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "ccflare-log-writer-"));
	previousTemporaryDirectory = process.env.TMPDIR;
	process.env.TMPDIR = directory;
	logFile = join(directory, "ccflare-logs", "app.log");
	writer = new LogFileWriter();
});

afterEach(() => {
	writer.dispose();
	if (previousTemporaryDirectory === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = previousTemporaryDirectory;
	rmSync(directory, { recursive: true, force: true });
});

describe("LogFileWriter", () => {
	test("persists complete JSON records before returning without held descriptors", () => {
		const records = [event("first"), event("Grüße 👋")];
		for (const record of records) writer.write(record);
		expect(readFileSync(logFile, "utf8")).toBe(
			`${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
		);
	});

	test("returns the most recent records and tolerates malformed log rows", async () => {
		const first = event("first");
		const last = event("last");
		writeFileSync(
			logFile,
			`${JSON.stringify(first)}\nbroken\n{}\n${JSON.stringify(last)}\n`,
		);
		expect(await writer.readLogs()).toEqual([first, last]);
		expect(await writer.readLogs(1)).toEqual([last]);
	});

	test("returns empty history when the log file does not exist", async () => {
		expect(await writer.readLogs()).toEqual([]);
	});

	test("rotates during the lifetime of a writer", () => {
		const large = event("x".repeat(BUFFER_SIZES.LOG_FILE_MAX_SIZE / 2));
		writer.write(large);
		writer.write(large);
		expect(statSync(logFile).size).toBeLessThanOrEqual(
			BUFFER_SIZES.LOG_FILE_MAX_SIZE,
		);
		expect(readFileSync(logFile, "utf8")).toBe(`${JSON.stringify(large)}\n`);
	});

	test("rotates an oversized file left by an earlier process", () => {
		writeFileSync(logFile, "x".repeat(BUFFER_SIZES.LOG_FILE_MAX_SIZE + 1));
		const replacement = new LogFileWriter();
		try {
			replacement.write(event("after rotation"));
			expect(readFileSync(logFile, "utf8")).toBe(
				`${JSON.stringify(event("after rotation"))}\n`,
			);
		} finally {
			replacement.dispose();
		}
	});

	test("keeps close and dispose idempotent and supports later writes", () => {
		writer.write(event("before close"));
		writer.close();
		writer.dispose();
		writer.dispose();
		writer.write(event("after close"));
		expect(readFileSync(logFile, "utf8")).toContain("after close");
	});

	test("reports write failures without crashing the proxy", () => {
		mkdirSync(logFile);
		const stderr = spyOn(process.stderr, "write").mockImplementation(
			() => true,
		);
		try {
			expect(() => writer.write(event("cannot write"))).not.toThrow();
			expect(stderr).toHaveBeenCalledWith(
				expect.stringContaining("Failed to write log"),
			);
		} finally {
			stderr.mockRestore();
		}
	});

	test("reports read failures and returns an empty history", async () => {
		mkdirSync(logFile);
		const stderr = spyOn(process.stderr, "write").mockImplementation(
			() => true,
		);
		try {
			expect(await writer.readLogs()).toEqual([]);
			expect(stderr).toHaveBeenCalledWith(
				expect.stringContaining("Failed to read logs"),
			);
		} finally {
			stderr.mockRestore();
		}
	});
});
