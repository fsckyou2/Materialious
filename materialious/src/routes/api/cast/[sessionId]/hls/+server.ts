import { castBaseUrl, castCorsHeaders, getCastSession } from '$lib/server/cast';
import { error } from '@sveltejs/kit';

/**
 * A live stream as YouTube's own HLS, for a receiver that asked for it.
 *
 * Without `u` this is the master playlist; with it, the playlist or segment
 * at that address, fetched from YouTube and passed through. Every address in
 * a playlist is rewritten to come back here, so the receiver talks to nobody
 * but this instance.
 */
export async function GET(event) {
	const { params, url, request } = event;

	const session = getCastSession(params.sessionId);
	if (!session) {
		throw error(404, 'Cast session not found or expired');
	}

	const maxHeight = Number(url.searchParams.get('maxHeight') ?? 1080) || 1080;

	let answer: Awaited<ReturnType<typeof session.getHls>>;
	try {
		answer = await session.getHls(
			url.searchParams.get('u'),
			`${castBaseUrl(event, params.sessionId)}/hls`,
			maxHeight,
			request.signal
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Could not fetch the live stream';
		console.warn(`cast: live HLS for ${session.videoId} failed:`, message);
		throw error(502, message);
	}

	if ('playlist' in answer) {
		return new Response(answer.playlist, {
			headers: {
				'content-type': 'application/vnd.apple.mpegurl',
				// A live playlist changes every couple of seconds.
				'cache-control': 'no-store',
				...castCorsHeaders
			}
		});
	}

	const { media } = answer;

	return new Response(media.body, {
		status: media.status,
		headers: {
			'content-type': media.headers.get('content-type') ?? 'video/mp2t',
			...(media.headers.get('content-length')
				? { 'content-length': media.headers.get('content-length') as string }
				: {}),
			'cache-control': 'no-store',
			...castCorsHeaders
		}
	});
}

export async function OPTIONS() {
	return new Response(null, { status: 204, headers: castCorsHeaders });
}
