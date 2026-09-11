import { JSDOM } from 'jsdom';

import { fetchInnerTubeChallenge, mintPoToken } from './poToken.js';

/**
 * Minting a PO token means running YouTube's BotGuard interpreter, and that
 * script expects a browser: it reads `window`, `document` and `location` off
 * the global object. There is one global object per process, so borrowing it
 * has to be done one caller at a time and handed back afterwards - a server
 * left with a `window` defined answers every later `typeof window` check as if
 * it were a browser, and a JSDOM window left open keeps its timers running.
 */
const BORROWED = ['window', 'document', 'location', 'origin', 'yt'] as const;

type Borrowed = { key: string; had: boolean; value: unknown };

function borrow(keys: readonly string[]): Borrowed[] {
	return keys.map((key) => ({
		key,
		had: Object.prototype.hasOwnProperty.call(globalThis, key),
		value: (globalThis as Record<string, unknown>)[key]
	}));
}

function giveBack(saved: Borrowed[]): void {
	for (const { key, had, value } of saved) {
		try {
			if (had) {
				(globalThis as Record<string, unknown>)[key] = value;
			} else {
				delete (globalThis as Record<string, unknown>)[key];
			}
		} catch {
			// A global someone else pinned down. Nothing useful to do about it.
		}
	}
}

/** One mint at a time, so two callers cannot fight over the globals. */
let queue: Promise<unknown> = Promise.resolve();

export function mintPoTokenInJSDOM(requestKey: string, visitorData: string): Promise<string> {
	const run = queue.then(
		() => mint(requestKey, visitorData),
		() => mint(requestKey, visitorData)
	);
	queue = run.catch(() => undefined);
	return run;
}

async function mint(requestKey: string, visitorData: string): Promise<string> {
	const youtubeUrl = 'https://www.youtube.com/';

	const dom = new JSDOM(
		'<!DOCTYPE html><html lang="en"><head><title>YouTube</title></head><body></body></html>',
		{
			url: youtubeUrl,
			referrer: youtubeUrl
		}
	);

	const { ytConfig, challengeResponse, interpreterJavascript } = await fetchInnerTubeChallenge();

	// The interpreter hangs its entry point off the global object under a name
	// the challenge picks, so that one has to be given back as well.
	const globalName = challengeResponse.bgChallenge?.globalName;
	const saved = borrow(globalName ? [...BORROWED, globalName] : BORROWED);

	try {
		Object.assign(globalThis, {
			window: dom.window,
			document: dom.window.document,
			location: dom.window.location,
			origin: dom.window.origin
		});

		if (!Reflect.has(globalThis, 'navigator')) {
			Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator });
		}

		dom.window.yt = { config_: JSON.parse(ytConfig) };
		Object.assign(globalThis, { yt: dom.window.yt });

		new Function(interpreterJavascript)();

		return await mintPoToken(requestKey, visitorData, challengeResponse);
	} finally {
		giveBack(saved);
		dom.window.close();
	}
}
