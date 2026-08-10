import { afterEach, describe, expect, it } from "bun:test";
import { resolveServerBinding } from "./server-binding";

const originalHost = process.env.HOST;
const originalPort = process.env.PORT;

afterEach(() => {
	if (originalHost === undefined) delete process.env.HOST;
	else process.env.HOST = originalHost;

	if (originalPort === undefined) delete process.env.PORT;
	else process.env.PORT = originalPort;
});

describe("server binding", () => {
	it("binds to loopback by default", () => {
		delete process.env.HOST;
		delete process.env.PORT;

		expect(resolveServerBinding()).toEqual({
			hostname: "127.0.0.1",
			port: 8080,
		});
	});

	it("accepts an explicit environment binding", () => {
		process.env.HOST = "0.0.0.0";
		process.env.PORT = "9090";

		expect(resolveServerBinding()).toEqual({
			hostname: "0.0.0.0",
			port: 9090,
		});
	});

	it("falls back safely when environment values are invalid", () => {
		process.env.HOST = "   ";
		process.env.PORT = "99999";

		expect(resolveServerBinding()).toEqual({
			hostname: "127.0.0.1",
			port: 8080,
		});
	});

	it("prefers validated programmatic options", () => {
		process.env.HOST = "0.0.0.0";
		process.env.PORT = "9090";

		expect(resolveServerBinding({ hostname: "localhost", port: 8181 })).toEqual(
			{ hostname: "localhost", port: 8181 },
		);
	});
});
