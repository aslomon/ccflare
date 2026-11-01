import type {
	BudgetPolicy,
	BudgetProfile,
	BudgetState,
	QuotaSnapshot,
} from "@ccflare/types";
import { z } from "zod";
import {
	budgetPacingSchema,
	budgetWindowLearningSchema,
	budgetWorkModelSchema,
} from "./budget-learning-schemas";

export const budgetPolicySchema: z.ZodType<
	BudgetPolicy,
	z.ZodTypeDef,
	unknown
> = z
	.object({
		enabled: z.boolean().default(false),
		cutoffPercent: z.number().finite().min(85).max(90).default(85),
		headroomPercent: z.number().finite().min(0.5).max(10).default(1),
		shortWindowCutoffPercent: z.number().finite().min(50).max(95).default(90),
		pollMs: z.number().int().min(60_000).max(900_000).default(300_000),
		maxAgeMs: z.number().int().min(120_000).max(1_800_000).default(900_000),
		reservationMs: z
			.number()
			.int()
			.min(300_000)
			.max(3_600_000)
			.default(1_800_000),
		minSessionMs: z
			.number()
			.int()
			.min(1_200_000)
			.max(5_400_000)
			.default(1_200_000),
		maxSessionMs: z
			.number()
			.int()
			.min(1_200_000)
			.max(5_400_000)
			.default(5_400_000),
	})
	.strict()
	.refine(
		(p) => p.maxSessionMs >= p.minSessionMs && p.maxAgeMs >= p.pollMs,
		"Invalid time bounds",
	);

export const budgetProfileSchema: z.ZodType<
	BudgetProfile,
	z.ZodTypeDef,
	unknown
> = z
	.object({
		mode: z
			.enum(["auto", "claude", "codex", "zai", "grok", "money", "local"])
			.default("auto"),
		groupId: z
			.string()
			.min(1)
			.max(100)
			.regex(/^[a-zA-Z0-9_.-]+$/)
			.nullable()
			.default(null),
		models: z.array(z.string().min(1).max(100)).max(100).default([]),
		weeklyUsd: z
			.number()
			.finite()
			.positive()
			.max(100_000)
			.nullable()
			.default(null),
		weekAnchor: z.number().int().positive().nullable().default(null),
	})
	.strict()
	.refine(
		(p) =>
			p.mode !== "money" || (p.weeklyUsd !== null && p.weekAnchor !== null),
		"Money budgets require weeklyUsd and weekAnchor",
	);

export const quotaSnapshotSchema: z.ZodType<QuotaSnapshot> = z
	.object({
		observedAt: z.number().int().positive(),
		source: z.enum([
			"claude-oauth",
			"codex-oauth",
			"zai-coding",
			"grok-build",
			"local-cost",
		]),
		windows: z
			.array(
				z
					.object({
						key: z.string().min(1).max(64),
						usedPercent: z.number().finite().min(0).max(10_000),
						resetAt: z.number().int().positive().nullable(),
						model: z.string().min(1).max(100).nullable(),
					})
					.strict(),
			)
			.min(1)
			.max(32),
	})
	.strict();

export const budgetStateSchema: z.ZodType<BudgetState, z.ZodTypeDef, unknown> =
	z
		.object({
			quota: quotaSnapshotSchema.nullable(),
			error: z.string().max(100).nullable(),
			nextCheckAt: z.number().finite().nonnegative(),
			failures: z.number().int().nonnegative(),
			workTotal: z.number().finite().nonnegative(),
			observedWork: z.number().finite().nonnegative(),
			weeklyCostPerWork: z.number().finite().positive(),
			shortCostPerWork: z.number().finite().positive(),
			weeklyBlockedReset: z.number().int().positive().nullable(),
			learnedSamples: z.number().int().nonnegative(),
			weeklyBurnPerHour: z.number().finite().nonnegative(),
			burnSampleDurationMs: z.number().finite().nonnegative().default(0),
			burnObservedAt: z.number().finite().nonnegative(),
			burnObservedPercent: z.number().finite().nonnegative(),
			actualWorkTotal: z.number().finite().nonnegative().default(0),
			modelWorkTotal: z.record(z.number().finite().nonnegative()).default({}),
			windowLearning: z.record(budgetWindowLearningSchema).default({}),
			workModels: z.record(budgetWorkModelSchema).default({}),
			pacing: budgetPacingSchema.default({
				updatedAt: 0,
				balancePercent: 0,
				ratePercentPerHour: 0,
				pendingPercent: 0,
				observedPercent: 0,
			}),
			trackingStartedAt: z.number().finite().nonnegative().default(0),
		})
		.strict();

export const budgetSessionSchema = z
	.object({
		accountId: z.string(),
		deadline: z.number(),
		credits: z.record(z.number().finite()),
		startedAt: z.number().finite().nonnegative().default(0),
		reason: z.string().max(100).default("legacy_session"),
		lastSelectedAt: z.record(z.number().finite().nonnegative()).default({}),
	})
	.strict();
