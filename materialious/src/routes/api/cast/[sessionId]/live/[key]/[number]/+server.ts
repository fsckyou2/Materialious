import { getCastSession, SegmentNotReadyError } from '@materialious/shared/cast';
import { error } from '@sveltejs/kit';
import { castCorsHeaders } from '$lib/server/cast';

/**
 * One segment of a live stream.
 *
 * Live publishes no index, so unlike a recording there is no virtual file to
 * serve byte ranges of: segments are addressed by number, which maps directly
 * onto presentation time. Each one carries its own initialisation, so there is
 * nothing to fetch beforehand.
 */
export async function GET({ params }) {
	const session = getCastSession(params.sessionId);
	if (!session) {
		throw error(404, 'Cast session not found or expired');
	}

	const number = Number(params.number);
	if (!Number.isInteger(number) || number < 0) {
		throw error(400, 'Invalid segment number');
	}

	let segment: Uint8Array;
	try {
		segment = await session.getLiveSegment(params.key, number);
	} catch (err) {
		// A receiver that has caught up with the live edge should wait for the
		// segment rather than treat the stream as broken.
		if (err instanceof SegmentNotReadyError) {
			throw error(404, err.message);
		}

		throw error(502, err instanceof Error ? err.message : 'Could not fetch that segment');
	}

	// Handed over as a plain buffer: a view over a shared one is not a body.
	const body = segment.buffer.slice(
		segment.byteOffset,
		segment.byteOffset + segment.byteLength
	) as ArrayBuffer;

	return new Response(body, {
		headers: {
			'content-type': session.mimeTypeForKey(params.key),
			'content-length': String(segment.byteLength),
			// A live segment never changes once produced, but the window moves,
			// so caching is left to the receiver's own buffering.
			'cache-control': 'no-store',
			...castCorsHeaders
		}
	});
}

export async function OPTIONS() {
	return new Response(null, { status: 204, headers: castCorsHeaders });
}
