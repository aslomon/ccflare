import { expect, test } from "bun:test";
import { calculateStreamSpeed } from "./stream-timing";

test("uses the observed stream interval without inventing a one-millisecond duration", () => {
	expect(calculateStreamSpeed(100, 1_000, 3_000)).toBe(50);
	expect(calculateStreamSpeed(100, 1_000, 1_000)).toBeNull();
	expect(calculateStreamSpeed(100, undefined, 3_000)).toBeNull();
	expect(calculateStreamSpeed(0, 1_000, 3_000)).toBeNull();
	expect(calculateStreamSpeed(100, 3_000, 1_000)).toBeNull();
	expect(
		calculateStreamSpeed(Number.POSITIVE_INFINITY, 1_000, 3_000),
	).toBeNull();
});
