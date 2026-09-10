import { getVideo } from '@materialious/shared/browse';
import { error, json } from '@sveltejs/kit';

export async function GET({ params, locals }) {
	if (!locals.userId) {
		throw error(401);
	}

	if (params.videoId.length !== 11) {
		throw error(400, 'Invalid video id');
	}

	try {
		return json(await getVideo(params.videoId));
	} catch (err) {
		throw error(502, err instanceof Error ? err.message : 'Could not load that video');
	}
}
