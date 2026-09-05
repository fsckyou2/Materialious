import { createCastSession } from '@materialious/shared/cast';
import { error, json } from '@sveltejs/kit';
import z from 'zod';
import { isOwnBackend } from '$lib/shared/index';
import { castBaseUrl } from '$lib/server/cast';

const zCastSchema = z.object({
	videoId: z.string().length(11)
});

/**
 * Opens a cast session for a video and returns the URLs a receiver can fetch.
 *
 * This is the only cast route that requires the viewer's session cookie; the
 * gateway routes are reached by the Chromecast, which has no cookies and is
 * authorised by the unguessable session id alone.
 */
export async function POST(event) {
	const { request, locals } = event;

	if (isOwnBackend()?.requireAuth && !locals.userId) {
		throw error(401);
	}

	const data = zCastSchema.safeParse(await request.json());

	if (!data.success) {
		throw error(400, data.error.message);
	}

	let session;
	try {
		session = await createCastSession(data.data.videoId, locals.userId);
	} catch (err) {
		throw error(500, err instanceof Error ? err.message : 'Failed to open a cast session');
	}

	if (session.source === 'live') {
		throw error(501, 'Casting live streams is not supported yet');
	}

	const baseUrl = castBaseUrl(event, session.id);

	return json({
		sessionId: session.id,
		title: session.title,
		author: session.author,
		duration: session.durationSeconds,
		source: session.source,
		manifestUrl: `${baseUrl}/manifest`
	});
}
