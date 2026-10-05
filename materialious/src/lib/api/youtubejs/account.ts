import { getPublicEnv } from '$lib/misc';
import { interfaceRegionStore, youtubeCookieStore } from '$lib/store';
import { Capacitor } from '@capacitor/core';
import { USER_AGENT } from 'bgutils-js/utils';
import { get } from 'svelte/store';
import Innertube, { UniversalCache, YTNodes } from 'youtubei.js';

/**
 * The cookies a signed-in session is made of, out of everything a browser
 * keeps for youtube.com. The rest is preferences and tracking, and leaving it
 * out keeps what is stored small enough to fit an encrypted setting.
 */
const SESSION_COOKIES = new Set([
	'SID',
	'HSID',
	'SSID',
	'APISID',
	'SAPISID',
	'__Secure-1PSID',
	'__Secure-3PSID',
	'__Secure-1PAPISID',
	'__Secure-3PAPISID',
	'__Secure-1PSIDTS',
	'__Secure-3PSIDTS',
	'__Secure-1PSIDCC',
	'__Secure-3PSIDCC',
	'SIDCC',
	'LOGIN_INFO'
]);

function isYouTubeDomain(domain: string): boolean {
	const host = domain.replace(/^\./, '').toLowerCase();
	return host === 'youtube.com' || host.endsWith('.youtube.com');
}

/**
 * Reads the youtube.com cookies out of whatever a cookie exporter produced:
 * a Netscape cookies.txt, the JSON most browser extensions write, or a plain
 * `name=value; name=value` header. Only the cookies of the session are kept.
 *
 * @returns the cookies as one header, or an empty string when there is no
 * signed-in session among them.
 */
export function parseYouTubeCookies(text: string): string {
	const found = new Map<string, string>();
	const keep = (name: string, value: string) => {
		if (SESSION_COOKIES.has(name) && value) found.set(name, value);
	};

	const trimmed = text.trim();

	if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
		try {
			const parsed = JSON.parse(trimmed);
			const cookies: { domain?: string; name?: string; value?: string }[] = Array.isArray(parsed)
				? parsed
				: (parsed.cookies ?? []);

			for (const cookie of cookies) {
				if (cookie.domain && !isYouTubeDomain(cookie.domain)) continue;
				if (cookie.name && cookie.value) keep(cookie.name, cookie.value);
			}
		} catch {
			// Not JSON after all; fall through to the other shapes.
		}
	}

	if (found.size === 0) {
		for (const line of trimmed.split(/\r?\n/)) {
			// A cookies.txt line is seven fields separated by tabs, the domain
			// first and the name and value last. "#HttpOnly_" marks some of them.
			const fields = line.replace(/^#HttpOnly_/, '').split('\t');
			if (fields.length >= 7 && !line.startsWith('# ')) {
				if (isYouTubeDomain(fields[0])) keep(fields[5], fields[6].trim());
			}
		}
	}

	if (found.size === 0) {
		for (const pair of trimmed.split(';')) {
			const at = pair.indexOf('=');
			if (at > 0) keep(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
		}
	}

	// SAPISID is what every signed-in request is signed with.
	if (!found.has('SAPISID') && !found.has('__Secure-3PAPISID')) return '';

	return [...found].map(([name, value]) => `${name}=${value}`).join('; ');
}

/**
 * The header the cookies travel to the proxy in.
 *
 * A page cannot send a Cookie header - the browser drops it without a word -
 * so they go under a name of their own and the proxy puts them back. The
 * Android app's proxy already had one for this.
 */
const COOKIE_HEADER =
	Capacitor.getPlatform() === 'android' ? '__sid_auth' : 'x-materialious-youtube-cookie';

function isYouTubeUrl(url: string): boolean {
	try {
		return isYouTubeDomain(new URL(url).hostname);
	} catch {
		return false;
	}
}

/**
 * A fetch that carries the session's cookies to YouTube itself, and nowhere
 * else: not to the servers video comes from, nor anything that is not
 * YouTube's.
 */
function fetchSignedIn(cookie: string): typeof fetch {
	return (input, init) => {
		const url = input instanceof Request ? input.url : input.toString();
		if (!isYouTubeUrl(url)) return globalThis.fetch(input, init);

		const headers = new Headers(
			init?.headers ?? (input instanceof Request ? input.headers : undefined)
		);
		headers.set(COOKIE_HEADER, cookie);

		return globalThis.fetch(input, { ...init, headers });
	};
}

function createSignedIn(cookie: string): Promise<Innertube> {
	return Innertube.create({
		fetch: fetchSignedIn(cookie),
		cookie,
		// Kept apart from the anonymous session's cache, which holds its
		// visitor data: the two must not end up as one identity.
		cache: new UniversalCache(false),
		enable_session_cache: false,
		location: get(interfaceRegionStore),
		user_agent: USER_AGENT,
		player_id: getPublicEnv('PLAYER_ID')
	});
}

let signedIn: { cookie: string; ready: Promise<Innertube> } | undefined;

/**
 * A session signed in as the saved account, or undefined when there is none.
 *
 * Only asked for when YouTube refuses to play something to nobody in
 * particular. Everything else is still watched anonymously, so the account
 * sees no more than it has to.
 */
export async function getSignedInInnertube(): Promise<Innertube | undefined> {
	const cookie = get(youtubeCookieStore);
	if (!cookie) return undefined;

	if (signedIn?.cookie !== cookie) {
		const ready = createSignedIn(cookie).catch((error) => {
			if (signedIn?.ready === ready) signedIn = undefined;
			throw error;
		});

		signedIn = { cookie, ready };
	}

	return signedIn.ready;
}

/**
 * Which account a set of cookies signs in as, to show that they work before
 * anything relies on them.
 *
 * @returns the account's name, or undefined when YouTube does not consider
 * them signed in.
 */
export async function accountNameFor(cookie: string): Promise<string | undefined> {
	const innertube = await createSignedIn(cookie);
	const accounts = await innertube.account.getInfo(true);

	const items = Array.isArray(accounts) ? accounts : [];
	const account =
		items.find((item) => item.is(YTNodes.AccountItem) && item.is_selected) ?? items[0];

	return account?.account_name?.toString() || undefined;
}
