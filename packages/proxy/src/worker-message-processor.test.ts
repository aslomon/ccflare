import { describe, expect, it } from "bun:test";
import { processWorkerMessageWithAck } from "./worker-message-processor";
import type { EndMessage } from "./worker-messages";

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolvePromise = (): void => {};
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

function createEndMessage(): EndMessage {
	return {
		type: "end",
		messageId: "message-1",
		requestId: "request-1",
		success: true,
	};
}

describe("processWorkerMessageWithAck", () => {
	it("acknowledges an end only after durable processing completes", async () => {
		const processingGate = createDeferred();
		const acknowledgements: string[] = [];
		const processing = processWorkerMessageWithAck(
			createEndMessage(),
			async () => processingGate.promise,
			(message) => acknowledgements.push(message.messageId),
		);

		await Bun.sleep(5);
		expect(acknowledgements).toEqual([]);
		processingGate.resolve();
		await processing;
		expect(acknowledgements).toEqual(["message-1"]);
	});

	it("does not acknowledge failed durable processing", async () => {
		const acknowledgements: string[] = [];

		await expect(
			processWorkerMessageWithAck(
				createEndMessage(),
				async () => {
					throw new Error("database unavailable");
				},
				(message) => acknowledgements.push(message.messageId),
			),
		).rejects.toThrow("database unavailable");
		expect(acknowledgements).toEqual([]);
	});
});
