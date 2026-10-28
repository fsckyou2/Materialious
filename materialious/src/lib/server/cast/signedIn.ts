import { mintPoTokenInJSDOM } from '@materialious/shared/jsdom';
import { USER_AGENT } from 'bgutils-js/utils';
import { Innertube, UniversalCache } from 'youtubei.js';

/** The same request key the anonymous download session mints with. */
const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';

/**
 * A playback session signed in as somebody's own YouTube account, for a video
 * YouTube will not play to nobody in particular.
 *
 * YouTube has taken to answering this instance's address with "Sign in to
 * confirm you're not a bot" for most videos, and lets a signed-in account
 * through. A television has the account's saved cookies and hands them over
 * when it starts a video; they are used for that video's session and kept for
 * nothing else, and never written anywhere.
 *
 * The playback token has to be bound to the account rather than to the video,
 * or the streaming server refuses it: the account's id comes back in the first
 * answer it gets, so it asks once without a token to learn it, then again with
 * one.
 */
export async function getSignedInSession(cookie: string, videoId: string): Promise<Innertube> {
	const create = (poToken?: string) =>
		Innertube.create({
			fetch,
			cookie,
			// Its own cache: an anonymous session's visitor data must not end up
			// as part of an account's identity, nor the other way about.
			cache: new UniversalCache(false),
			enable_session_cache: false,
			user_agent: USER_AGENT,
			...(poToken ? { po_token: poToken } : {})
		});

	const probe = await create();

	const answer = await probe.actions.execute('/player', {
		videoId,
		contentCheckOk: true,
		racyCheckOk: true,
		parse: false
	});

	const data = (typeof answer.data === 'string' ? JSON.parse(answer.data) : answer.data) as {
		responseContext?: { mainAppWebResponseContext?: { datasyncId?: string; loggedOut?: boolean } };
	};

	const context = data?.responseContext?.mainAppWebResponseContext;

	// What the account looked like to YouTube, for when it is not what was
	// expected. Names only: the values are the account.
	const names = cookie
		.split(';')
		.map((pair) => pair.split('=')[0].trim())
		.filter(Boolean);
	const playability = (data as { playabilityStatus?: { status?: string; reason?: string } })
		?.playabilityStatus;
	console.log(
		`cast: signed-in probe for ${videoId}: http ${answer.status_code},` +
			` loggedOut ${context?.loggedOut}, account id ${context?.datasyncId ? 'present' : 'absent'},` +
			` playability ${playability?.status} ${playability?.reason ?? ''},` +
			` cookies [${names.join(', ')}], logged_in ${probe.session.logged_in}`
	);

	// Written "<account>||<delegated account>", where only the first is wanted.
	const binding = context?.datasyncId?.split('||')[0] || videoId;

	let poToken: string | undefined;
	try {
		poToken = await mintPoTokenInJSDOM(REQUEST_KEY, binding);
	} catch (error) {
		console.warn(
			'cast: could not mint a token for a signed-in session:',
			error instanceof Error ? error.message : error
		);
	}

	return poToken ? create(poToken) : probe;
}
