import { getFeed } from '$lib/api/index';
import type { Feed, PlaylistPageVideo, Video, VideoBase } from '$lib/api/model';
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
 * Folds a freshly fetched feed into whatever is already on screen.
 *
 * Kept in one place because the difference between replacing the list and
 * adding to it is the difference between a screen that keeps up and one that
 * quietly stops, and there are three callers.
 */
async function remember(feed: Feed): Promise<void> {
	const showing = get(feedCacheStore).subscription ?? [];
	const merged = await sortVideosByFavourites([...feed.notifications, ...feed.videos, ...showing]);

	feedCacheStore.set({
		...get(feedCacheStore),
		subscription: excludeDuplicateFeeds(showing, merged) as supportedVideos
	});
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

		await remember(feed);

		if (feed.partial && attempt < PARTIAL_ATTEMPTS) askAgainShortly(attempt + 1);
	}, PARTIAL_RETRY_MS);
}

/** How long to leave the instance to finish, and how many times to look back. */
const PARTIAL_RETRY_MS = 4000;
const PARTIAL_ATTEMPTS = 2;

export async function load() {
	authProtected();

	const videos = get(feedCacheStore).subscription;

	if (!videos) {
		feedCacheStore.set({ ...get(feedCacheStore), subscription: [] });

		feedLoadingStore.set(true);
		getFeed(100, 1)
			.then(async (feed) => {
				await remember(feed);

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

		const feed = await getFeed(100, 1);
		await remember(feed);

		// An incomplete answer matters more here than above, not less. A screen
		// that is opened fresh each time gets another chance on the next visit;
		// one that is never closed - a television, left on the same screen for
		// days - has only ever been through this branch, so a channel the
		// instance had not gathered yet would stay missing until the
		// application was restarted.
		if (feed.partial) askAgainShortly();
	}
}
