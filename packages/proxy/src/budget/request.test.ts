import { describe, expect, it } from "bun:test";
import { budgetPolicySchema, readBoundedBody } from "@ccflare/core";
import { BudgetRepository, DatabaseOperations } from "@ccflare/database";
import { BudgetControl } from "./control";
import {
	budgetRequestInfo,
	holdBudgetResponse,
	reserveBudgetRequest,
} from "./request";
import {
	authorizeWebSocketFrame,
	finishWebSocketBudget,
	type WebSocketBudgetState,
} from "./websocket";

function setup() {
	const db = new DatabaseOperations(":memory:");
	const account = db.createOAuthAccount({
		name: "test",
		provider: "claude-code",
		accessToken: "test",
		refreshToken: "test",
	});
	const repo = new BudgetRepository(db.getDatabase());
	const control = new BudgetControl(
		db,
		repo,
		budgetPolicySchema.parse({ enabled: true }),
	);
	control.observe(account, {
		source: "claude-oauth",
		observedAt: Date.now(),
		windows: [
			{
				key: "seven_day",
				usedPercent: 10,
				resetAt: Date.now() + 86_400_000,
				model: null,
			},
		],
	});
	return { db, account, repo, control };
}
const body = () =>
	new TextEncoder().encode(
		JSON.stringify({ model: "claude-sonnet", max_tokens: 10 }),
	).buffer;
describe("budget enforcement at transport boundaries", () => {
	it("bounds streamed bodies before allocating oversized requests", async () => {
		let cancelled = false;
		const stream = new ReadableStream({
			start(c) {
				c.enqueue(new Uint8Array(20));
			},
			cancel() {
				cancelled = true;
			},
		});
		await expect(
			readBoundedBody(
				new Request("http://local", { method: "POST", body: stream }),
				10,
			),
		).rejects.toThrow("exceeds");
		expect(cancelled).toBe(true);
		expect(await readBoundedBody(new Request("http://local"), 10)).toBeNull();
	});
	it("rejects malformed budget bodies and keeps a conservative output bound", () => {
		expect(() =>
			budgetRequestInfo(new TextEncoder().encode('{"max_tokens":-1}').buffer),
		).toThrow();
		expect(
			budgetRequestInfo(new TextEncoder().encode("{}").buffer).work,
		).toBeGreaterThan(3);
	});
	it("keeps completed stream reservations until a later quota observation", async () => {
		const { db, account, repo, control } = setup();
		const id = await reserveBudgetRequest(control, account, body());
		if (!id) throw new Error("No reservation");
		const response = holdBudgetResponse(new Response("done"), control, id);
		expect(await response.text()).toBe("done");
		expect(
			repo.reservedPercent(control.group(account), Date.now()),
		).toBeGreaterThan(0);
		db.close();
	});
	it("finishes cancelled streams and releases their renewal timers", async () => {
		const { db, account, control } = setup();
		const id = control.reserve(account, "claude-sonnet", 1);
		if (!id) throw new Error("No reservation");
		const response = holdBudgetResponse(
			new Response(new ReadableStream()),
			control,
			id,
		);
		await response.body?.cancel();
		const row = db
			.getDatabase()
			.query<{ finished_at: number | null }, [string]>(
				"SELECT finished_at FROM budget_reservations WHERE id=?",
			)
			.get(id);
		expect(row?.finished_at).toBeNumber();
		db.close();
	});
	it("reserves each websocket turn and rejects overlapping or unreserved work", async () => {
		const { db, account, control } = setup();
		const state: WebSocketBudgetState = {};
		await expect(
			authorizeWebSocketFrame(
				state,
				control,
				account,
				'{"type":"input_audio_buffer.append"}',
			),
		).rejects.toThrow("reservation");
		await authorizeWebSocketFrame(
			state,
			control,
			account,
			'{"type":"response.create","response":{"model":"claude-sonnet","max_output_tokens":10}}',
		);
		expect(state.budgetReservation).toBeString();
		await expect(
			authorizeWebSocketFrame(
				state,
				control,
				account,
				'{"type":"response.create"}',
			),
		).rejects.toThrow("in flight");
		finishWebSocketBudget(state, control);
		expect(state.budgetReservation).toBeNull();
		db.pauseAccount(account.id);
		await expect(
			authorizeWebSocketFrame(
				state,
				control,
				account,
				'{"type":"response.create","model":"claude-sonnet"}',
			),
		).rejects.toThrow("unavailable");
		db.close();
	});
});
