import { z } from "zod";
import { quotaSnapshotSchema } from "./budget-schemas";

export const budgetHistoryFactSchema = z
	.object({
		kind: z.enum(["quota", "selection", "denied", "failure"]),
		observedAt: z.number().int().positive(),
		accountId: z.string().min(1).max(100),
		groupId: z.string().min(1).max(300),
		model: z.string().min(1).max(100).nullable(),
		reason: z.string().min(1).max(100),
		quota: quotaSnapshotSchema.nullable(),
		reservedPercent: z.number().finite().nonnegative(),
		actualWorkTotal: z.number().finite().nonnegative(),
		balancePercent: z.number().finite(),
		ratePercentPerHour: z.number().finite().nonnegative(),
		deadline: z.number().finite().nonnegative().nullable(),
	})
	.strict();
export const budgetHistoryQuerySchema = z
	.object({
		accountId: z.string().min(1).max(100).optional(),
		before: z.coerce.number().int().positive().optional(),
		limit: z.coerce.number().int().min(1).max(200).default(100),
	})
	.strict();
