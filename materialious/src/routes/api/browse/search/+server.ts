import { search, BROWSE_CONTRACT_VERSION } from '$lib/server/browse';
import { error, json } from '@sveltejs/kit';

/**
 * Search, for clients that cannot run youtubei.js themselves.
 *
 * Reachable by a session cookie or a paired television's token, both of which
 * arrive as `locals.userId`.
 */
export async function GET({ url, locals }) {
	if (!locals.userId) {
		throw error(401);
	}

	const query = url.searchParams.get('q')?.trim();
	if (!query) {
		throw error(400, 'A search query is required');
	}

	const type = url.searchParams.get('type') === 'channel' ? 'channel' : 'video';

	try {
		return json({ ...(await search(query, type)), contract: BROWSE_CONTRACT_VERSION });
	} catch (err) {
		throw error(502, err instanceof Error ? err.message : 'Search failed');
	}
}
