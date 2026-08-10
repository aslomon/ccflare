const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const;
const DICTIONARY_ID_SIZES = [0, 1, 2, 4] as const;

function hasZstdMagic(data: Uint8Array): boolean {
	return ZSTD_MAGIC.every((byte, index) => data[index] === byte);
}

function readLittleEndian(
	data: Uint8Array,
	offset: number,
	length: number,
): bigint | null {
	if (offset < 0 || length < 1 || offset + length > data.byteLength)
		return null;
	let value = 0n;
	for (let index = 0; index < length; index += 1) {
		value |= BigInt(data[offset + index] ?? 0) << BigInt(index * 8);
	}
	return value;
}

function getContentSizeLength(
	descriptor: number,
	singleSegment: boolean,
): number {
	const flag = descriptor >>> 6;
	if (flag === 0) return singleSegment ? 1 : 0;
	if (flag === 1) return 2;
	if (flag === 2) return 4;
	return 8;
}

export function readZstdFrameContentSize(data: Uint8Array): number | null {
	if (data.byteLength < 6 || !hasZstdMagic(data)) return null;
	const descriptor = data[4];
	if (descriptor === undefined || (descriptor & 0x08) !== 0) return null;

	const singleSegment = (descriptor & 0x20) !== 0;
	let offset = 5 + (singleSegment ? 0 : 1);
	const dictionarySize = DICTIONARY_ID_SIZES[descriptor & 0x03] ?? 0;
	offset += dictionarySize;
	const contentSizeLength = getContentSizeLength(descriptor, singleSegment);
	if (contentSizeLength === 0) return null;

	const encodedSize = readLittleEndian(data, offset, contentSizeLength);
	if (encodedSize === null) return null;
	const contentSize =
		contentSizeLength === 2 ? encodedSize + 256n : encodedSize;
	if (contentSize > BigInt(Number.MAX_SAFE_INTEGER)) return null;
	return Number(contentSize);
}
