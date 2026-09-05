export type SegmentIndexEntry = {
	/** Presentation time of the segment, in seconds. */
	startTime: number;
	/** Byte offset of the segment within the format's virtual file. */
	start: number;
	/** Inclusive end offset of the segment. */
	end: number;
};

/**
 * Reads the segment index out of a format's initialization blob.
 *
 * YouTube hands SABR clients the same `sidx` box a plain DASH stream would
 * carry, so the byte offsets it describes line up exactly with the ranges in
 * the manifest generated from the same player response. That is what lets a
 * receiver ask for "bytes 900000-1200000" and lets us answer with the SABR
 * segment covering it.
 *
 * @param bytes - The init blob, which spans the moov and the sidx.
 * @param indexStart - Offset the manifest reports for the index box.
 * @param firstSegmentOffset - Byte offset the first media segment starts at.
 */
export function parseSegmentIndex(
	bytes: Uint8Array,
	indexStart: number,
	firstSegmentOffset: number
): SegmentIndexEntry[] | null {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	let pos = indexStart;
	while (pos < bytes.length - 8) {
		const boxSize = view.getUint32(pos);
		const boxType = String.fromCharCode(...bytes.slice(pos + 4, pos + 8));

		if (boxType === 'sidx') {
			let p = pos + 8;
			const version = view.getUint8(p);
			p += 8; // version + flags, reference_ID

			const timescale = view.getUint32(p);
			p += 4;

			let time: number;
			if (version === 0) {
				time = view.getUint32(p);
				p += 8; // earliest_presentation_time + first_offset
			} else {
				time = Number(view.getBigUint64(p));
				p += 16;
			}

			p += 2; // reserved
			const count = view.getUint16(p);
			p += 2;

			const entries: SegmentIndexEntry[] = [];
			let offset = firstSegmentOffset;

			for (let i = 0; i < count; i++) {
				const referencedSize = view.getUint32(p) & 0x7fffffff;
				const duration = view.getUint32(p + 4);

				entries.push({
					startTime: time / timescale,
					start: offset,
					end: offset + referencedSize - 1
				});

				time += duration;
				offset += referencedSize;
				p += 12;
			}

			return entries;
		}

		if (!boxSize) break;
		pos += boxSize;
	}

	return null;
}
