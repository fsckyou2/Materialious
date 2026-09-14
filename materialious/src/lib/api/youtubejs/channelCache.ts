import type { YT } from 'youtubei.js';
import { getInnertube } from '.';

/**
 * Opening a channel asks YouTube for it twice: once for the channel itself and
 * again inside the request for its content, which has to have the channel in
 * hand before it can read a tab. Both requests are the same, and the second
 * cannot start until the first has finished, so the page waits out two round
 * trips for one piece of information. Opening a video asks for a third, to read
 * the author's avatar.
 *
 * Hold a channel for a short while after fetching it, and share a request that
 * is already on its way, so a channel is asked for once however many callers
 * want it. Requesting a tab builds a new channel from a fresh page rather than
 * changing the one it was called on, so a held channel stays good to hand out.
 */
const RETAIN_FOR_MS = 30_000;

const inFlight = new Map<string, Promise<YT.Channel>>();
const retained = new Map<string, { fetchedAt: number; channel: YT.Channel }>();

function forget(before: number): void {
	for (const [channelId, held] of retained) {
		if (held.fetchedAt < before) retained.delete(channelId);
	}
}

export async function getChannelCached(channelId: string): Promise<YT.Channel> {
	const now = Date.now();
	forget(now - RETAIN_FOR_MS);

	const held = retained.get(channelId);
	if (held) return held.channel;

	const alreadyAsked = inFlight.get(channelId);
	if (alreadyAsked) return alreadyAsked;

	const innertube = await getInnertube();

	const request = innertube
		.getChannel(channelId)
		.then((channel) => {
			retained.set(channelId, { fetchedAt: Date.now(), channel });
			return channel;
		})
		.finally(() => inFlight.delete(channelId));

	inFlight.set(channelId, request);

	return request;
}
