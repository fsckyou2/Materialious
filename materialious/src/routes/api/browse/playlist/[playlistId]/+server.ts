import { getPlaylist, BROWSE_CONTRACT_VERSION } from '$lib/server/browse';
import { error, json } from '@sveltejs/kit';

export async function GET({ params, locals }) {
	if (!locals.userId) {
		throw error(401);
	}

	// Playlist ids are longer and less uniform than video ids, so this is a
	// sanity check rather than a format: what makes it safe is that it only
	// ever reaches YouTube's own lookup.
	if (params.playlistId.length < 2 || params.playlistId.length > 64) {
		throw error(400, 'Invalid playlist id');
	}

	try {
		return json({
			...(await getPlaylist(params.playlistId)),
			contract: BROWSE_CONTRACT_VERSION
		});
	} catch (err) {
		throw error(502, err instanceof Error ? err.message : 'Could not load that playlist');
	}
}
