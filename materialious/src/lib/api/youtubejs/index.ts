import { getPublicEnv } from '$lib/misc';
import { interfaceRegionStore } from '$lib/store';
import { USER_AGENT } from 'bgutils-js/utils';
import { get } from 'svelte/store';
import Innertube, { UniversalCache } from 'youtubei.js';

let innertubeReady: Promise<Innertube> | undefined;

export async function getInnertube(): Promise<Innertube> {
	// Opening a page asks for this from several places at once, and checking for
	// a finished session rather than one being built let every one of those
	// callers start a session of its own: each with its own visitor data and its
	// own player. It only happens while there is nothing to share yet, which is
	// the first page loaded, and it is the first page that then misbehaves.
	//
	// Hand out the session being built, so they all wait on the same one.
	innertubeReady ??= Innertube.create({
		fetch: fetch,
		cache: new UniversalCache(true),
		location: get(interfaceRegionStore),
		user_agent: USER_AGENT,
		player_id: getPublicEnv('PLAYER_ID')
	}).catch((error) => {
		// A session that failed to build should not be handed to everyone after.
		innertubeReady = undefined;
		throw error;
	});

	return innertubeReady;
}
