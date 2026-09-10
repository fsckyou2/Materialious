import { continuePage } from '@materialious/shared/browse';
import { error, json } from '@sveltejs/kit';

/**
 * The next page of a search or a channel.
 *
 * The token comes from whatever produced the previous page. It is spent on use:
 * a page is handed out once, and the next token comes back with it.
 */
export async function GET({ url, locals }) {
	if (!locals.userId) {
		throw error(401);
	}

	const token = url.searchParams.get('token');
	if (!token) {
		throw error(400, 'A continuation token is required');
	}

	try {
		return json(await continuePage(token));
	} catch (err) {
		throw error(502, err instanceof Error ? err.message : 'Could not load more');
	}
}
