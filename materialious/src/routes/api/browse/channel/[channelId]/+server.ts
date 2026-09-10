import { getChannel } from '@materialious/shared/browse';
import { error, json } from '@sveltejs/kit';

export async function GET({ params, url, locals }) {
	if (!locals.userId) {
		throw error(401);
	}

	const requested = url.searchParams.get('kind');
	const kind = requested === 'shorts' || requested === 'live' ? requested : 'videos';

	try {
		return json(await getChannel(params.channelId, undefined, kind));
	} catch (err) {
		throw error(502, err instanceof Error ? err.message : 'Could not load that channel');
	}
}
