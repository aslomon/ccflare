import { requestEvents } from "@ccflare/core";
import { Logger } from "@ccflare/logger";
import type { BudgetControl } from "@ccflare/proxy";
import { isRequestStreamEvent } from "@ccflare/types";

const log = new Logger("BudgetUsage");
export function subscribeBudgetUsage(control: BudgetControl): {
	dispose(): void;
} {
	const receive = (value: unknown): void => {
		if (
			!control.enabled ||
			!isRequestStreamEvent(value) ||
			value.type !== "summary"
		)
			return;
		const usage = value.payload;
		if (!usage.accountUsed) return;
		try {
			control.recordUsage({
				requestId: usage.id,
				accountId: usage.accountUsed,
				model: usage.model,
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				cacheReadInputTokens: usage.cacheReadInputTokens,
				cacheCreationInputTokens: usage.cacheCreationInputTokens,
				reasoningTokens: usage.reasoningTokens,
				costUsd: usage.costUsd,
			});
		} catch {
			log.error(
				"Completed usage could not be reconciled; conservative reservation retained",
			);
		}
	};
	requestEvents.on("event", receive);
	return {
		dispose: () => {
			requestEvents.off("event", receive);
		},
	};
}
