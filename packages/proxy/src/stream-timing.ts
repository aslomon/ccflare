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
