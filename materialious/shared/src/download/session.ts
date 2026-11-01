import { Innertube, Platform } from 'youtubei.js';
import type { Types } from 'youtubei.js';
import {
	BROWSER_USER_AGENT,
	browserLikeFetch,
	noteEgress,
	serverSessionCache
} from '../identity.js';
import { mintPoTokenInJSDOM } from '../jsdom.js';

const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';

Platform.shim.eval = async (data: Types.BuildScriptResult) => new Function(data.output)();

export async function getDownloadSession(videoId: string): Promise<Innertube> {
	let poToken: string | undefined;

	try {
		poToken = await mintPoTokenInJSDOM(REQUEST_KEY, videoId);
	} catch (err) {
		console.warn('Failed to mint PO token for download session:', err);
	}

	const innertube = await Innertube.create({
		fetch: browserLikeFetch,
		cache: serverSessionCache(),
		user_agent: BROWSER_USER_AGENT,
		...(poToken ? { po_token: poToken } : {})
	});
	noteEgress(innertube);

	return innertube;
}
