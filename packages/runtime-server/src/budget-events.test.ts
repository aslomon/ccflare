import { describe, expect, it } from "bun:test";
import { budgetPolicySchema, requestEvents } from "@ccflare/core";
import { BudgetRepository, DatabaseOperations } from "@ccflare/database";
import { BudgetControl } from "@ccflare/proxy";
import type { RequestSummary } from "@ccflare/types";
import { subscribeBudgetUsage } from "./budget-events";

describe("completed budget usage events", () => {
	it("consumes validated worker facts and removes its listener on disposal", () => {
		const dbOps = new DatabaseOperations(":memory:");
		const account = dbOps.createOAuthAccount({
			name: "test",
			provider: "claude-code",
			accessToken: "test",
			refreshToken: "test",
		});
		const repo = new BudgetRepository(dbOps.getDatabase());
		const control = new BudgetControl(
			dbOps,
			repo,
			budgetPolicySchema.parse({ enabled: true }),
		);
		control.observe(account, {
			observedAt: Date.now(),
			source: "claude-oauth",
			windows: [
				{
					key: "seven_day",
					usedPercent: 1,
					resetAt: Date.now() + 604_800_000,
					model: null,
				},
			],
		});
		control.reserve(account, "claude-sonnet", 1, undefined, "event-request");
		const count = requestEvents.listenerCount("event");
		const subscription = subscribeBudgetUsage(control);
		const payload: RequestSummary = {
			id: "event-request",
			timestamp: new Date().toISOString(),
			method: "POST",
			path: "/v1/messages",
			provider: "claude-code",
			upstreamPath: "/v1/messages",
			accountUsed: account.id,
			accountName: null,
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTimeMs: 10,
			failoverAttempts: 0,
			model: "claude-sonnet",
			inputTokens: 1000,
			outputTokens: 1000,
			cacheReadInputTokens: null,
			cacheCreationInputTokens: null,
			reasoningTokens: null,
			costUsd: null,
			promptTokens: 1000,
			completionTokens: 1000,
			totalTokens: 2000,
			tokensPerSecond: null,
			ttftMs: null,
			proxyOverheadMs: null,
			upstreamTtfbMs: null,
			streamingDurationMs: null,
			responseId: null,
			previousResponseId: null,
			responseChainId: null,
			clientSessionId: null,
		};
		try {
			requestEvents.emit("event", { type: "summary", payload });
			expect(repo.state(control.group(account)).actualWorkTotal).toBe(0.25);
			requestEvents.emit("event", {
				type: "summary",
				payload: { ...payload, inputTokens: -1 },
			});
			expect(repo.state(control.group(account)).actualWorkTotal).toBe(0.25);
			requestEvents.emit("event", { type: "ingress", id: "ignored" });
		} finally {
			subscription.dispose();
			dbOps.close();
		}
		expect(requestEvents.listenerCount("event")).toBe(count);
	});
});
