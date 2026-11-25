import type { Innertube } from 'youtubei.js';

/**
 * Who this instance says it is to YouTube.
 *
 * Everything used to go out as bgutils-js's USER_AGENT, which is cut short
 * (no Chrome/ or Safari/, a missing space) and which YouTube could not place
 * as any browser: sessions made with it came back with no browserName. With
 * `Accept-Language: *`, RSS fetched as "node" and BotGuard run under Node's
 * own navigator, nothing this instance sent looked like a browser, and every
 * address it went out from was bot-flagged within hours (2026-11-01).
 *
 * One ordinary, current desktop Chrome, said the same way everywhere: the
 * InnerTube sessions, the proxy, the PO token minting and the feeds.
 */
export const BROWSER_USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

/** The headers that Chrome sends beside that user agent to every YouTube host. */
export const BROWSER_HEADERS: Readonly<Record<string, string>> = {
	'user-agent': BROWSER_USER_AGENT,
	'accept-language': 'en-US,en;q=0.9',
	'sec-ch-ua': '"Chromium";v="152", "Google Chrome";v="152", "Not)A;Brand";v="99"',
	'sec-ch-ua-mobile': '?0',
	'sec-ch-ua-platform': '"Windows"'
};

/** youtube.com, its video servers, and the Google hosts its pages call. */
export function isYouTubeOrGoogleHost(host: string): boolean {
	const name = host.toLowerCase().replace(/:\d+$/, '');

	return ['youtube.com', 'googlevideo.com', 'google.com', 'youtube-nocookie.com'].some(
		(domain) => name === domain || name.endsWith(`.${domain}`)
	);
}

/**
 * Sets the browser's headers on a request to YouTube, as if the page on
 * www.youtube.com had made it. A language the caller chose is kept; the
 * library's `*` is not one.
 */
export function asBrowser(headers: Headers): Headers {
	for (const [name, value] of Object.entries(BROWSER_HEADERS)) {
		if (name === 'accept-language') {
			const language = headers.get(name);
			if (language && language !== '*') continue;
		}

		headers.set(name, value);
	}

	headers.set('origin', 'https://www.youtube.com');
	headers.set('referer', 'https://www.youtube.com/');

	return headers;
}

/** `fetch`, with the browser's headers on anything bound for YouTube. */
export const browserLikeFetch: typeof fetch = (input, init) => {
	const url = new URL(input instanceof Request ? input.url : input.toString());
	if (!isYouTubeOrGoogleHost(url.host)) return fetch(input, init);

	const headers = asBrowser(
		new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
	);

	return fetch(input, { ...init, headers });
};

/**
 * How long the server's own YouTube visitor lasts.
 *
 * The server's sessions were kept on disk by the library and only replaced
 * when the library changed version, so one visitor - made on whatever address
 * the server had then, and naming that address in every request as its
 * remoteHost - went on being used from every address after it. A visitor made
 * on an address YouTube had flagged carried the flag to the next one.
 */
const SERVER_SESSION_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * A cache for youtubei.js that is kept in memory, and only there.
 *
 * The library's own `UniversalCache(false)` is not that: on Node it writes to
 * youtubei.js under the system's temp directory, one file shared by every
 * cache made that way and kept for as long as the container runs. Each
 * hour's "new" cache read the old visitor straight back, so the server went
 * on as one visitor for a week at a time, from every address WARP gave it,
 * and every address YouTube saw it at was soon flagged (2026-11-25).
 */
export class MemoryCache {
	readonly cache_dir = '';
	readonly #entries = new Map<string, ArrayBuffer>();

	async get(key: string): Promise<ArrayBuffer | undefined> {
		return this.#entries.get(key);
	}

	async set(key: string, value: ArrayBuffer): Promise<void> {
		this.#entries.set(key, value);
	}

	async remove(key: string): Promise<void> {
		this.#entries.delete(key);
	}
}

let serverCache: { cache: MemoryCache; createdAt: number; egress?: string } | undefined;

/**
 * The cache the server's InnerTube sessions share: in memory only, and
 * replaced with an empty one, and so a new visitor, every hour - and as soon
 * as the server is known to be going out from another network, so that a
 * visitor is never seen from two.
 */
export function serverSessionCache(): MemoryCache {
	const egress = currentEgress();
	const moved = !!serverCache?.egress && !!egress && !sameNetwork(serverCache.egress, egress);

	if (!serverCache || moved || Date.now() - serverCache.createdAt > SERVER_SESSION_MAX_AGE_MS) {
		serverCache = { cache: new MemoryCache(), createdAt: Date.now(), egress };
	} else if (!serverCache.egress) {
		serverCache.egress = egress;
	}

	return serverCache.cache;
}

let lastEgress: string | undefined;

/**
 * How long the address Cloudflare last reported is trusted. Sessions made as
 * Chrome are seldom told their remoteHost, and WARP's exit moves on its own
 * within a registration and is replaced by the watchdog, so an address heard
 * only from sessions went on being reported for weeks after it had gone.
 */
const EGRESS_CHECK_EVERY_MS = 5 * 60 * 1000;

let egressCheckedAt = 0;

/** Asks Cloudflare, which the server goes out through, where it is seen from. */
function checkEgress(): void {
	if (Date.now() - egressCheckedAt < EGRESS_CHECK_EVERY_MS) return;
	egressCheckedAt = Date.now();

	fetch('https://cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(5_000) })
		.then((response) => response.text())
		.then((trace) => {
			const seen = trace.match(/^ip=(.+)$/m)?.[1];
			if (seen) recordEgress(seen, 'Cloudflare');
		})
		.catch(() => {});
}

/**
 * The address the server was last seen at, if it has been: by Cloudflare,
 * checked again every few minutes, or by YouTube in a session's remoteHost.
 */
export function currentEgress(): string | undefined {
	checkEgress();
	return lastEgress;
}

/**
 * Notes the address a session says YouTube saw it at, and logs it when it is
 * a different network from the one before, so that when an address is
 * bot-flagged the log says which one and since when. A session read back from
 * the cache names the address it was made on, so a change shows up when the
 * next visitor is made.
 */
export function noteEgress(innertube: Innertube): void {
	const seen = innertube.session.context.client.remoteHost;
	if (seen) recordEgress(seen, 'YouTube');
	checkEgress();
}

function recordEgress(seen: string, by: string): void {
	if (seen === lastEgress) return;

	if (!lastEgress) {
		console.info(`[egress] ${by} sees this server at ${seen}`);
	} else if (!sameNetwork(seen, lastEgress)) {
		console.info(`[egress] ${by} now sees this server at ${seen} (was ${lastEgress})`);
	}

	lastEgress = seen;
}

function expandIPv6(address: string): string[] {
	const [head, tail] = address.toLowerCase().split('::');
	const left = head ? head.split(':') : [];
	const right = tail !== undefined && tail !== '' ? tail.split(':') : [];
	const missing = tail === undefined ? 0 : 8 - left.length - right.length;

	return [...left, ...Array(missing).fill('0'), ...right].map((group) =>
		group.replace(/^0+(?=.)/, '')
	);
}

/**
 * Whether two addresses are the same network as far as YouTube is concerned:
 * the same IPv4 address, or the same IPv6 /64. Addresses inside one /64 are
 * one household, and YouTube's own links are good across them.
 */
export function sameNetwork(a: string, b: string): boolean {
	if (!a.includes(':') || !b.includes(':')) return a === b;

	return expandIPv6(a).slice(0, 4).join(':') === expandIPv6(b).slice(0, 4).join(':');
}
