import { getFeed } from '$lib/api/index';
import type { PlaylistPageVideo, Video, VideoBase } from '$lib/api/model';
import { localDb } from '$lib/dexie';
import { excludeDuplicateFeeds } from '$lib/feed';
import { authProtected } from '$lib/auth';
import { feedCacheStore, feedLoadingStore } from '$lib/store';
import { error } from '@sveltejs/kit';
import { get } from 'svelte/store';

type supportedVideos = (VideoBase | Video | PlaylistPageVideo)[];

async function sortVideosByFavourites(videos: supportedVideos): Promise<supportedVideos> {
	if (!window.indexedDB) return videos;

	const favouritedChannels = (await localDb.favouriteChannels.toArray()).map(
		(channel) => channel.channelId
	);

	if (favouritedChannels.length === 0) {
		return videos;
	}

	const regularVideos: supportedVideos = [];
	const favouriteVideos: supportedVideos = [];

	videos.forEach((video) => {
		if (favouritedChannels.includes(video.authorId)) {
			video.promotedBy = 'favourited';
			favouriteVideos.push(video);
		} else {
			regularVideos.push(video);
		}
	});

	return [...favouriteVideos, ...regularVideos];
}

/**
 * Fetches the feed once more, for an answer that came back incomplete.
 *
 * Bounded rather than "until complete": a channel that has been deleted is
 * missing for ever, and asking without end is how a screen ends up reloading
 * itself every few seconds.
 */
function askAgainShortly(attempt = 1) {
	setTimeout(async () => {
		const feed = await getFeed(100, 1).catch(() => null);
		if (!feed) return;

		const videos = await sortVideosByFavourites([...feed.notifications, ...feed.videos]);
		feedCacheStore.set({ ...get(feedCacheStore), subscription: videos });

		if (feed.partial && attempt < PARTIAL_ATTEMPTS) askAgainShortly(attempt + 1);
	}, PARTIAL_RETRY_MS);
}

/** How long to leave the instance to finish, and how many times to look back. */
const PARTIAL_RETRY_MS = 4000;
const PARTIAL_ATTEMPTS = 2;

export async function load() {
	authProtected();

	let videos = get(feedCacheStore).subscription;

	if (!videos) {
		feedCacheStore.set({ ...get(feedCacheStore), subscription: [] });

		feedLoadingStore.set(true);
		getFeed(100, 1)
			.then(async (feed) => {
				videos = await sortVideosByFavourites([...feed.notifications, ...feed.videos]);
				feedCacheStore.set({ ...get(feedCacheStore), subscription: videos });

				// The instance answered with the channels that were ready and is
				// still gathering the rest. Showing that immediately beats
				// waiting for everybody, but a feed quietly missing a few
				// channels is not where this should be left.
				if (feed.partial) askAgainShortly();
			})
			.catch((errorMsg) => {
				error(500, errorMsg);
			})
			.finally(() => {
				feedLoadingStore.set(false);
			});
	} else {
		feedLoadingStore.set(false);

		await getFeed(100, 1).then(async (feeds) => {
			const newVideos = await sortVideosByFavourites([
				...feeds.notifications,
				...feeds.videos,
				...videos
			]);
			feedCacheStore.set({
				...get(feedCacheStore),
				subscription: excludeDuplicateFeeds(videos, newVideos) as (
					| VideoBase
					| Video
					| PlaylistPageVideo
				)[]
			});
		});
	}
}
