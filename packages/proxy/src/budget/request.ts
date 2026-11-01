import { estimateCostResult } from "@ccflare/core";
import type { Account, BudgetRouting } from "@ccflare/types";
import { z } from "zod";

const requestSchema = z
	.object({
		model: z.string().min(1).max(100).optional(),
		max_tokens: z.number().int().positive().max(1_000_000).optional(),
		max_output_tokens: z.number().int().positive().max(1_000_000).optional(),
		max_completion_tokens: z
			.number()
			.int()
			.positive()
			.max(1_000_000)
			.optional(),
	})
	.passthrough();
export function budgetRequestInfo(buffer: ArrayBuffer | null) {
	if (!buffer)
		return { model: null, work: 1, inputTokens: 0, outputTokens: 16384 };
	if (buffer.byteLength > 16 * 1024 * 1024)
		throw new Error("Budget-managed request exceeds 16 MiB");
	const input = requestSchema.parse(
		JSON.parse(new TextDecoder().decode(buffer)),
	);
	const outputTokens =
		input.max_tokens ??
		input.max_output_tokens ??
		input.max_completion_tokens ??
		16384;
	const inputTokens = Math.ceil(buffer.byteLength / 3);
	return {
		model: input.model ?? null,
		inputTokens,
		outputTokens,
		work: Math.max(1, (inputTokens + outputTokens * 4) / 20_000),
	};
}
export async function reserveBudgetRequest(
	budget: BudgetRouting | undefined,
	account: Account,
	buffer: ArrayBuffer | null,
	requestId?: string,
): Promise<string | null> {
	if (!budget?.enabled) return "unmanaged";
	const info = budgetRequestInfo(buffer);
	const view = budget.view(account, info.model);
	if (view.profile.mode === "local") return view.eligible ? "unmanaged" : null;
	let percent: number | undefined;
	if (view.profile.mode === "money") {
		if (!info.model || !view.profile.weeklyUsd) return null;
		const price = await estimateCostResult(info.model, {
			inputTokens: info.inputTokens,
			outputTokens: info.outputTokens,
		});
		if (price.costUsd === null) return null;
		percent = (price.costUsd / view.profile.weeklyUsd) * 100;
	}
	return budget.reserve(account, info.model, info.work, percent, requestId);
}
function reservationLease(budget: BudgetRouting, id: string): () => void {
	const timer = setInterval(() => budget.renew(id), 60_000);
	timer.unref();
	let finished = false;
	return () => {
		if (!finished) {
			finished = true;
			clearInterval(timer);
			budget.finish(id);
		}
	};
}

export function holdBudgetResponse(
	response: Response,
	budget: BudgetRouting | undefined,
	id: string,
): Response {
	if (!budget?.enabled || id === "unmanaged") return response;
	const finish = reservationLease(budget, id);
	const reader = response.body?.getReader();
	if (!reader) {
		finish();
		return response;
	}
	return new Response(reservedStream(reader, finish), {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

function reservedStream(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	finish: () => void,
): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const chunk = await reader.read();
				if (chunk.done) {
					finish();
					reader.releaseLock();
					controller.close();
				} else controller.enqueue(chunk.value);
			} catch (error) {
				finish();
				controller.error(error);
			}
		},
		async cancel(reason) {
			try {
				await reader.cancel(reason);
			} finally {
				finish();
				reader.releaseLock();
			}
		},
	});
}
export function budgetUnavailable(): Response {
	return Response.json(
		{
			error: {
				type: "budget_unavailable",
				message:
					"No eligible account: quota, telemetry, or model availability blocks this request.",
			},
		},
		{ status: 503, headers: { "Retry-After": "60" } },
	);
}
