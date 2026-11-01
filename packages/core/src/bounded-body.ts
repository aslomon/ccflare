/** Buffer an external payload without first allocating an unbounded body. */
export async function readBoundedBody(
	request: Request,
	maximum: number,
): Promise<ArrayBuffer | null> {
	if (!request.body) return null;
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > maximum) {
				await reader.cancel();
				throw new Error("Request body exceeds limit");
			}
			chunks.push(chunk.value);
		}
	} finally {
		reader.releaseLock();
	}
	const result = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result.buffer;
}
