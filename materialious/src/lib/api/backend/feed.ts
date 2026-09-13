import { rawMasterKeyStore } from '$lib/store';
import { isOwnBackend } from '$lib/shared';
import { get } from 'svelte/store';
import type { Feed, Video } from '../model';
import { getSubscriptionsBackend } from './subscriptions';

/**
 * The subscription feed, built by the instance rather than by this browser.
 *
 * The older way is a YouTube RSS feed per channel, fetched here, kept in
 * IndexedDB and refreshed on a cooldown measured in hours - so a feed is as
 * fresh as whenever each channel last came up in the rotation, and says nothing
 * about a video's length or whether it is live, because RSS does not carry
 * either. A television has none of that machinery and asks the instance for a
 * merged feed instead, which is faster and more current, so the browser may as
 * well ask the same question.
 *
 * Which channels to gather still comes from here: the instance holds
 * subscriptions encrypted and cannot read them.
 *
 * @returns the feed, or null when this browser should fall back to the old way
 * - no instance of our own, no account key to decrypt subscriptions with, or an
 * instance that could not answer.
 */
export async function getFeedFromInstance(maxResults: number, page: number): Promise<Feed | null> {
	if (!isOwnBackend()?.internalAuth) return null;
	if (!get(rawMasterKeyStore)) return null;

	const subscriptions = await getSubscriptionsBackend();
	const channelIds = subscriptions.map((subscription) => subscription.channelId).filter(Boolean);

	if (channelIds.length === 0) return null;

	const ask = () =>
		fetch('/api/browse/feed', {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				channelIds,
				kind: 'videos',
				offset: Math.max(0, (page - 1) * maxResults),
				limit: maxResults
			})
		});

	let response: Response;
	try {
		response = await ask();
	} catch {
		return null;
	}

	if (!response.ok) return null;

	const answered = (await response.json()) as {
		videos?: InstanceVideo[];
		partial?: boolean;
	};

	return {
		notifications: [],
		videos: (answered.videos ?? []).map(toVideo),
		partial: answered.partial === true
	};
}

/** One video, as the instance's browse endpoints describe it. */
type InstanceVideo = {
	videoId: string;
	title: string;
	author: string;
	authorId: string;
	lengthSeconds: number;
	viewCountText: string;
	type: Video['type'];
	publishedText: string;
	publishedSecondsAgo: number | null;
	thumbnail: string | null;
	liveNow: boolean;
};

function toVideo(video: InstanceVideo): Video {
	const now = Math.floor(Date.now() / 1000);

	return {
		type: video.type,
		videoId: video.videoId,
		title: video.title,
		// One picture, already chosen, at the size YouTube serves it.
		videoThumbnails: video.thumbnail ? [{ url: video.thumbnail, width: 720, height: 404 }] : [],
		author: video.author,
		authorId: video.authorId,
		authorUrl: video.authorId ? `/channel/${video.authorId}` : '',
		authorVerified: false,
		lengthSeconds: video.lengthSeconds,
		viewCountText: video.viewCountText,
		description: '',
		descriptionHtml: '',
		// Feeds carry an age in words, so this is that read back out - near
		// enough to sort by, which is all anything uses it for.
		published: video.publishedSecondsAgo === null ? now : now - video.publishedSecondsAgo,
		publishedText: video.publishedText,
		liveNow: video.liveNow,
		premium: false,
		isUpcoming: false
	};
}
