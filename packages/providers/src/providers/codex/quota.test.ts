import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { parseCodexQuota, readCodexQuota } from "./quota";

const now = 1_790_000_000_000;
const reset = Math.floor(now / 1000) + 604800;
const window = (duration: number, used = 10) => ({
	used_percent: used,
	limit_window_seconds: duration,
	reset_at: reset,
});
const meter = (
	primary = window(604800),
	secondary: ReturnType<typeof window> | null = null,
) => ({
	allowed: true,
	limit_reached: false,
	primary_window: primary,
	secondary_window: secondary,
});
const usage = () => ({
	plan_type: "pro",
	rate_limit: meter(),
	credits: { unlimited: true },
});
const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.signature`;
afterEach(() => mock.restore());
const response = (value: Response) =>
	spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(async () => value, {
			preconnect: globalThis.fetch.preconnect,
		}),
	);

describe("Codex subscription quota", () => {
	it("recognizes a Pro weekly primary without inventing a five-hour window or credits", () => {
		const quota = parseCodexQuota(usage(), now);
		expect(quota.source).toBe("codex-oauth");
		expect(quota.windows).toEqual([
			{ key: "seven_day", usedPercent: 10, resetAt: reset * 1000, model: null },
		]);
	});
	it("classifies Plus windows by duration rather than primary/secondary position", () => {
		const quota = parseCodexQuota(
			{ rate_limit: meter(window(18000, 25), window(604800, 42)) },
			now,
		);
		expect(quota.windows.map((w) => [w.key, w.usedPercent])).toEqual([
			["five_hour", 25],
			["seven_day", 42],
		]);
	});
	it("retains exact model scopes for separate meters without hardcoding model versions", () => {
		const quota = parseCodexQuota(
			{
				...usage(),
				additional_rate_limits: [
					{
						limit_name: "gpt-reserve",
						normal_model_slug: "gpt-example-luna",
						rate_limit: meter(window(604800, 61)),
					},
				],
			},
			now,
		);
		expect(
			quota.windows.find((w) => w.model === "gpt-example-luna")?.usedPercent,
		).toBe(61);
		expect(
			quota.windows.find((w) => w.model === "gpt-reserve")?.usedPercent,
		).toBe(61);
	});
	it("keeps a reached ordinary allowance blocked even when credits exist", () => {
		const quota = parseCodexQuota(
			{
				...usage(),
				rate_limit: { ...meter(), allowed: false, limit_reached: true },
			},
			now,
		);
		expect(quota.windows[0].usedPercent).toBe(100);
	});
	it("rejects malformed, missing, unsupported and unscoped meters", () => {
		for (const value of [
			{},
			{ rate_limit: meter(window(18000)) },
			{ rate_limit: meter(window(86400)) },
			{ rate_limit: meter(window(604800, -1)) },
			{ rate_limit: meter(window(604800, 101)) },
			{
				rate_limit: {
					...meter(),
					primary_window: { ...window(604800), reset_at: -1 },
				},
			},
			{
				...usage(),
				additional_rate_limits: [
					{ limit_name: "unknown", rate_limit: meter() },
				],
			},
			{
				...usage(),
				additional_rate_limits: new Array(33).fill({
					normal_model_slug: "gpt-one",
					limit_name: "gpt-one",
					rate_limit: meter(),
				}),
			},
		])
			expect(() => parseCodexQuota(value, now)).toThrow();
	});
	it("accepts the sanitized live response with null additional meters", () => {
		const quota = parseCodexQuota(
			{
				rate_limit: {
					allowed: true,
					limit_reached: false,
					primary_window: {
						used_percent: 0,
						limit_window_seconds: 604800,
						reset_after_seconds: 604800,
						reset_at: 1792397034,
					},
					secondary_window: null,
				},
				code_review_rate_limit: null,
				additional_rate_limits: null,
				model_usage: {
					"gpt-6-astra": {
						available: true,
						available_at: null,
						credits_would_enable: false,
					},
				},
				credits: {
					has_credits: false,
					unlimited: false,
					overage_limit_reached: false,
					balance: "0",
					approx_local_messages: [0, 0],
					approx_cloud_messages: [0, 0],
				},
				spend_control: { reached: false, individual_limit: null },
				rate_limit_reached_type: null,
				promo: null,
				rate_limit_reset_credits: {
					available_count: 1,
					applicable_available_count: 0,
				},
			},
			now,
		);
		expect(quota.windows).toEqual([
			{ key: "seven_day", usedPercent: 0, resetAt: 1792397034000, model: null },
		]);
	});
	it("skips additional meters without weekly windows", () => {
		const quota = parseCodexQuota(
			{
				...usage(),
				additional_rate_limits: [
					{
						normal_model_slug: "gpt-extra",
						limit_name: "extra",
						rate_limit: meter(window(18000, 99)),
					},
				],
			},
			now,
		);
		expect(quota.windows).toHaveLength(1);
	});
	it("merges colliding aliases using maximum usage and earliest reset", () => {
		const quota = parseCodexQuota(
			{
				...usage(),
				additional_rate_limits: [
					{
						normal_model_slug: "gpt-extra",
						limit_name: "shared",
						rate_limit: meter(),
					},
					{
						normal_model_slug: "shared",
						limit_name: "shared",
						rate_limit: meter(
							{ ...window(604800, 70), reset_at: reset - 100 },
							window(604800, 80),
						),
					},
				],
			},
			now,
		);
		expect(quota.windows.find((w) => w.model === "shared")).toEqual({
			key: "seven_day_shared",
			model: "shared",
			usedPercent: 80,
			resetAt: (reset - 100) * 1000,
		});
	});
	it("merges repeated ordinary windows conservatively", () => {
		const quota = parseCodexQuota(
			{
				rate_limit: meter(window(604800, 20), {
					...window(604800, 60),
					reset_at: reset - 1,
				}),
			},
			now,
		);
		expect(quota.windows).toEqual([
			{
				key: "seven_day",
				model: null,
				usedPercent: 60,
				resetAt: (reset - 1) * 1000,
			},
		]);
	});
	it("returns stable redacted parser codes and requires ordinary weekly quota", () => {
		expect(() =>
			parseCodexQuota({ rate_limit: meter(window(18000)) }, now),
		).toThrow("usage_parse_weekly_missing");
		expect(() =>
			parseCodexQuota({ rate_limit: "private upstream value" }, now),
		).toThrow("usage_parse_invalid");
		expect(() => parseCodexQuota(usage(), -1)).toThrow(
			"usage_parse_snapshot_invalid",
		);
	});
	it("uses only the trusted usage origin and selected account identity", async () => {
		const request = response(Response.json(usage()));
		const quota = await readCodexQuota(token);
		expect(quota.source).toBe("codex-oauth");
		const [url, init] = request.mock.calls[0];
		expect(url).toBe("https://chatgpt.com/backend-api/wham/usage");
		expect(init?.redirect).toBe("error");
		const headers = new Headers(init?.headers);
		expect(headers.get("Authorization")).toBe(`Bearer ${token}`);
		expect(headers.get("ChatGPT-Account-Id")).toBe("test-account");
	});
	it("redacts upstream failures and bounds the response body", async () => {
		const request = response(new Response("private failure", { status: 401 }));
		await expect(readCodexQuota(token)).rejects.toThrow("usage_http_401");
		request.mockRestore();
		response(new Response("x".repeat(65537)));
		await expect(readCodexQuota(token)).rejects.toThrow("usage_too_large");
	});
});
