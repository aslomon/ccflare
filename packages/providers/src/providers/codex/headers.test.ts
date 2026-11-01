import { describe, expect, it } from "bun:test";
import { createOAuthAccount } from "../../test-helpers";
import { codexAccountId } from "./headers";
import { CodexProvider } from "./provider";

const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "selected-account" } })).toString("base64url")}.signature`;
describe("Codex selected-account headers", () => {
	it("only treats successful headerless native Responses as SSE", () => {
		const provider = new CodexProvider();
		expect(provider.isStreamingResponse(new Response(null), "/responses")).toBe(
			true,
		);
		expect(provider.isStreamingResponse(new Response(null), "/models")).toBe(
			false,
		);
		expect(
			provider.isStreamingResponse(
				new Response(null, { status: 400 }),
				"/responses",
			),
		).toBe(false);
		expect(
			provider.isStreamingResponse(
				new Response(null, { headers: { "content-type": "application/json" } }),
				"/responses",
			),
		).toBe(false);
	});
	it("replaces the caller identity with the selected OAuth account", () => {
		const account = createOAuthAccount("codex", { access_token: token });
		const headers = new CodexProvider().prepareHeaders(
			new Headers({
				"ChatGPT-Account-Id": "caller-account",
				Authorization: "Bearer caller",
			}),
			account,
		);
		expect(headers.get("ChatGPT-Account-Id")).toBe("selected-account");
		expect(headers.get("Authorization")).toBe(`Bearer ${token}`);
	});
	it("does not forward a caller account id without a valid selected identity", () => {
		expect(
			new CodexProvider()
				.prepareHeaders(new Headers({ "ChatGPT-Account-Id": "caller" }), null)
				.has("ChatGPT-Account-Id"),
		).toBe(false);
		for (const value of [
			"invalid",
			"a.invalid.c",
			"a.e30.c",
			`a.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "bad\nheader" } })).toString("base64url")}.c`,
		]) {
			expect(codexAccountId(value)).toBeNull();
		}
	});
});
