import { recentChannelFailures, BROWSE_CONTRACT_VERSION } from '$lib/server/browse';
import { error, json } from '@sveltejs/kit';

/**
 * The channels this instance could not fetch, and what they said.
 *
 * A feed that is quietly short is the only symptom of a subscription that no
 * longer resolves - a channel deleted, or renamed to a handle this account
 * never updated - and the reason lives for a moment inside the instance and
 * nowhere else. This is that, kept for whoever is signed in to look at.
 */
export async function GET({ locals }) {
	if (!locals.userId) {
		throw error(401);
	}

	return json({
		failures: recentChannelFailures(),
		contract: BROWSE_CONTRACT_VERSION
	});
}
