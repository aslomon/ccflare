/** Slots represent active inference, including the complete response stream. */
export class LocalCapacity {
	active = 0;
	private waiting: Array<() => void> = [];
	constructor(
		private readonly maximum: number,
		private readonly maxQueued = 8,
		private readonly queueMs = 300_000,
	) {}
	private lease(): () => void {
		this.active++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active--;
			this.waiting.shift()?.();
		};
	}
	private acquire(signal?: AbortSignal): Promise<(() => void) | null> {
		if (signal?.aborted) return Promise.resolve(null);
		if (this.active < this.maximum) return Promise.resolve(this.lease());
		if (this.waiting.length >= this.maxQueued) return Promise.resolve(null);
		return new Promise((resolve) => {
			const cleanup = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", cancel);
			};
			const start = () => {
				cleanup();
				resolve(this.lease());
			};
			const cancel = () => {
				cleanup();
				this.waiting = this.waiting.filter((item) => item !== start);
				resolve(null);
			};
			const timer = setTimeout(cancel, this.queueMs);
			timer.unref();
			signal?.addEventListener("abort", cancel, { once: true });
			this.waiting.push(start);
		});
	}
	async run(
		forward: (signal: AbortSignal) => Response | Promise<Response>,
		signal?: AbortSignal,
	): Promise<Response> {
		const slot = await this.acquire(signal);
		if (!slot) return busyResponse();
		const { controller, combined, release } = abortableLease(slot, signal);
		try {
			const response = await forward(combined);
			if (!response.body) {
				release();
				return response;
			}
			return new Response(
				holdStream(response.body.getReader(), release, controller),
				{
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				},
			);
		} catch (error) {
			controller.abort(error);
			release();
			throw error;
		}
	}
}
function holdStream(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	release: () => void,
	abort: AbortController,
) {
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const item = await reader.read();
				if (item.done) {
					release();
					reader.releaseLock();
					controller.close();
				} else controller.enqueue(item.value);
			} catch (error) {
				abort.abort(error);
				release();
				reader.releaseLock();
				controller.error(error);
			}
		},
		async cancel(reason) {
			abort.abort(reason);
			try {
				await reader.cancel(reason);
			} finally {
				release();
				reader.releaseLock();
			}
		},
	});
}

function busyResponse(): Response {
	return Response.json(
		{
			error: {
				type: "local_capacity_busy",
				message:
					"Local inference queue is full, timed out or cancelled. Retry later.",
			},
		},
		{ status: 503, headers: { "Retry-After": "30" } },
	);
}

function abortableLease(slot: () => void, signal?: AbortSignal) {
	const controller = new AbortController();
	const combined = AbortSignal.any([
		controller.signal,
		AbortSignal.timeout(3_600_000),
		...(signal ? [signal] : []),
	]);
	const release = () => {
		combined.removeEventListener("abort", release);
		slot();
	};
	combined.addEventListener("abort", release, { once: true });
	if (combined.aborted) release();
	return { controller, combined, release };
}
