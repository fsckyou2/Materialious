import { getChannel, BROWSE_CONTRACT_VERSION } from '$lib/server/browse';
import { error, json } from '@sveltejs/kit';

/** A channel id, as YouTube writes them. */
const CHANNEL_ID = /^UC[\w-]{22}$/;

export async function GET({ params, url, locals }) {
	if (!locals.userId) {
		throw error(401);
	}

	// The feed route has always checked this; this one passed anything through
	// to the parser and turned its complaint into a 502.
	if (!CHANNEL_ID.test(params.channelId)) {
		throw error(400, 'Invalid channel id');
	}

	const requested = url.searchParams.get('kind');
	const kind = requested === 'shorts' || requested === 'live' ? requested : 'videos';

	try {
		return json({
			...(await getChannel(params.channelId, kind)),
			contract: BROWSE_CONTRACT_VERSION
		});
	} catch (err) {
		throw error(502, err instanceof Error ? err.message : 'Could not load that channel');
	}
}
