import { Logger } from "@ccflare/logger";
import { z } from "zod";

const STARTUP_CLEANUP_DELAY_MS = 60_000;
const startupCleanupSchema = z.enum(["0", "1"]).catch("0");

type MaintenanceConfig = {
	getDataRetentionDays: () => number;
	getRequestRetentionDays: () => number;
};

type MaintenanceDatabase = {
	cleanupOldRequests: (
		payloadRetentionMs: number,
		requestRetentionMs: number,
	) => { removedRequests: number; removedPayloads: number };
};

export type StartupMaintenanceScheduler = (task: () => void) => () => void;

function scheduleAfterStartup(task: () => void): () => void {
	const timer = setTimeout(task, STARTUP_CLEANUP_DELAY_MS);
	timer.unref();
	return () => clearTimeout(timer);
}

function cleanExpiredRows(
	config: MaintenanceConfig,
	database: MaintenanceDatabase,
	log: Logger,
): void {
	try {
		const payloadMs = config.getDataRetentionDays() * 86_400_000;
		const requestMs = config.getRequestRetentionDays() * 86_400_000;
		const result = database.cleanupOldRequests(payloadMs, requestMs);
		log.info(
			`Deferred cleanup removed ${result.removedRequests} requests and ${result.removedPayloads} payloads`,
		);
	} catch (error) {
		log.error("Deferred startup cleanup failed", error);
	}
}

export function runStartupMaintenance(
	config: MaintenanceConfig,
	database: MaintenanceDatabase,
	schedule: StartupMaintenanceScheduler = scheduleAfterStartup,
): () => void {
	const enabled = startupCleanupSchema.parse(
		process.env.CCFLARE_CLEANUP_ON_STARTUP,
	);
	if (enabled !== "1") return () => undefined;

	const log = new Logger("StartupMaintenance");
	return schedule(() => cleanExpiredRows(config, database, log));
}
