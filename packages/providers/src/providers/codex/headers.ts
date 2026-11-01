import { z } from "zod";

const claims = z.object({
	"https://api.openai.com/auth": z.object({
		chatgpt_account_id: z
			.string()
			.min(1)
			.max(200)
			.regex(/^[a-zA-Z0-9_-]+$/),
	}),
});

/** Account hint comes from the selected credential, never the caller. */
export function codexAccountId(token: string): string | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3 || !parts[1] || parts[1].length > 32_768)
			return null;
		const value: unknown = JSON.parse(
			Buffer.from(parts[1], "base64url").toString("utf8"),
		);
		const result = claims.safeParse(value);
		return result.success
			? result.data["https://api.openai.com/auth"].chatgpt_account_id
			: null;
	} catch {
		return null;
	}
}
