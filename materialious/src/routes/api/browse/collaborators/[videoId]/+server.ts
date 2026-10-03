import { getCollaborators, BROWSE_CONTRACT_VERSION } from '$lib/server/browse';
import { error, json } from '@sveltejs/kit';

/** A video id, as YouTube writes them. */
const VIDEO_ID = /^[\w-]{11}$/;

/**
 * The channels that made a video together.
 *
 * Asked for when somebody opens the list rather than carried on every feed
 * item: it is a watch page each, and nearly nobody opens it.
 */
export async function GET({ params, locals }) {
	if (!locals.userId) {
		throw error(401);
	}

	if (!VIDEO_ID.test(params.videoId)) {
		throw error(400, 'Invalid video id');
	}

	try {
		return json({
			collaborators: await getCollaborators(params.videoId),
			contract: BROWSE_CONTRACT_VERSION
		});
	} catch (err) {
		throw error(502, err instanceof Error ? err.message : 'Could not load who made that video');
	}
}
