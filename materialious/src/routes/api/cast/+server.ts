import { createCastSession } from '$lib/server/cast';
import { error, json } from '@sveltejs/kit';
import z from 'zod';
import { isOwnBackend } from '$lib/shared/index';
import { castBaseUrl } from '$lib/server/cast';

const zCastSchema = z.object({
	videoId: z.string().length(11),
	/**
	 * What the receiver can play besides DASH. A television that says "hls" is
	 * given YouTube's own HLS for a live stream, which plays smoothly where the
	 * gateway's DASH cannot keep up. Left out, everything is DASH as before.
	 */
	formats: z.array(z.string()).optional(),
	/**
	 * A receiver whose stream failed, asking for a new session rather than the
	 * one it had - which would hand back the same address that just failed.
	 */
	fresh: z.boolean().optional()
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

	const data = zCastSchema.safeParse(await request.json().catch(() => null));

	if (!data.success) {
		throw error(400, data.error.message);
	}

	let session;
	try {
		session = await createCastSession(data.data.videoId, locals.userId, {
			acceptsHls: data.data.formats?.includes('hls') === true,
			fresh: data.data.fresh === true
		});
	} catch (err) {
		// Said here as well as to the receiver, which may well not show it.
		console.warn(
			`cast: could not open ${data.data.videoId}:`,
			err instanceof Error ? err.message : err
		);
		throw error(500, err instanceof Error ? err.message : 'Failed to open a cast session');
	}

	const baseUrl = castBaseUrl(event, session.id);

	return json({
		sessionId: session.id,
		title: session.title,
		author: session.author,
		duration: session.durationSeconds,
		source: session.source,
		format: session.format,
		manifestUrl: session.format === 'hls' ? `${baseUrl}/hls` : `${baseUrl}/manifest`
	});
}
