import { getPublicEnv } from '$lib/misc';
import { interfaceRegionStore } from '$lib/store';
import { USER_AGENT } from 'bgutils-js/utils';
import { get } from 'svelte/store';
import Innertube, { UniversalCache } from 'youtubei.js';

let innertubeReady: Promise<Innertube> | undefined;

/**
 * How long one anonymous YouTube session is kept before starting another.
 *
 * The library keeps its session - visitor id, client version - in the browser
 * for good, and only replaces it when the library itself changes version. A
 * browser could present the same visitor for weeks, which is what YouTube's
 * "confirm you're not a bot" check looks for, and with an ageing client
 * version besides.
 */
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SESSION_STARTED_KEY = 'innertubeSessionStartedAt';

async function freshCache(): Promise<UniversalCache> {
	const cache = new UniversalCache(true);

	try {
		const startedAt = Number(localStorage.getItem(SESSION_STARTED_KEY) ?? 0);

		if (Date.now() - startedAt > SESSION_MAX_AGE_MS) {
			await cache.remove('innertube_session_data');
			localStorage.setItem(SESSION_STARTED_KEY, String(Date.now()));
		}
	} catch {
		// Without storage there is no lasting session to age out.
	}

	return cache;
}

export async function getInnertube(): Promise<Innertube> {
	// Opening a page asks for this from several places at once, and checking for
	// a finished session rather than one being built let every one of those
	// callers start a session of its own: each with its own visitor data and its
	// own player. It only happens while there is nothing to share yet, which is
	// the first page loaded, and it is the first page that then misbehaves.
	//
	// Hand out the session being built, so they all wait on the same one.
	innertubeReady ??= (async () =>
		Innertube.create({
			fetch: fetch,
			cache: await freshCache(),
			location: get(interfaceRegionStore),
			user_agent: USER_AGENT,
			player_id: getPublicEnv('PLAYER_ID')
		}))().catch((error) => {
		// A session that failed to build should not be handed to everyone after.
		innertubeReady = undefined;
		throw error;
	});

	return innertubeReady;
}
