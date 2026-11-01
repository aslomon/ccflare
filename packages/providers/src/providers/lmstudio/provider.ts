import type { Account } from "@ccflare/types";
import { z } from "zod";
import { deleteTransportHeaders } from "../../base";
import { AnthropicProvider } from "../anthropic/provider";

const requestSchema = z
	.object({
		thinking: z
			.object({
				type: z.enum(["disabled", "enabled", "adaptive"]),
				budget_tokens: z.number().int().positive().optional(),
			})
			.passthrough()
			.optional(),
		output_config: z
			.object({
				effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
			})
			.passthrough()
			.optional(),
	})
	.passthrough();

/** LM Studio speaks Anthropic messages, but owns neither Claude credentials nor quota. */
export class LmStudioProvider extends AnthropicProvider {
	name = "lmstudio";
	defaultBaseUrl = "http://127.0.0.1:1234";

	prepareHeaders(headers: Headers, account: Account | null): Headers {
		const result = new Headers(headers);
		deleteTransportHeaders(result);
		for (const key of [
			"authorization",
			"x-api-key",
			"content-length",
			"anthropic-beta",
			"x-ccflare-local-thinking",
		])
			result.delete(key);
		if (account?.api_key) result.set("x-api-key", account.api_key);
		return result;
	}

	prepareBody(body: ArrayBuffer | null, headers?: Headers): ArrayBuffer | null {
		if (!body) return body;
		const value = requestSchema.parse(
			JSON.parse(new TextDecoder().decode(body)),
		);
		const override = headers?.get("x-ccflare-local-thinking");
		if (override)
			value.thinking = {
				type:
					z.enum(["on", "off"]).parse(override) === "on"
						? "enabled"
						: "disabled",
			};
		if (value.thinking?.type === "disabled") {
			if (value.output_config) {
				delete value.output_config.effort;
				if (Object.keys(value.output_config).length === 0)
					delete value.output_config;
			}
		} else if (!value.thinking) {
			value.thinking = {
				type: value.output_config?.effort ? "enabled" : "disabled",
			};
		}
		return new TextEncoder().encode(JSON.stringify(value)).buffer;
	}
}
