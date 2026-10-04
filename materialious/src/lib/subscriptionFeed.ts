import { getFeed } from '$lib/api/index';
import type { PlaylistPageVideo, Video, VideoBase } from '$lib/api/model';
import { localDb } from '$lib/dexie';
import { extractUniqueId } from '$lib/feed';
import { feedCacheStore, feedLoadingStore } from '$lib/store';
import { get } from 'svelte/store';

export type SupportedVideos = (VideoBase | Video | PlaylistPageVideo)[];

/**
 * How long to leave the instance to finish, and how many times to look back.
 *
 * An answer is also partial while channels it served from an old copy are
 * being fetched again, and opening the page after a while away can mean every
 * one of a hundred and sixty at once. Four looks is long enough for that to
 * land, and still bounded.
 */
const PARTIAL_RETRY_MS = 4000;
const PARTIAL_ATTEMPTS = 4;

/**
 * How long a screen can sit unseen before coming back to it asks for the
 * newest videos. A tab left open is never reloaded, so nothing else would.
 */
const STALE_AFTER_HIDDEN_MS = 5 * 60 * 1000;

/** How many videos one page of the feed holds. */
const FEED_PAGE_SIZE = 100;

/** The refresh in progress, so that two callers share one. */
let refreshing: Promise<void> | undefined;

/** When the feed was last asked for, to tell a glance away from an evening. */
let lastRefreshedAt = 0;

async function sortVideosByFavourites(videos: SupportedVideos): Promise<SupportedVideos> {
	if (!window.indexedDB) return videos;

	const favouritedChannels = (await localDb.favouriteChannels.toArray()).map(
		(channel) => channel.channelId
	);

	if (favouritedChannels.length === 0) {
		return videos;
	}

	const regularVideos: SupportedVideos = [];
	const favouriteVideos: SupportedVideos = [];

	videos.forEach((video) => {
		if (favouritedChannels.includes(video.authorId)) {
			video.promotedBy = 'favourited';
			favouriteVideos.push(video);
		} else {
			// Cleared rather than left: this runs over everything on screen on
			// every merge, so a channel that has since been unstarred would
			// otherwise keep its mark for as long as the page stayed open.
			delete video.promotedBy;
			regularVideos.push(video);
		}
	});

	return [...favouriteVideos, ...regularVideos];
}

/** When an item went up, for ordering. Anything undated sorts last. */
function publishedAt(item: SupportedVideos[number]): number {
	const published = 'published' in item ? item.published : 0;

	if (typeof published === 'number') return published;

	const parsed = Date.parse(published);

	return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

/** Newest first, and by id where two went up at the same moment. */
function newestFirst(a: SupportedVideos[number], b: SupportedVideos[number]): number {
	const difference = publishedAt(b) - publishedAt(a);
	if (difference !== 0) return difference;

	return extractUniqueId(a).localeCompare(extractUniqueId(b));
}

/**
 * Folds newly fetched videos into whatever is already on screen.
 *
 * Adding to the list rather than replacing it, so that a fetch which came back
 * short does not take away videos that were already there - but the result is
 * put back in order rather than simply stacked on one end. Both callers used
 * to concatenate: a refresh put its videos in front of the list and a further
 * page put its own behind it, so a feed ended up as a run of blocks, each in
 * order within itself and none of them in order against the others. Five
 * minutes ago, then two hours, then a day, then four hours.
 *
 * Where the same video arrives twice the newly fetched copy is the one kept:
 * it carries a fresher view count and, for anything recent, an exact date.
 */
async function remember(videos: SupportedVideos): Promise<void> {
	const showing = get(feedCacheStore).subscription ?? [];

	const byId = new Map<string, SupportedVideos[number]>();
	for (const video of [...videos, ...showing]) {
		const id = extractUniqueId(video);
		if (!byId.has(id)) byId.set(id, video);
	}

	feedCacheStore.set({
		...get(feedCacheStore),
		subscription: await sortVideosByFavourites([...byId.values()].sort(newestFirst))
	});
}

/**
 * Adds a further page of the feed to what is on screen.
 *
 * Kept here with the rest of it so that scrolling and refreshing cannot order
 * the same list two different ways.
 */
export async function addToSubscriptionFeed(videos: SupportedVideos): Promise<void> {
	await remember(videos);
}

/**
 * Fetches the feed once more, for an answer that came back incomplete.
 *
 * Bounded rather than "until complete": a channel that has been deleted is
 * missing for ever, and asking without end is how a screen ends up reloading
 * itself every few seconds.
 */
function askAgainShortly(attempt = 1): void {
	setTimeout(async () => {
		const feed = await getFeed(FEED_PAGE_SIZE, 1).catch(() => null);
		if (!feed) return;

		await remember([...feed.notifications, ...feed.videos]);

		if (feed.partial && attempt < PARTIAL_ATTEMPTS) askAgainShortly(attempt + 1);
	}, PARTIAL_RETRY_MS);
}

/**
 * Asks for the newest videos and shows whatever comes back.
 *
 * The instance gathers every subscribed channel behind a first-paint budget
 * and answers with whoever was ready, so an answer that arrives short is the
 * ordinary case rather than a fault, and is worth going back for.
 *
 * This is deliberately not tied to the page's `load`: somebody pressing the
 * logo while already looking at the feed is asking for exactly this, and the
 * router has nowhere to take them.
 */
export function refreshSubscriptionFeed(): Promise<void> {
	// The page's own load and a press on the logo can arrive together, and the
	// two of them asking separately would fetch the same feed twice.
	refreshing ??= (async () => {
		lastRefreshedAt = Date.now();

		const feed = await getFeed(FEED_PAGE_SIZE, 1);

		await remember([...feed.notifications, ...feed.videos]);

		if (feed.partial) askAgainShortly();
	})().finally(() => {
		refreshing = undefined;
	});

	return refreshing;
}

/**
 * Refreshes the feed when somebody comes back to a screen they left long
 * enough ago for it to be out of date.
 *
 * @returns a function that stops listening, for when the feed is closed.
 */
export function refreshWhenSeenAgain(): () => void {
	const onVisibilityChange = () => {
		if (document.visibilityState !== 'visible') return;
		if (Date.now() - lastRefreshedAt < STALE_AFTER_HIDDEN_MS) return;

		refreshSubscriptionFeed().catch(() => {
			// What is on screen stays, and the next look tries again.
		});
	};

	document.addEventListener('visibilitychange', onVisibilityChange);

	return () => document.removeEventListener('visibilitychange', onVisibilityChange);
}

/**
 * The same, for a screen that has nothing on it yet.
 *
 * Kept apart because this one has a spinner to run and an empty list to put in
 * place first, while a refresh leaves what is showing alone until it has
 * something better.
 */
export function loadSubscriptionFeed(onError: (reason: unknown) => void): void {
	feedCacheStore.set({ ...get(feedCacheStore), subscription: [] });
	feedLoadingStore.set(true);

	refreshSubscriptionFeed()
		.catch(onError)
		.finally(() => {
			feedLoadingStore.set(false);
		});
}
