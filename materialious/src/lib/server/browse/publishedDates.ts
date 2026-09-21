/**
 * When a channel's newest videos actually went up.
 *
 * The browse endpoints date a video in words - "1 day ago" covers everything
 * between one day and two - which is all YouTube's own pages need, because
 * they never put two channels in one list. A merged feed does: every video
 * uploaded yesterday arrives claiming the same age, so which of them lands on
 * the first page is settled by the order the channels happened to answer in,
 * and that is different on every request. The same video appears and
 * disappears between one look and the next.
 *
 * The feed YouTube publishes for every channel carries the real timestamp, for
 * the newest uploads - which is the part of a subscription feed anybody is
 * actually looking at.
 */

/** Upstream answers in well under a second; a feed should not wait on this. */
const TIMEOUT_MS = 4_000;

/**
 * One `<entry>` of the channel feed.
 *
 * Read with a pattern rather than a parser: the shape is fixed, only two of
 * its fields are wanted, and a dependency to reach them is not worth carrying.
 */
const ENTRY = /<entry>([\s\S]*?)<\/entry>/g;
const VIDEO_ID = /<yt:videoId>([\w-]+)<\/yt:videoId>/;
const PUBLISHED = /<published>([^<]+)<\/published>/;

/**
 * Upload times for as many of a channel's newest videos as its feed carries,
 * as milliseconds since the epoch.
 *
 * An empty map when the feed could not be read: dating a video precisely is an
 * improvement on the wording, not a replacement for it, and a channel whose
 * feed is missing should still appear.
 */
export async function publishedDates(channelId: string): Promise<Map<string, number>> {
	const dates = new Map<string, number>();

	let xml: string;
	try {
		const response = await fetch(
			`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`,
			{ signal: AbortSignal.timeout(TIMEOUT_MS) }
		);

		if (!response.ok) return dates;

		xml = await response.text();
	} catch {
		return dates;
	}

	for (const [, entry] of xml.matchAll(ENTRY)) {
		const videoId = entry.match(VIDEO_ID)?.[1];
		const published = entry.match(PUBLISHED)?.[1];
		if (!videoId || !published) continue;

		const at = Date.parse(published);
		if (Number.isFinite(at)) dates.set(videoId, at);
	}

	return dates;
}
