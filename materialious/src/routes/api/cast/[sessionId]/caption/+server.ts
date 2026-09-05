import { getCastSession } from '@materialious/shared/cast';
import { error } from '@sveltejs/kit';
import { castCorsHeaders } from '$lib/server/cast';

/**
 * Fetches a caption track on the receiver's behalf.
 *
 * Subtitle URLs in the manifest point at YouTube, which a Chromecast cannot
 * read cross-origin.
 */
export async function GET({ params, url }) {
	const session = getCastSession(params.sessionId);
	if (!session) {
		throw error(404, 'Cast session not found or expired');
	}

	const target = url.searchParams.get('url');
	if (!target) {
		throw error(400, 'Missing caption url');
	}

	let captions: string;
	try {
		captions = await session.getCaption(target);
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Failed to fetch captions';
		console.warn('Cast caption fetch failed:', message);
		throw error(502, message);
	}

	return new Response(captions, {
		headers: {
			'content-type': 'text/vtt',
			'cache-control': 'no-store',
			...castCorsHeaders
		}
	});
}

export async function OPTIONS() {
	return new Response(null, { status: 204, headers: castCorsHeaders });
}
