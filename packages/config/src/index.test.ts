import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

const tempDirs: string[] = [];
const originalRequestRetentionDays = process.env.REQUEST_RETENTION_DAYS;

function createConfigPath(): string {
	const tempDir = mkdtempSync(join(tmpdir(), "ccflare-config-"));
	tempDirs.push(tempDir);
	return join(tempDir, "config.json");
}

afterEach(() => {
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
