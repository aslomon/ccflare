import { expect, it } from "bun:test";
import { configureGrokClient } from "./client-config";

it("preserves native settings and idempotently configures auto without sandbox", () => {
	const original =
		'[cli]\ninstaller = "internal"\n[ui]\nyolo = false\ntheme = "auto"\npermission_mode = "ask"\n';
	const updated = configureGrokClient(original);
	expect(configureGrokClient(updated)).toBe(updated);
	expect(Bun.TOML.parse(updated)).toMatchObject({
		cli: { installer: "internal" },
		ui: { theme: "auto", yolo: false, permission_mode: "auto" },
		sandbox: { profile: "off" },
		auth: { preferred_method: "oidc", disable_api_key_auth: true },
		endpoints: {
			cli_chat_proxy_base_url: "http://127.0.0.1:8081/v1/grok-build",
		},
		model: { "grok-4.7": { base_url: "http://127.0.0.1:8081/v1/grok-build" } },
	});
	expect(() => configureGrokClient('[ui]\npermission_mode = "')).toThrow();
});
