import { getFeed } from '@materialious/shared/browse';
import { error, json } from '@sveltejs/kit';

/** How many channels one request may ask about. */
const MAX_CHANNELS = 40;

/**
 * The newest videos across a set of channels.
 *
 * Which channels those are comes from the client, because subscriptions are
 * encrypted with a key this server does not hold and so cannot be looked up
 * here.
 */
export async function POST({ request, locals }) {
	if (!locals.userId) {
		throw error(401);
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Expected a JSON body');
	}

	const channelIds = (body as { channelIds?: unknown })?.channelIds;

	if (!Array.isArray(channelIds) || channelIds.some((id) => typeof id !== 'string')) {
		throw error(400, 'channelIds must be a list of channel ids');
	}

	const requested = (channelIds as string[])
		.filter((id) => /^UC[\w-]{22}$/.test(id))
		.slice(0, MAX_CHANNELS);

	if (requested.length === 0) {
		return json({ videos: [] });
	}

	try {
		return json({ videos: await getFeed(requested) });
	} catch (err) {
		throw error(502, err instanceof Error ? err.message : 'Could not load the feed');
	}
}
