import { expect, it } from "bun:test";
import { LocalCapacity } from "./local-capacity";

it("holds two slots until completion or cancellation and releases errors", async () => {
	const capacity = new LocalCapacity(2, 0);
	const stream = () =>
		new Response(
			new ReadableStream({
				start(c) {
					c.enqueue(new TextEncoder().encode("start"));
				},
			}),
		);
	const first = await capacity.run(stream);
	const second = await capacity.run(stream);
	expect((await capacity.run(() => new Response("third"))).status).toBe(503);
	await first.body?.cancel();
	expect(await (await capacity.run(() => new Response("ok"))).text()).toBe(
		"ok",
	);
	await second.body?.cancel();
	await expect(
		capacity.run(() => {
			throw new Error("offline");
		}),
	).rejects.toThrow("offline");
	expect(capacity.active).toBe(0);
});

it("aborts upstream work before releasing a cancelled response", async () => {
	const capacity = new LocalCapacity(1);
	let upstreamSignal: AbortSignal | undefined;
	const response = await capacity.run((signal) => {
		upstreamSignal = signal;
		return new Response(
			new ReadableStream({
				start(c) {
					c.enqueue(new Uint8Array([1]));
				},
			}),
		);
	});
	await response.body?.cancel();
	expect(upstreamSignal?.aborted).toBe(true);
	expect(capacity.active).toBe(0);
});
it("releases capacity when an upstream stream fails", async () => {
	const capacity = new LocalCapacity(1);
	const response = await capacity.run(
		() =>
			new Response(
				new ReadableStream({
					start(c) {
						c.error(new Error("disconnected"));
					},
				}),
			),
	);
	await expect(response.text()).rejects.toThrow("disconnected");
	expect(capacity.active).toBe(0);
});

it("queues incidental harness calls until an inference slot is free", async () => {
	const capacity = new LocalCapacity(1);
	const first = await capacity.run(
		() =>
			new Response(
				new ReadableStream({
					start(c) {
						c.enqueue(new Uint8Array([1]));
					},
				}),
			),
	);
	let started = false;
	const waiting = capacity.run(() => {
		started = true;
		return new Response("queued");
	});
	await Promise.resolve();
	expect(started).toBe(false);
	await first.body?.cancel();
	expect(await (await waiting).text()).toBe("queued");
	expect(capacity.active).toBe(0);
});

it("removes cancelled and timed-out queued requests without forwarding them", async () => {
	const capacity = new LocalCapacity(1, 1, 20);
	const first = await capacity.run(
		() =>
			new Response(
				new ReadableStream({
					start(c) {
						c.enqueue(new Uint8Array([1]));
					},
				}),
			),
	);
	const abort = new AbortController();
	const queued = capacity.run(() => {
		throw new Error("must not forward");
	}, abort.signal);
	abort.abort();
	expect((await queued).status).toBe(503);
	expect(
		(
			await capacity.run(() => {
				throw new Error("must time out");
			})
		).status,
	).toBe(503);
	await first.body?.cancel();
	expect(capacity.active).toBe(0);
});

it("releases a discarded response when the client aborts", async () => {
	const capacity = new LocalCapacity(1, 0);
	const abort = new AbortController();
	await capacity.run(
		() =>
			new Response(
				new ReadableStream({
					start(c) {
						c.enqueue(new Uint8Array([1]));
					},
				}),
			),
		abort.signal,
	);
	abort.abort();
	expect(capacity.active).toBe(0);
});
