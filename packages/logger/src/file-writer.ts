import {
	appendFileSync,
	existsSync,
	mkdirSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BUFFER_SIZES,
	type Disposable,
	LIMITS,
	registerDisposable,
} from "@ccflare/core";
import { isLogEvent, type LogEvent } from "@ccflare/types";

function writeToStderr(message: string, error: unknown): void {
	if (typeof process === "undefined") {
		return;
	}

	const formattedError =
		error instanceof Error ? (error.stack ?? error.message) : String(error);
	process.stderr?.write?.(`${message}: ${formattedError}\n`);
}

export class LogFileWriter implements Disposable {
	private readonly logFile: string;
	private readonly maxFileSize = BUFFER_SIZES.LOG_FILE_MAX_SIZE;

	constructor() {
		// Create log directory in tmp folder
		const logDir = join(tmpdir(), "ccflare-logs");
		if (!existsSync(logDir)) {
			mkdirSync(logDir, { recursive: true });
		}

		this.logFile = join(logDir, "app.log");
		// Check if we need to rotate
		if (existsSync(this.logFile)) {
			const stats = statSync(this.logFile);
			if (stats.size > this.maxFileSize) {
				this.rotateLog();
			}
		}
	}

	private rotateLog(): void {
		if (existsSync(this.logFile)) {
			try {
				unlinkSync(this.logFile);
			} catch (_e) {
				writeToStderr("Failed to rotate log", _e);
			}
		}
	}

	write(event: LogEvent): void {
		try {
			const line = `${JSON.stringify(event)}\n`;
			const size = statSync(this.logFile, { throwIfNoEntry: false })?.size ?? 0;
			if (size + Buffer.byteLength(line) > this.maxFileSize) {
				this.rotateLog();
			}

			// Worker termination cannot clean up a persistent Node write stream.
			// Append synchronously so no descriptor or queued writes outlive the call.
			appendFileSync(this.logFile, line, "utf8");
		} catch (error) {
			writeToStderr("Failed to write log", error);
		}
	}

	async readLogs(limit: number = LIMITS.LOG_READ_DEFAULT): Promise<LogEvent[]> {
		if (!existsSync(this.logFile)) {
			return [];
		}

		try {
			const content = await Bun.file(this.logFile).text();
			const lines = content.trim().split("\n").filter(Boolean);

			// Return the last N logs
			return lines
				.slice(-limit)
				.map((line) => {
					try {
						const value: unknown = JSON.parse(line);
						return isLogEvent(value) ? value : null;
					} catch {
						return null;
					}
				})
				.filter((log): log is LogEvent => log !== null);
		} catch (_e) {
			writeToStderr("Failed to read logs", _e);
			return [];
		}
	}

	close(): void {
		// Each append is already complete and closed when write() returns.
	}

	dispose(): void {
		this.close();
	}
}

// Singleton instance
export const logFileWriter = new LogFileWriter();

// Register with lifecycle manager
registerDisposable(logFileWriter);
