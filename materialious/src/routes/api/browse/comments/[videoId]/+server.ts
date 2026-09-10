import { getComments } from '@materialious/shared/browse';
import { error, json } from '@sveltejs/kit';

/** Top comments on a video, for clients that cannot ask YouTube themselves. */
export async function GET({ params, locals }) {
	if (!locals.userId) {
		throw error(401);
	}

	if (params.videoId.length !== 11) {
		throw error(400, 'Invalid video id');
	}

	try {
		return json({ comments: await getComments(params.videoId) });
	} catch (err) {
		throw error(502, err instanceof Error ? err.message : 'Could not load comments');
	}
}
