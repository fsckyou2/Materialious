import type { SegmentIndexEntry } from './sidx.js';

/**
 * Reads the segment index out of a WebM initialisation blob.
 *
 * WebM has no `sidx`. Its index lives in a Cues element, which lists a
 * presentation time and a cluster position for each seek point, so the segment
 * table has to be assembled from those rather than read directly: a cluster
 * runs until the next one starts.
 *
 * Positions in Cues are relative to the start of the Segment element's data,
 * not to the file, so that offset has to be found first.
 */

const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_CUES = 0x1c53bb6b;
const ID_CUE_POINT = 0xbb;
const ID_CUE_TIME = 0xb3;
const ID_CUE_TRACK_POSITIONS = 0xb7;
const ID_CUE_CLUSTER_POSITION = 0xf1;

/** Nanoseconds per timecode tick, when the file does not say otherwise. */
const DEFAULT_TIMECODE_SCALE = 1_000_000;

type Element = {
	id: number;
	/** Offset of the element's payload. */
	dataStart: number;
	dataLength: number;
	/** Offset of the first byte after this element. */
	end: number;
};

/**
 * Reads an EBML variable length integer.
 *
 * Element ids keep the length marker - it is part of the id - while sizes and
 * values have it stripped, which is why this takes a flag rather than being two
 * near identical functions.
 */
function readVint(
	bytes: Uint8Array,
	pos: number,
	keepMarker: boolean
): { value: number; length: number } | null {
	if (pos >= bytes.length) return null;

	const first = bytes[pos];
	if (first === 0) return null;

	let length = 1;
	let mask = 0x80;
	while (length <= 8 && (first & mask) === 0) {
		mask >>= 1;
		length++;
	}

	if (length > 8 || pos + length > bytes.length) return null;

	let value = keepMarker ? first : first & (mask - 1);
	for (let i = 1; i < length; i++) {
		value = value * 256 + bytes[pos + i];
	}

	return { value, length };
}

function readElement(bytes: Uint8Array, pos: number): Element | null {
	const id = readVint(bytes, pos, true);
	if (!id) return null;

	const size = readVint(bytes, pos + id.length, false);
	if (!size) return null;

	const dataStart = pos + id.length + size.length;

	return {
		id: id.value,
		dataStart,
		dataLength: size.value,
		end: dataStart + size.value
	};
}

function readUnsigned(bytes: Uint8Array, start: number, length: number): number {
	let value = 0;
	for (let i = 0; i < length; i++) {
		value = value * 256 + bytes[start + i];
	}
	return value;
}

/** Walks the children of a master element, stopping at the end of the buffer. */
function* children(bytes: Uint8Array, from: number, to: number): Generator<Element> {
	let pos = from;

	while (pos < Math.min(to, bytes.length)) {
		const element = readElement(bytes, pos);
		if (!element) return;

		yield element;

		// An unknown length child cannot be skipped over safely.
		if (element.dataLength < 0) return;
		pos = element.end;
	}
}

export function parseWebmIndex(
	init: Uint8Array,
	contentLength: number
): SegmentIndexEntry[] | null {
	// The Segment element, whose data offset every cue position is relative to.
	let segment: Element | undefined;
	for (const element of children(init, 0, init.length)) {
		if (element.id === ID_SEGMENT) {
			segment = element;
			break;
		}
	}

	if (!segment) return null;

	let timecodeScale = DEFAULT_TIMECODE_SCALE;
	let cues: Element | undefined;

	for (const element of children(init, segment.dataStart, init.length)) {
		if (element.id === ID_INFO) {
			for (const info of children(init, element.dataStart, element.end)) {
				if (info.id === ID_TIMECODE_SCALE) {
					timecodeScale = readUnsigned(init, info.dataStart, info.dataLength);
				}
			}
		}

		if (element.id === ID_CUES) {
			cues = element;
			break;
		}
	}

	if (!cues) return null;

	const points: { time: number; position: number }[] = [];

	for (const cuePoint of children(init, cues.dataStart, cues.end)) {
		if (cuePoint.id !== ID_CUE_POINT) continue;

		let time: number | undefined;
		let position: number | undefined;

		for (const field of children(init, cuePoint.dataStart, cuePoint.end)) {
			if (field.id === ID_CUE_TIME) {
				time = readUnsigned(init, field.dataStart, field.dataLength);
			}

			if (field.id === ID_CUE_TRACK_POSITIONS) {
				for (const track of children(init, field.dataStart, field.end)) {
					if (track.id === ID_CUE_CLUSTER_POSITION) {
						position = readUnsigned(init, track.dataStart, track.dataLength);
					}
				}
			}
		}

		if (time !== undefined && position !== undefined) {
			points.push({ time, position });
		}
	}

	if (points.length === 0) return null;

	// Cues are meant to be in order, but a table built from unsorted positions
	// would produce overlapping byte ranges rather than an obvious error.
	points.sort((a, b) => a.position - b.position);

	return points.map((point, index) => {
		const start = segment.dataStart + point.position;
		const nextStart =
			index + 1 < points.length ? segment.dataStart + points[index + 1].position : contentLength;

		return {
			startTime: (point.time * timecodeScale) / 1_000_000_000,
			start,
			end: nextStart - 1
		};
	});
}
