import type { StartMessage } from "./worker-messages";

export function calculateStreamSpeed(
	outputTokens: number,
	firstTokenAt: number | undefined,
	lastTokenAt: number | undefined,
): number | null {
	if (
		outputTokens <= 0 ||
		firstTokenAt === undefined ||
		lastTokenAt === undefined
	)
		return null;
	const durationMs = lastTokenAt - firstTokenAt;
	if (durationMs <= 0) return null;
	const speed = (outputTokens * 1000) / durationMs;
	return Number.isFinite(speed) ? speed : null;
}

function durationBetween(
	start: number | undefined,
	end: number | undefined,
): number | null {
	return start === undefined || end === undefined
		? null
		: Math.max(0, end - start);
}

export function calculateRequestTimings(
	start: Pick<
		StartMessage,
		"timestamp" | "upstreamRequestStartedAt" | "responseHeadersReceivedAt"
	>,
	completedAt: number | undefined,
	outputTokens: number,
	firstTokenAt?: number,
	lastTokenAt?: number,
) {
	return {
		outputTokensPerSecond: calculateStreamSpeed(
			outputTokens,
			start.upstreamRequestStartedAt,
			completedAt,
		),
		ttftMs: durationBetween(start.timestamp, firstTokenAt),
		proxyOverheadMs: durationBetween(
			start.timestamp,
			start.upstreamRequestStartedAt,
		),
		upstreamTtfbMs: durationBetween(
			start.upstreamRequestStartedAt,
			start.responseHeadersReceivedAt,
		),
		streamingDurationMs: durationBetween(firstTokenAt, lastTokenAt),
	};
}
