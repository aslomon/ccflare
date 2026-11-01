import type { Account, BudgetRouting } from "@ccflare/types";
import { isRecord } from "@ccflare/types";
import { reserveBudgetRequest } from "./request";

export interface WebSocketBudgetState {
	budgetReservation?: string | null;
	budgetRenewal?: ReturnType<typeof setInterval> | null;
	budgetSending?: Promise<void>;
}
export function finishWebSocketBudget(
	state: WebSocketBudgetState,
	budget: BudgetRouting | undefined,
): void {
	if (state.budgetRenewal) clearInterval(state.budgetRenewal);
	if (state.budgetReservation) budget?.finish(state.budgetReservation);
	state.budgetReservation = null;
	state.budgetRenewal = null;
}
export async function authorizeWebSocketFrame(
	state: WebSocketBudgetState,
	budget: BudgetRouting | undefined,
	account: Account | null,
	frame: string | Uint8Array | ArrayBuffer,
): Promise<void> {
	if (!budget?.enabled) return;
	if (!account) throw new Error("Budget-managed websocket requires an account");
	const text =
		typeof frame === "string" ? frame : new TextDecoder().decode(frame);
	if (text.length > 16 * 1024 * 1024)
		throw new Error("Websocket frame exceeds budget bound");
	const parsed: unknown = JSON.parse(text);
	if (!isRecord(parsed)) throw new Error("Invalid websocket frame");
	if (parsed.type !== "response.create") {
		if (!state.budgetReservation)
			throw new Error("A budget reservation is required before sending frames");
		return;
	}
	if (state.budgetReservation)
		throw new Error("A budget-managed websocket turn is already in flight");
	const body = isRecord(parsed.response) ? parsed.response : parsed;
	const buffer = new TextEncoder().encode(JSON.stringify(body)).buffer;
	const id = await reserveBudgetRequest(budget, account, buffer);
	if (!id) throw new Error("Websocket account budget unavailable");
	state.budgetReservation = id;
	state.budgetRenewal = setInterval(() => budget.renew(id), 60_000);
	state.budgetRenewal.unref();
}
