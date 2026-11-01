import { z } from "zod";

const nonnegative = z.number().finite().nonnegative();
export const budgetWindowLearningSchema = z
	.object({
		resetAt: z.number().int().positive().nullable(),
		observedAt: nonnegative,
		usedPercent: nonnegative,
		workCursor: nonnegative,
		costPerWork: z.number().finite().positive(),
		samples: z.number().int().nonnegative(),
		lastSampleAt: nonnegative,
		unattributedPercent: nonnegative,
	})
	.strict();
export const budgetWorkModelSchema = z
	.object({
		ratio: z.number().finite().positive(),
		upperRatio: z.number().finite().positive(),
		samples: z.number().int().nonnegative(),
		lastSampleAt: nonnegative,
	})
	.strict();
export const budgetPacingSchema = z
	.object({
		updatedAt: nonnegative,
		balancePercent: z.number().finite(),
		ratePercentPerHour: nonnegative,
		pendingPercent: nonnegative.default(0),
		observedPercent: nonnegative.default(0),
	})
	.strict();
const tokens = z.number().finite().min(0).max(1_000_000_000).nullable();
export const budgetUsageSchema = z
	.object({
		requestId: z.string().min(1).max(100),
		accountId: z.string().min(1).max(100),
		model: z.string().min(1).max(100).nullable(),
		inputTokens: tokens,
		outputTokens: tokens,
		cacheReadInputTokens: tokens,
		cacheCreationInputTokens: tokens,
		reasoningTokens: tokens,
		costUsd: z.number().finite().nonnegative().nullable(),
	})
	.strict();
