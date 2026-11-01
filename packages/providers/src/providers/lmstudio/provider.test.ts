import { describe, expect, it } from "bun:test";
import { createApiKeyAccount } from "../../test-helpers";
import { LmStudioProvider } from "./provider";

const provider = new LmStudioProvider();
const encode = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value)).buffer;
const decode = (value: ArrayBuffer | null) =>
	JSON.parse(new TextDecoder().decode(value ?? undefined));
describe("LM Studio isolation", () => {
	it("uses a dedicated route and strips incoming cloud credentials", () => {
		expect(provider.buildUrl("/v1/messages", "")).toBe(
			"http://127.0.0.1:1234/v1/messages",
		);
		const account = createApiKeyAccount("lmstudio", { api_key: "local-token" });
		const headers = provider.prepareHeaders(
			new Headers({
				authorization: "Bearer cloud-secret",
				"x-api-key": "cloud-key",
				"content-length": "12",
			}),
			account,
		);
		expect(headers.get("authorization")).toBeNull();
		expect(headers.get("x-api-key")).toBe("local-token");
		expect(headers.get("content-length")).toBeNull();
	});
	it("removes conflicting effort when thinking is disabled", () => {
		const body = decode(
			provider.prepareBody(
				encode({
					model: "qwen/test",
					thinking: { type: "disabled" },
					output_config: { effort: "low" },
					tools: [],
				}),
			),
		);
		expect(body.output_config).toBeUndefined();
		expect(body.thinking.type).toBe("disabled");
		expect(body.tools).toEqual([]);
	});
	it("makes effort-only thinking explicit and preserves enabled reasoning", () => {
		const body = decode(
			provider.prepareBody(
				encode({ model: "qwen/test", output_config: { effort: "low" } }),
			),
		);
		expect(body.thinking.type).toBe("enabled");
		expect(body.output_config.effort).toBe("low");
	});
	it("defaults omitted reasoning to disabled and rejects invalid settings", () => {
		expect(
			decode(provider.prepareBody(encode({ model: "qwen/test" }))).thinking
				.type,
		).toBe("disabled");
		expect(() =>
			provider.prepareBody(
				encode({ model: "qwen/test", thinking: { type: "invalid" } }),
			),
		).toThrow();
	});
});

it("honors the worker reasoning override instead of inherited CLI effort", () => {
	const body = decode(
		provider.prepareBody(
			encode({ output_config: { effort: "low" } }),
			new Headers({ "x-ccflare-local-thinking": "off" }),
		),
	);
	expect(body.thinking.type).toBe("disabled");
	expect(body.output_config).toBeUndefined();
	const on = decode(
		provider.prepareBody(
			encode({
				thinking: { type: "disabled" },
				output_config: { effort: "low" },
			}),
			new Headers({ "x-ccflare-local-thinking": "on" }),
		),
	);
	expect(on.thinking.type).toBe("enabled");
	expect(on.output_config.effort).toBe("low");
});
