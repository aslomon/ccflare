import { afterEach, describe, expect, it } from "bun:test";
import { runStartupMaintenance } from "./startup-maintenance";

const originalCleanupOnStartup = process.env.CCFLARE_CLEANUP_ON_STARTUP;
const originalCompactOnStartup = process.env.ccflare_COMPACT_ON_STARTUP;

function restoreEnvironment(): void {
	if (originalCleanupOnStartup === undefined) {
		delete process.env.CCFLARE_CLEANUP_ON_STARTUP;
	} else {
		process.env.CCFLARE_CLEANUP_ON_STARTUP = originalCleanupOnStartup;
	}

	if (originalCompactOnStartup === undefined) {
		delete process.env.ccflare_COMPACT_ON_STARTUP;
	} else {
		process.env.ccflare_COMPACT_ON_STARTUP = originalCompactOnStartup;
	}
}

afterEach(restoreEnvironment);

describe("startup maintenance", () => {
	it("does not block startup with cleanup or compaction by default", () => {
		delete process.env.CCFLARE_CLEANUP_ON_STARTUP;
		process.env.ccflare_COMPACT_ON_STARTUP = "1";
		let cleanupCalls = 0;
		let compactCalls = 0;
		const config = {
			getDataRetentionDays: () => 1,
			getRequestRetentionDays: () => 7,
		};
		const database = {
			cleanupOldRequests: () => {
				cleanupCalls += 1;
				return { removedRequests: 0, removedPayloads: 0 };
			},
			compact: () => {
				compactCalls += 1;
			},
		};

		runStartupMaintenance(config, database);

		expect(cleanupCalls).toBe(0);
		expect(compactCalls).toBe(0);
	});

	it("schedules explicit startup cleanup after the listener can start", () => {
		process.env.CCFLARE_CLEANUP_ON_STARTUP = "1";
		let cleanupCalls = 0;
		let scheduledTask: (() => void) | undefined;
		const config = {
			getDataRetentionDays: () => 1,
			getRequestRetentionDays: () => 7,
		};
		const database = {
			cleanupOldRequests: () => {
				cleanupCalls += 1;
				return { removedRequests: 2, removedPayloads: 3 };
			},
			compact: () => undefined,
		};
		const schedule = (task: () => void): (() => void) => {
			scheduledTask = task;
			return () => {
				scheduledTask = undefined;
			};
		};

		const stop = runStartupMaintenance(config, database, schedule);

		expect(cleanupCalls).toBe(0);
		expect(scheduledTask).toBeDefined();
		scheduledTask?.();
		expect(cleanupCalls).toBe(1);
		stop();
		expect(scheduledTask).toBeUndefined();
	});
});
