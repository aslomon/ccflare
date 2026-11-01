import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "@ccflare/types";

test("repeated worker termination does not retain log descriptors", async () => {
	const directory = mkdtempSync(join(tmpdir(), "ccflare-log-resources-"));
	try {
		const child = Bun.spawn(
			[
				process.execPath,
				new URL("./file-writer.resources.fixture.ts", import.meta.url).pathname,
			],
			{
				env: {
					...process.env,
					TMPDIR: directory,
					TMP: directory,
					TEMP: directory,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [exitCode, output, errors] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(errors).toBe("");
		expect(exitCode).toBe(0);
		const result: unknown = JSON.parse(output);
		if (
			!isRecord(result) ||
			typeof result.before !== "number" ||
			typeof result.after !== "number"
		) {
			throw new Error("Invalid resource probe result");
		}
		expect(result.after - result.before).toBeLessThanOrEqual(2);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
