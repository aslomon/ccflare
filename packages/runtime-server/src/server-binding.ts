import { NETWORK } from "@ccflare/core";
import { z } from "zod";

const DEFAULT_HOSTNAME = "127.0.0.1";
const hostnameSchema = z
	.string()
	.trim()
	.min(1)
	.max(253)
	.regex(/^[a-zA-Z0-9.:[\]-]+$/);
const portSchema = z.coerce.number().int().min(1).max(65_535);

export type ServerBinding = {
	hostname: string;
	port: number;
};

export type ServerBindingOptions = {
	hostname?: string;
	port?: number;
};

function parseHostname(value: unknown): string {
	const parsed = hostnameSchema.safeParse(value);
	return parsed.success ? parsed.data : DEFAULT_HOSTNAME;
}

function parsePort(value: unknown): number {
	const parsed = portSchema.safeParse(value);
	return parsed.success ? parsed.data : NETWORK.DEFAULT_PORT;
}

export function resolveServerBinding(
	options: ServerBindingOptions = {},
): ServerBinding {
	return {
		hostname: parseHostname(
			options.hostname ?? process.env.CCFLARE_HOST ?? process.env.HOST,
		),
		port: parsePort(options.port ?? process.env.PORT),
	};
}
