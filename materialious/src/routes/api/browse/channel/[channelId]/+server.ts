import { getChannel } from '@materialious/shared/browse';
import { error, json } from '@sveltejs/kit';

export async function GET({ params, locals }) {
	if (!locals.userId) {
		throw error(401);
	}

	try {
		return json(await getChannel(params.channelId));
	} catch (err) {
		throw error(502, err instanceof Error ? err.message : 'Could not load that channel');
	}
}
