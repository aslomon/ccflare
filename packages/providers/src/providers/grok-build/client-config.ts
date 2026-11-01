import { z } from "zod";

const proxyBaseUrl = "http://127.0.0.1:8081/v1/grok-build";
const models = ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"];

function setValue(
	text: string,
	section: string,
	key: string,
	value: unknown,
): string {
	const lines = text.trimEnd().split("\n");
	const header = `[${section}]`;
	let index = lines.indexOf(header);
	if (index < 0) {
		lines.push("", header);
		index = lines.length - 1;
	}
	let end = index + 1;
	while (end < lines.length && !lines[end]?.trimStart().startsWith("[")) end++;
	const replacement = `${key} = ${JSON.stringify(value)}`;
	const existing = lines.findIndex(
		(line, position) =>
			position > index &&
			position < end &&
			new RegExp(`^\\s*${key}\\s*=`).test(line),
	);
	if (existing >= 0) lines[existing] = replacement;
	else lines.splice(index + 1, 0, replacement);
	return `${lines.join("\n").trimEnd()}\n`;
}

export function configureGrokClient(original: string): string {
	z.record(z.unknown()).parse(Bun.TOML.parse(original));
	let text = setValue(original, "ui", "permission_mode", "auto");
	text = setValue(text, "ui", "yolo", false);
	text = setValue(text, "sandbox", "profile", "off");
	text = setValue(text, "auth", "preferred_method", "oidc");
	text = setValue(text, "auth", "disable_api_key_auth", true);
	text = setValue(text, "endpoints", "cli_chat_proxy_base_url", proxyBaseUrl);
	for (const model of models)
		text = setValue(text, `model."${model}"`, "base_url", proxyBaseUrl);
	z.record(z.unknown()).parse(Bun.TOML.parse(text));
	return text;
}
