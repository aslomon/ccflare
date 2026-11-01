import { describe, expect, it } from "bun:test";
import type { StartMessage } from "./worker-messages";

async function loadWorkerHelpers() {
	const originalPath = process.env.ccflare_DB_PATH;
	process.env.ccflare_DB_PATH = ":memory:";
	try {
		return await import("./post-processor.worker");
	} finally {
		if (originalPath === undefined) delete process.env.ccflare_DB_PATH;
		else process.env.ccflare_DB_PATH = originalPath;
	}
}

const { captureStreamChunkForPayload, createRequestState, processStreamChunk } =
	await loadWorkerHelpers();

function createStartMessage(): StartMessage {
	return {
		type: "start",
		requestId: "req-1",
		accountId: "account-1",
		method: "POST",
		path: "/v1/openai/responses",
		upstreamPath: "/responses",
		timestamp: Date.now(),
		requestHeaders: {},
		requestBody: null,
		captureRawPayload: false,
		rawPayloadMaxBytes: 256 * 1024,
		requestBodyTruncated: false,
		responseStatus: 200,
		responseHeaders: {
			"content-type": "text/event-stream; charset=utf-8",
		},
		isStream: true,
		providerName: "openai",
		retryAttempt: 0,
		failoverAttempts: 0,
	};
}

describe("processStreamChunk", () => {
	it("does not retain stream chunks when raw capture is disabled", () => {
		const state = createRequestState({
			...createStartMessage(),
			captureRawPayload: false,
		});

		captureStreamChunkForPayload(new Uint8Array([1, 2, 3]), state);

		expect(state.chunks).toEqual([]);
		expect(state.chunksBytes).toBe(0);
	});

	it("extracts usage when response.completed event and data are in the same chunk", () => {
		const state = createRequestState(createStartMessage());

		processStreamChunk(
			new TextEncoder().encode(
				[
					"event: response.completed",
					'data: {"type":"response.completed","response":{"id":"resp_123","model":"gpt-4o","usage":{"input_tokens":13,"output_tokens":5,"total_tokens":18}}}',
					"",
				].join("\n"),
			),
			state,
		);

		expect(state.usage).toMatchObject({
			model: "gpt-4o",
			inputTokens: 13,
			outputTokens: 5,
			totalTokens: 18,
		});
	});

	it("extracts usage when response.completed event and data are split across chunks", () => {
		const state = createRequestState(createStartMessage());

		processStreamChunk(
			new TextEncoder().encode("event: response.completed\n"),
			state,
		);
		processStreamChunk(
			new TextEncoder().encode(
				'data: {"type":"response.completed","response":{"id":"resp_123","model":"gpt-4o","usage":{"input_tokens":13,"output_tokens":5,"total_tokens":18}}}\n\n',
			),
			state,
		);

		expect(state.usage).toMatchObject({
			model: "gpt-4o",
			inputTokens: 13,
			outputTokens: 5,
			totalTokens: 18,
		});
	});

	it("adjusts cached input tokens and stores reasoning tokens from response.completed usage", () => {
		const state = createRequestState(createStartMessage());

		processStreamChunk(
			new TextEncoder().encode(
				[
					"event: response.completed",
					'data: {"type":"response.completed","response":{"id":"resp_123","model":"gpt-4o","usage":{"input_tokens":18815,"output_tokens":431,"total_tokens":19246,"input_tokens_details":{"cached_tokens":18688},"output_tokens_details":{"reasoning_tokens":321}}}}',
					"",
				].join("\n"),
			),
			state,
		);

		expect(state.usage).toMatchObject({
			model: "gpt-4o",
			inputTokens: 127,
			cacheReadInputTokens: 18688,
			outputTokens: 431,
			reasoningTokens: 321,
			totalTokens: 19246,
		});
	});

	it("tracks token timing and local token counts for response.output_text.delta events", () => {
		const state = createRequestState(createStartMessage());

		processStreamChunk(
			new TextEncoder().encode(
				[
					"event: response.output_text.delta",
					'data: {"type":"response.output_text.delta","delta":"Hello"}',
					"",
				].join("\n"),
			),
			state,
		);

		expect(state.firstTokenTimestamp).toBeNumber();
		expect(state.lastTokenTimestamp).toBeNumber();
		expect((state.usage.outputTokensComputed ?? 0) > 0).toBe(true);
	});

	it("normalizes compatibility-prefixed models in chat completion chunks", () => {
		const state = createRequestState(createStartMessage());

		processStreamChunk(
			new TextEncoder().encode(
				[
					"event: message",
					'data: {"object":"chat.completion.chunk","model":"openai/gpt-4o","choices":[{"index":0,"delta":{"content":"Hello"}}]}',
					"",
				].join("\n"),
			),
			state,
		);

		expect(state.usage.model).toBe("gpt-4o");
	});

	it("extracts usage from chat completion chunks without explicit event lines", () => {
		const state = createRequestState(createStartMessage());

		processStreamChunk(
			new TextEncoder().encode(
				[
					'data: {"object":"chat.completion.chunk","model":"gpt-5.4","choices":[{"index":0,"delta":{"content":"Hey"}}]}',
					"",
					'data: {"object":"chat.completion.chunk","model":"gpt-5.4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":68,"input_tokens":44,"output_tokens":24,"cache_read_input_tokens":0,"reasoning_tokens":0}}',
					"",
				].join("\n"),
			),
			state,
		);

		expect(state.usage).toMatchObject({
			model: "gpt-5.4",
			inputTokens: 44,
			outputTokens: 24,
			totalTokens: 68,
		});
		expect(state.firstTokenTimestamp).toBeNumber();
		expect(state.lastTokenTimestamp).toBeNumber();
	});
});

it("uses the final LM Studio input count instead of its preliminary count", () => {
	const state = createRequestState({
		...createStartMessage(),
		providerName: "lmstudio",
	});
	processStreamChunk(
		new TextEncoder().encode(
			'event: message_start\ndata: {"type":"message_start","message":{"model":"qwen/test","usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
		),
		state,
	);
	processStreamChunk(
		new TextEncoder().encode(
			'event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":12,"output_tokens":7}}\n\n',
		),
		state,
	);
	expect(state.usage.inputTokens).toBe(12);
	expect(state.usage.outputTokens).toBe(7);
});
