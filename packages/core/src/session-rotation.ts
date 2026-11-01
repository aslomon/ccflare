import { z } from "zod";

export const SESSION_ROTATION_DEFAULTS = {
	minMs: 20 * 60_000,
	maxMs: 90 * 60_000,
};

export const sessionRotationSchema = z
	.object({
		minMs: z.number().int().min(1).max(86_400_000),
		maxMs: z.number().int().min(1).max(86_400_000),
	})
	.refine((window) => window.minMs <= window.maxMs, {
		message: "Session rotation minimum must not exceed maximum",
	});
