import { NETWORK, TIME_CONSTANTS } from "@ccflare/core";
import type { SessionRotationWindow } from "@ccflare/types";
import type { ConfigData, RuntimeConfig } from "./index";

function runtimeNumber(
	configured: number | undefined,
	environment: string | undefined,
	fallback: number,
): number {
	if (typeof configured === "number") return configured;
	if (environment === undefined) return fallback;
	const parsed = Number(environment);
	return Number.isFinite(parsed) ? parsed : fallback;
}

export function buildRuntimeConfig(
	data: ConfigData,
	rotation?: SessionRotationWindow,
): RuntimeConfig {
	return {
		clientId:
			data.client_id ||
			process.env.CLIENT_ID ||
			"9d1c250a-e61b-44d9-88ed-5944d1962f5e",
		retry: {
			attempts: runtimeNumber(
				data.retry_attempts,
				process.env.RETRY_ATTEMPTS,
				3,
			),
			delayMs: runtimeNumber(
				data.retry_delay_ms,
				process.env.RETRY_DELAY_MS,
				TIME_CONSTANTS.RETRY_DELAY_DEFAULT,
			),
			backoff: runtimeNumber(data.retry_backoff, process.env.RETRY_BACKOFF, 2),
		},
		sessionDurationMs: runtimeNumber(
			data.session_duration_ms,
			process.env.SESSION_DURATION_MS,
			TIME_CONSTANTS.SESSION_DURATION_DEFAULT,
		),
		sessionRotation: rotation,
		port: runtimeNumber(data.port, process.env.PORT, NETWORK.DEFAULT_PORT),
	};
}
