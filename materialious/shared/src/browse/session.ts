import { USER_AGENT } from 'bgutils-js/utils';
import { Innertube, Platform, UniversalCache } from 'youtubei.js';
import type { Types } from 'youtubei.js';

Platform.shim.eval = async (data: Types.BuildScriptResult) => new Function(data.output)();

/**
 * A shared InnerTube session for browsing.
 *
 * Unlike playback this needs no PO token, so it costs nothing to keep one
 * around; minting a session per request would add seconds to every screen the
 * television draws.
 */
const SESSION_TTL_MS = 60 * 60 * 1000;

let cached: { innertube: Innertube; createdAt: number } | undefined;
let pending: Promise<Innertube> | undefined;

export async function getBrowseSession(cacheDir?: string): Promise<Innertube> {
	if (cached && Date.now() - cached.createdAt < SESSION_TTL_MS) {
		return cached.innertube;
	}

	if (pending) return pending;

	pending = (async () => {
		const innertube = await Innertube.create({
			fetch,
			cache: new UniversalCache(true, cacheDir),
			user_agent: USER_AGENT
		});

		cached = { innertube, createdAt: Date.now() };
		pending = undefined;

		return innertube;
	})();

	try {
		return await pending;
	} catch (error) {
		pending = undefined;
		throw error;
	}
}
