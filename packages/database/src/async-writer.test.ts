import { describe, expect, it } from "bun:test";
import { AsyncDbWriter } from "./async-writer";

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolvePromise = (): void => {};
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

async function waitFor(
	condition: () => boolean,
	timeoutMs = 250,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		if (condition()) {
			return;
		}

		await Bun.sleep(5);
	}

	throw new Error("Timed out waiting for condition");
}

describe("AsyncDbWriter", () => {
	it("resolves a write result only after the job has completed", async () => {
		const writer = new AsyncDbWriter();
		const jobGate = createDeferred();

		const resultPromise = writer.enqueue(async () => {
			await jobGate.promise;
		});
		let settled = false;
		void resultPromise.then(() => {
			settled = true;
		});

		await Bun.sleep(5);
		expect(settled).toBe(false);
		jobGate.resolve();
		expect(await resultPromise).toEqual({ data: true, error: null });
		await writer.dispose();
	});

	it("returns an explicit error result for failed jobs", async () => {
		const writer = new AsyncDbWriter();
		const result = await writer.enqueue(() => {
			throw new Error("write failed");
		});

		expect(result.data).toBeNull();
		expect(result.error?.message).toBe("write failed");
		await writer.dispose();
	});

	it("tracks failed jobs and exposes an unhealthy state", async () => {
		const writer = new AsyncDbWriter();

		writer.enqueue(async () => {
			throw new Error("boom");
		});

		await waitFor(() => writer.getFailureCount() === 1);
		await writer.dispose();

		expect(writer.isHealthy()).toBe(false);
		expect(writer.getFailureCount()).toBe(1);
	});

	it("flushes queued jobs during disposal", async () => {
		const writer = new AsyncDbWriter();
		let completed = false;

		writer.enqueue(async () => {
			await Bun.sleep(10);
			completed = true;
		});

		await writer.dispose();

		expect(completed).toBe(true);
		expect(writer.getQueueSize()).toBe(0);
		expect(writer.getFailureCount()).toBe(0);
	});
});
