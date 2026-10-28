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
	// The library sends the cookies only with its API calls, so the session
	// was set up - its visitor identity, its configuration - anonymously, from
	// an address YouTube is asking to prove it is not a bot, and every signed-in
	// call after it came back "logged out". The website sends them with
	// everything for youtube.com, and is let through; so does this. Only
	// youtube.com: not the video servers, nor anything else.
	const signedInFetch: typeof fetch = (input, init) => {
		const url = new URL(input instanceof Request ? input.url : input.toString());
		const host = url.hostname.toLowerCase();
		if (host !== 'youtube.com' && !host.endsWith('.youtube.com')) return fetch(input, init);

		const headers = new Headers(
			init?.headers ?? (input instanceof Request ? input.headers : undefined)
		);
		headers.set('cookie', cookie);

		return fetch(input, { ...init, headers });
	};

	const create = (poToken?: string) =>
		Innertube.create({
			fetch: signedInFetch,
			cookie,
			// Its own cache: an anonymous session's visitor data must not end up
			// as part of an account's identity, nor the other way about.
			cache: new UniversalCache(false),
			enable_session_cache: false,
			user_agent: USER_AGENT,
			...(poToken ? { po_token: poToken } : {})
		});

	const probe = await create();

	// Which account the cookies are, from a page YouTube does not bot-check:
	// asking for the video itself without a token is exactly what it refuses,
	// and the refusal says nothing about who asked.
	const answer = await probe.actions.execute('/guide', { parse: false });

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
	console.log(
		`cast: signed-in session for ${videoId}: http ${answer.status_code},` +
			` loggedOut ${context?.loggedOut}, account id ${context?.datasyncId ? 'present' : 'absent'},` +
			` cookies [${names.join(', ')}]`
	);

	if (context?.loggedOut) {
		throw new Error('The saved YouTube account is signed out; save its cookies again');
	}

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
