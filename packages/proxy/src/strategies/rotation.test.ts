import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	setSystemTime,
} from "bun:test";
import type {
	Account,
	AccountProvider,
	RequestMeta,
	StrategyStore,
} from "@ccflare/types";
import { SessionStrategy } from "./index";

const minute = 60_000;
const start = 1_800_000_000_000;
const request: RequestMeta = {
	id: "rotation-test",
	method: "POST",
	path: "/v1/claude-code/v1/messages",
	timestamp: start,
};

function account(
	id: string,
	createdAt: number,
	provider: AccountProvider = "claude-code",
): Account {
	return {
		id,
		name: id,
		provider,
		created_at: createdAt,
		auth_method: "oauth",
		base_url: null,
		api_key: null,
		refresh_token: null,
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		weight: 1,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
	};
}

function fixture() {
	const accounts = [
		account("a", 1),
		account("b", 2),
		account("c", 3),
		account("d", 4),
	];
	const store: StrategyStore = {
		getAccountsByProvider(provider) {
			return accounts.filter((entry) => entry.provider === provider);
		},
		resetAccountSession(id, timestamp) {
			const entry = accounts.find((candidate) => candidate.id === id);
			if (entry) {
				entry.session_start = timestamp;
				entry.session_request_count = 0;
			}
		},
	};
	const strategy = new SessionStrategy(5 * 60 * minute, {
		minMs: 20 * minute,
		maxMs: 90 * minute,
	});
	strategy.initialize(store);
	return { accounts, store, strategy };
}

beforeEach(() => setSystemTime(start));
afterEach(() => setSystemTime());

describe("session rotation", () => {
	it("keeps a session for at least 20 minutes and rotates by 90 minutes", () => {
		const { accounts, strategy } = fixture();
		expect(strategy.select(accounts, request)[0]?.id).toBe("a");
		setSystemTime(start + 20 * minute - 1);
		expect(strategy.select([...accounts].reverse(), request)[0]?.id).toBe("a");
		setSystemTime(start + 90 * minute);
		expect(strategy.select(accounts, request)[0]?.id).toBe("b");
	});

	it("visits every available account before wrapping around", () => {
		const { accounts, strategy } = fixture();
		const selected: Array<string | undefined> = [];
		for (let index = 0; index < 5; index++) {
			setSystemTime(start + index * 90 * minute);
			selected.push(strategy.select([...accounts].reverse(), request)[0]?.id);
		}
		expect(selected).toEqual(["a", "b", "c", "d", "a"]);
	});

	it("uses varying windows rather than always waiting 90 minutes", () => {
		const { accounts, strategy } = fixture();
		const transitions: number[] = [];
		let previous = strategy.select(accounts, request)[0]?.id;
		let lastTransition = start;
		for (let elapsed = 1; elapsed <= 600; elapsed++) {
			const now = start + elapsed * minute;
			setSystemTime(now);
			const selected = strategy.select(accounts, request)[0]?.id;
			if (selected !== previous) {
				transitions.push((now - lastTransition) / minute);
				previous = selected;
				lastTransition = now;
			}
		}
		expect(transitions.length).toBeGreaterThan(5);
		expect(
			transitions.every((duration) => duration >= 20 && duration <= 90),
		).toBe(true);
		expect(new Set(transitions).size).toBeGreaterThan(1);
	});

	it("preserves the deadline across a strategy restart", () => {
		const { accounts, strategy, store } = fixture();
		const control = fixture();
		strategy.select(accounts, request);
		control.strategy.select(control.accounts, request);
		setSystemTime(start + 19 * minute);
		const restarted = new SessionStrategy(5 * 60 * minute, {
			minMs: 20 * minute,
			maxMs: 90 * minute,
		});
		restarted.initialize(store);
		expect(restarted.select(accounts, request)[0]?.id).toBe("a");
		for (let elapsed = 20; elapsed <= 90; elapsed++) {
			setSystemTime(start + elapsed * minute);
			const original = control.strategy.select(control.accounts, request)[0]
				?.id;
			expect(restarted.select(accounts, request)[0]?.id).toBe(original);
		}
		expect(accounts[1]?.session_start).not.toBeNull();
	});

	it("skips paused and blocked accounts even when they are missing from query results", () => {
		const { accounts, strategy } = fixture();
		strategy.select(accounts, request);
		const first = accounts[0];
		const second = accounts[1];
		if (!first || !second) throw new Error("Missing fixture accounts");
		first.paused = true;
		second.rate_limited_until = start + 120 * minute;
		setSystemTime(start + minute);
		expect(
			strategy.select(accounts.slice(2), request).map((entry) => entry.id),
		).toEqual(["c", "d"]);
	});

	it("resets a returning account's session and retains ordered failover candidates", () => {
		const { accounts, strategy } = fixture();
		for (let index = 0; index <= 4; index++) {
			setSystemTime(start + index * 90 * minute);
			strategy.select(accounts, request);
		}
		expect(accounts[0]?.session_start).toBe(start + 360 * minute);
		expect(strategy.select(accounts, request).map((entry) => entry.id)).toEqual(
			["a", "b", "c", "d"],
		);
	});

	it("does not mix provider sessions", () => {
		const { accounts, strategy } = fixture();
		const other = account("other", 0, "openai");
		other.session_start = start + minute;
		accounts.push(other);
		expect(
			strategy.select(
				accounts.filter((entry) => entry.provider === "claude-code"),
				request,
			)[0]?.id,
		).toBe("a");
		expect(strategy.select([other], request)[0]?.id).toBe("other");
	});

	it("handles an empty pool and renews a single available account", () => {
		const { accounts, strategy } = fixture();
		expect(strategy.select([], request)).toEqual([]);
		strategy.select(accounts.slice(0, 1), request);
		setSystemTime(start + 90 * minute);
		expect(strategy.select(accounts.slice(0, 1), request)[0]?.id).toBe("a");
		expect(accounts[0]?.session_start).toBe(start + 90 * minute);
	});

	it("keeps legacy sticky selection when rotation is disabled", () => {
		const { accounts, store } = fixture();
		const strategy = new SessionStrategy(5 * 60 * minute);
		strategy.initialize(store);
		strategy.select(accounts, request);
		setSystemTime(start + 90 * minute);
		expect(strategy.select(accounts, request)[0]?.id).toBe("a");
	});
});
