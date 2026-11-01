import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const logFile = join(tmpdir(), "ccflare-logs", "app.log");
const source = `
import { logFileWriter } from ${JSON.stringify(new URL("./file-writer.ts", import.meta.url).href)};
self.onmessage = (event) => {
  logFileWriter.write({ ts: Date.now(), level: "INFO", msg: event.data });
  self.postMessage(event.data);
};
`;
const workerUrl = URL.createObjectURL(
	new Blob([source], { type: "application/javascript" }),
);

async function waitForRecord(marker: string): Promise<void> {
	const deadline = Date.now() + 1000;
	while (Date.now() < deadline) {
		const file = Bun.file(logFile);
		if ((await file.exists()) && (await file.text()).includes(marker)) return;
		await Bun.sleep(1);
	}
	throw new Error(`Worker log was not persisted: ${marker}`);
}

async function runWorker(index: number): Promise<void> {
	const worker = new Worker(workerUrl, { smol: true });
	const closed = new Promise<void>((resolve) => {
		worker.addEventListener("close", () => resolve(), { once: true });
	});
	try {
		const marker = `resource-probe-${index}`;
		await new Promise<void>((resolve, reject) => {
			worker.onmessage = () => resolve();
			worker.onerror = (event) => reject(new Error(event.message));
			worker.postMessage(marker);
		});
		await waitForRecord(marker);
	} finally {
		worker.terminate();
		await closed;
		await Bun.sleep(0);
	}
}

try {
	await runWorker(-1);
	const before = readdirSync("/dev/fd").length;
	const rssBefore = process.memoryUsage().rss;
	const cycles = process.argv.includes("--stress") ? 256 : 16;
	for (let index = 0; index < cycles; index += 1) await runWorker(index);
	const after = readdirSync("/dev/fd").length;
	const rssAfter = process.memoryUsage().rss;
	process.stdout.write(
		`${JSON.stringify({ before, after, cycles, rssBefore, rssAfter })}\n`,
	);
} finally {
	URL.revokeObjectURL(workerUrl);
}
