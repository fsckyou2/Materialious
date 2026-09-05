import { getCastSession } from '@materialious/shared/cast';
import { error } from '@sveltejs/kit';
import { parse as tldParse } from 'tldts';
import { castCorsHeaders } from '$lib/server/cast';

/**
 * Fetches a caption track on the receiver's behalf.
 *
 * Subtitle URLs in the manifest point at YouTube, which a Chromecast cannot
 * read cross-origin. Only YouTube's own hosts are allowed through, so a cast
 * session id can't be turned into a general purpose proxy.
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

	let captionUrl: URL;
	try {
		captionUrl = new URL(target);
	} catch {
		throw error(400, 'Invalid caption url');
	}

	if (tldParse(captionUrl.host).domain !== 'youtube.com') {
		throw error(400, 'Caption url is not whitelisted');
	}

	const response = await fetch(captionUrl, { signal: AbortSignal.timeout(10000) });

	if (!response.ok) {
		throw error(response.status, 'Failed to fetch captions');
	}

	return new Response(response.body, {
		headers: {
			'content-type': response.headers.get('content-type') ?? 'text/vtt',
			'cache-control': 'no-store',
			...castCorsHeaders
		}
	});
}

export async function OPTIONS() {
	return new Response(null, { status: 204, headers: castCorsHeaders });
}
