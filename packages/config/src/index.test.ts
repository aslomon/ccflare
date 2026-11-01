import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigHandlers } from "../../api/src/handlers/config";
import { Config } from "./index";

const tempDirs: string[] = [];
const originalRequestRetentionDays = process.env.REQUEST_RETENTION_DAYS;
const policyEnvironment = [
	"CCFLARE_BUDGET_ENABLED",
	"CCFLARE_BUDGET_CUTOFF_PERCENT",
	"CCFLARE_SESSION_ROTATION_MIN_MS",
	"CCFLARE_SESSION_ROTATION_MAX_MS",
];
const originalPolicyEnvironment = new Map(
	policyEnvironment.map((key) => [key, process.env[key]]),
);

function createConfigPath(): string {
	const tempDir = mkdtempSync(join(tmpdir(), "ccflare-config-"));
	tempDirs.push(tempDir);
	return join(tempDir, "config.json");
}

afterEach(() => {
	for (const key of policyEnvironment) {
		const value = originalPolicyEnvironment.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	if (originalRequestRetentionDays === undefined) {
		delete process.env.REQUEST_RETENTION_DAYS;
	} else {
		process.env.REQUEST_RETENTION_DAYS = originalRequestRetentionDays;
	}

	while (tempDirs.length > 0) {
		const tempDir = tempDirs.pop();
		if (tempDir) rmSync(tempDir, { force: true, recursive: true });
	}
});

describe("request metadata retention", () => {
	it("clamps a config-file value to at least seven days", () => {
		const configPath = createConfigPath();
		writeFileSync(configPath, JSON.stringify({ request_retention_days: 1 }));

		const config = new Config(configPath);

		expect(config.getRequestRetentionDays()).toBe(7);
	});

	it("clamps an environment value to at least seven days", () => {
		process.env.REQUEST_RETENTION_DAYS = "2";

		const config = new Config(createConfigPath());

		expect(config.getRequestRetentionDays()).toBe(7);
	});

	it("clamps setter values and persists the safe value", () => {
		const configPath = createConfigPath();
		const config = new Config(configPath);

		config.setRequestRetentionDays(3);

		expect(config.getRequestRetentionDays()).toBe(7);
		expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(
			expect.objectContaining({ request_retention_days: 7 }),
		);
	});
});

describe("session rotation configuration", () => {
	it("validates managed environment rotation and budget policy", () => {
		process.env.CCFLARE_SESSION_ROTATION_MIN_MS = "1200000";
		process.env.CCFLARE_SESSION_ROTATION_MAX_MS = "5400000";
		process.env.CCFLARE_BUDGET_ENABLED = "1";
		process.env.CCFLARE_BUDGET_CUTOFF_PERCENT = "85";
		const config = new Config(createConfigPath());
		expect(config.getSessionRotation()).toEqual({
			minMs: 1200000,
			maxMs: 5400000,
		});
		expect(config.getBudgetPolicy()).toMatchObject({
			enabled: true,
			cutoffPercent: 85,
		});
		process.env.CCFLARE_BUDGET_CUTOFF_PERCENT = "91";
		expect(() => config.getBudgetPolicy()).toThrow();
	});
	it("keeps rotation disabled for existing installations", () => {
		expect(new Config(createConfigPath()).getSessionRotation()).toBeUndefined();
	});

	it("reports the configured 20-90 minute window through the management API", async () => {
		const configPath = createConfigPath();
		writeFileSync(
			configPath,
			JSON.stringify({
				session_rotation_min_ms: 1_200_000,
				session_rotation_max_ms: 5_400_000,
			}),
		);
		const config = new Config(configPath);
		expect(config.getRuntime().sessionRotation).toEqual({
			minMs: 1_200_000,
			maxMs: 5_400_000,
		});
		const response = createConfigHandlers(config).getConfig();
		expect(await response.json()).toMatchObject({
			sessionRotation: { minMs: 1_200_000, maxMs: 5_400_000 },
		});
	});

	it("uses the default upper bound when only a minimum is configured", () => {
		const configPath = createConfigPath();
		writeFileSync(
			configPath,
			JSON.stringify({ session_rotation_min_ms: 1_200_000 }),
		);
		expect(new Config(configPath).getSessionRotation()).toEqual({
			minMs: 1_200_000,
			maxMs: 5_400_000,
		});
	});

	it.each([
		{ session_rotation_min_ms: 0, session_rotation_max_ms: 5_400_000 },
		{ session_rotation_min_ms: 5_400_000, session_rotation_max_ms: 1_200_000 },
		{ session_rotation_min_ms: "1200000", session_rotation_max_ms: 5_400_000 },
		{ session_rotation_min_ms: 1_200_000, session_rotation_max_ms: 90_000_000 },
	])("rejects invalid rotation settings %j", (settings) => {
		const configPath = createConfigPath();
		writeFileSync(configPath, JSON.stringify(settings));
		expect(() => new Config(configPath).getSessionRotation()).toThrow();
	});
});
