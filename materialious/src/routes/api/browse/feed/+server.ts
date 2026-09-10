import { getFeed } from '@materialious/shared/browse';
import { error, json } from '@sveltejs/kit';

/**
 * How many channels one request may ask about.
 *
 * High enough to hold every subscription an account is likely to have: a feed
 * that quietly drops the rest is worse than a slow one, because the videos it
 * leaves out are invisible rather than late.
 */
const MAX_CHANNELS = 400;

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
		return json({ videos: [], hasMore: false });
	}

	const body_ = body as { offset?: unknown; limit?: unknown; kind?: unknown };
	const offset = Number(body_.offset ?? 0);
	const limit = Number(body_.limit ?? 60);
	const kind = body_.kind === 'shorts' || body_.kind === 'live' ? body_.kind : 'videos';

	try {
		return json(
			await getFeed(requested, {
				kind,
				offset: Number.isFinite(offset) ? offset : 0,
				limit: Number.isFinite(limit) ? Math.min(limit, 120) : 60
			})
		);
	} catch (err) {
		throw error(502, err instanceof Error ? err.message : 'Could not load the feed');
	}
}
