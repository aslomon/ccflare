import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { parseClaudeQuota, parseZaiQuota, readProviderQuota } from "./quota";

const now = 1_790_000_000_000;
afterEach(() => mock.restore());
function mockQuotaResponse(response: Response) {
	return spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(async () => response, {
			preconnect: globalThis.fetch.preconnect,
		}),
	);
}
describe("quota HTTP boundary", () => {
	it("uses the trusted Claude origin and protected headers without redirects", async () => {
		const request = mockQuotaResponse(
			Response.json({
				seven_day: {
					utilization: 10,
					resets_at: new Date(now + 10000).toISOString(),
				},
			}),
		);
		const quota = await readProviderQuota("claude", "test-token");
		expect(quota.source).toBe("claude-oauth");
		const [url, options] = request.mock.calls[0];
		expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
		expect(new Headers(options?.headers).get("Authorization")).toBe(
			"Bearer test-token",
		);
		expect(options?.redirect).toBe("error");
	});
	it("uses the raw Z.ai key only on the monitoring endpoint", async () => {
		const request = mockQuotaResponse(
			Response.json({
				success: true,
				code: 200,
				data: {
					limits: [
						{
							type: "CREDIT_LIMIT",
							unit: 6,
							number: 1,
							usage: 100,
							currentValue: 1,
							percentage: 1,
							nextResetTime: now + 10000,
						},
					],
				},
			}),
		);
		expect((await readProviderQuota("zai", "test-key")).source).toBe(
			"zai-coding",
		);
		const [url, options] = request.mock.calls[0];
		expect(url).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
		expect(new Headers(options?.headers).get("Authorization")).toBe("test-key");
	});
	it("does not expose failure bodies and rejects oversized or empty responses", async () => {
		const request = mockQuotaResponse(
			new Response("secret-body", { status: 401 }),
		);
		await expect(readProviderQuota("claude", "test")).rejects.toThrow(
			"usage_http_401",
		);
		request.mockRestore();
		mockQuotaResponse(new Response("x".repeat(65537)));
		await expect(readProviderQuota("claude", "test")).rejects.toThrow(
			"usage_too_large",
		);
		mock.restore();
		mockQuotaResponse(new Response(null));
		await expect(readProviderQuota("claude", "test")).rejects.toThrow(
			"usage_empty",
		);
	});
});
describe("provider quota adapters", () => {
	it("separates the current seven-day breakdown metadata from actual quota windows", () => {
		const quota = parseClaudeQuota(
			{
				seven_day: {
					utilization: 7,
					resets_at: new Date(now + 10000).toISOString(),
				},
				seven_day_breakdown: {
					as_of: new Date(now).toISOString(),
					window_started_at: new Date(now - 10000).toISOString(),
					rows: [],
				},
			},
			now,
		);
		expect(quota.windows).toHaveLength(1);
		expect(quota.windows[0].key).toBe("seven_day");
	});
	it("parses real Claude weekly and model-specific limits", () => {
		const quota = parseClaudeQuota(
			{
				seven_day: {
					utilization: 18,
					resets_at: new Date(now + 10000).toISOString(),
				},
				five_hour: { utilization: 9, resets_at: null },
				seven_day_opus: { utilization: 30, resets_at: null },
			},
			now,
		);
		expect(quota.windows[0].usedPercent).toBe(18);
		expect(quota.windows.find((w) => w.key === "seven_day_opus")?.model).toBe(
			"opus",
		);
	});
	it("rejects malformed Claude percentages", () => {
		expect(() =>
			parseClaudeQuota(
				{ seven_day: { utilization: "18", resets_at: null } },
				now,
			),
		).toThrow();
	});
	it("ignores unrelated provider metadata without ignoring quota errors", () => {
		const quota = parseClaudeQuota(
			{
				seven_day: { utilization: 0, resets_at: null },
				five_hour: { utilization: 0, resets_at: null },
				extra_usage: { is_enabled: false },
			},
			now,
		);
		expect(quota.windows).toHaveLength(2);
	});
	it("parses current CREDIT_LIMIT weekly and rolling five-hour meters", () => {
		const quota = parseZaiQuota(
			{
				success: true,
				code: 200,
				data: {
					limits: [
						{
							type: "CREDIT_LIMIT",
							unit: 3,
							number: 5,
							usage: 28000,
							currentValue: 0,
							percentage: 0,
						},
						{
							type: "CREDIT_LIMIT",
							unit: 6,
							number: 1,
							usage: 140000,
							currentValue: 2800,
							percentage: 2,
							nextResetTime: now + 10000,
						},
					],
				},
			},
			now,
		);
		expect(quota.windows.find((w) => w.key === "seven_day")?.usedPercent).toBe(
			2,
		);
		expect(
			quota.windows.find((w) => w.key === "five_hour")?.resetAt,
		).toBeNull();
	});
	it("does not guess weekly quota from legacy tokens or monthly tools", () => {
		expect(() =>
			parseZaiQuota(
				{
					success: true,
					code: 200,
					data: {
						limits: [
							{
								type: "TOKENS_LIMIT",
								unit: 3,
								number: 5,
								usage: 100,
								currentValue: 10,
								percentage: 10,
							},
						],
					},
				},
				now,
			),
		).toThrow();
	});
	it("uses the more conservative precise credit fraction", () => {
		const quota = parseZaiQuota(
			{
				success: true,
				code: 200,
				data: {
					limits: [
						{
							type: "CREDIT_LIMIT",
							unit: 6,
							number: 1,
							usage: 100,
							currentValue: 84.9,
							percentage: 84,
							nextResetTime: now + 10000,
						},
					],
				},
			},
			now,
		);
		expect(quota.windows[0].usedPercent).toBe(84.9);
	});
	it("rejects failed envelopes and invalid reset timestamps", () => {
		expect(() =>
			parseZaiQuota({ success: false, data: { limits: [] } }, now),
		).toThrow();
		expect(() =>
			parseZaiQuota(
				{
					success: true,
					code: 200,
					data: {
						limits: [
							{
								type: "CREDIT_LIMIT",
								unit: 6,
								number: 1,
								usage: 100,
								currentValue: 1,
								percentage: 1,
								nextResetTime: -1,
							},
						],
					},
				},
				now,
			),
		).toThrow();
	});
});
