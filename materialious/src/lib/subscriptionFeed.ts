import { getFeed } from '$lib/api/index';
import type { PlaylistPageVideo, Video, VideoBase } from '$lib/api/model';
import { localDb } from '$lib/dexie';
import { extractUniqueId } from '$lib/feed';
import { feedCacheStore, feedLoadingStore } from '$lib/store';
import { get, writable } from 'svelte/store';

export type SupportedVideos = (VideoBase | Video | PlaylistPageVideo)[];

/**
 * How long to leave the instance to finish before each look back.
 *
 * An answer is also partial while channels it served from an old copy are
 * being fetched again - after a refresh, every one of them, which the instance
 * does a few at a time so YouTube does not refuse it. Looking back is a read of
 * what it has in memory, so it is cheap to do often: the first looks come
 * quickly, so channels show up as they land rather than in a few big jumps
 * seconds apart, and they spread out over most of a minute and then stop.
 */
const PARTIAL_RETRY_DELAYS_MS = [
	1500, 1500, 2000, 2000, 3000, 3000, 3000, 4000, 4000, 5000, 5000, 8000, 8000, 8000
];

/**
 * How old a channel may be when somebody asks for a refresh: anything older is
 * fetched again. The instance does not go lower than this either.
 */
const REFRESH_FRESH_WITHIN_SECONDS = 60;

/**
 * Where the top of the feed is kept between visits, so that opening the page
 * shows it at once rather than a spinner, and the newest is folded in when it
 * arrives. This browser's only, and only the first screenful or so.
 */
const SNAPSHOT_KEY = 'subscriptionFeedSnapshot';
const SNAPSHOT_SIZE = 60;

/**
 * Whether the feed is being gathered: from the first request until the
 * instance says the answer is whole, or this gives up asking.
 */
export const feedRefreshingStore = writable(false);

/**
 * Bumped by every refresh, so that the looks back still scheduled by an older
 * one stop rather than run alongside the new one's.
 */
let generation = 0;

/** What is on screen only because the last visit left it, until confirmed. */
let provisional: Set<string> | undefined;

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

	const liveVideos: SupportedVideos = [];

	videos.forEach((video) => {
		// On now, so ahead even of starred channels: a starred channel's
		// streams from last week used to sit above one that was live.
		if (isLiveNow(video)) {
			liveVideos.push(video);
		} else if (favouritedChannels.includes(video.authorId)) {
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

	return [...liveVideos, ...favouriteVideos, ...regularVideos];
}

/** Being streamed right now, which only this instance's own feed says. */
function isLiveNow(item: SupportedVideos[number]): boolean {
	return 'liveNow' in item && item.liveNow === true;
}

/** When an item went up, for ordering. Anything undated sorts last. */
function publishedAt(item: SupportedVideos[number]): number {
	const published = 'published' in item ? item.published : 0;

	if (typeof published === 'number') return published;

	const parsed = Date.parse(published);

	return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

/**
 * Live now first, then newest first, and by id where two went up at the same
 * moment. A stream in progress has no upload time at all, and would otherwise
 * sort last of everything.
 */
function newestFirst(a: SupportedVideos[number], b: SupportedVideos[number]): number {
	if (isLiveNow(a) !== isLiveNow(b)) return isLiveNow(a) ? -1 : 1;

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
async function remember(videos: SupportedVideos, complete = false): Promise<void> {
	let showing = get(feedCacheStore).subscription ?? [];

	// What was put up from the last visit stays only until a whole answer says
	// what the feed is now: otherwise a video since deleted, or from a channel
	// since unsubscribed from, would be carried from visit to visit for ever.
	if (complete && provisional) {
		const current = new Set(videos.map(extractUniqueId));
		const kept = provisional;

		showing = showing.filter((video) => {
			const id = extractUniqueId(video);
			return !kept.has(id) || current.has(id);
		});

		provisional = undefined;
	}

	const byId = new Map<string, SupportedVideos[number]>();
	for (const video of [...videos, ...showing]) {
		const id = extractUniqueId(video);
		if (!byId.has(id)) byId.set(id, video);
	}

	const subscription = await sortVideosByFavourites([...byId.values()].sort(newestFirst));

	feedCacheStore.set({ ...get(feedCacheStore), subscription });

	try {
		localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(subscription.slice(0, SNAPSHOT_SIZE)));
	} catch {
		// Full, or turned off: the next visit shows a spinner, as it always did.
	}
}

/**
 * Puts the feed from the last visit on screen, if this browser kept one.
 *
 * @returns whether there was one to show.
 */
export function showLastFeed(): boolean {
	let saved: SupportedVideos | null;

	try {
		saved = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) ?? 'null');
	} catch {
		return false;
	}

	if (!Array.isArray(saved) || saved.length === 0) return false;

	feedCacheStore.set({ ...get(feedCacheStore), subscription: saved });
	provisional = new Set(saved.map(extractUniqueId));

	return true;
}

/** Forgets the feed kept between visits, for somebody signing out. */
export function forgetLastFeed(): void {
	try {
		localStorage.removeItem(SNAPSHOT_KEY);
	} catch {
		// Nothing kept, or nothing reachable: either way nothing to forget.
	}
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
function askAgainShortly(asOf: number, attempt = 0): void {
	const delay = PARTIAL_RETRY_DELAYS_MS[attempt];

	if (delay === undefined) {
		feedRefreshingStore.set(false);
		return;
	}

	setTimeout(async () => {
		if (asOf !== generation) return;

		const feed = await getFeed(FEED_PAGE_SIZE, 1, {}, { sameChannels: true }).catch(() => null);
		if (asOf !== generation) return;

		if (feed) await remember([...feed.notifications, ...feed.videos], !feed.partial);

		// A look that failed is looked at again, like one that came back short.
		if (!feed || feed.partial) askAgainShortly(asOf, attempt + 1);
		else feedRefreshingStore.set(false);
	}, delay);
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
export function refreshSubscriptionFeed(options: { fresh?: boolean } = {}): Promise<void> {
	// The page's own load and a press on the logo can arrive together, and the
	// two of them asking separately would fetch the same feed twice.
	refreshing ??= (async () => {
		lastRefreshedAt = Date.now();
		generation += 1;
		const asOf = generation;

		feedRefreshingStore.set(true);

		try {
			// Pressing refresh asks the instance to fetch again whatever it has
			// not fetched in the last minute, rather than serve what it holds.
			const feed = await getFeed(
				FEED_PAGE_SIZE,
				1,
				{},
				options.fresh ? { freshWithinSeconds: REFRESH_FRESH_WITHIN_SECONDS } : {}
			);

			await remember([...feed.notifications, ...feed.videos], !feed.partial);

			if (feed.partial) askAgainShortly(asOf);
			else feedRefreshingStore.set(false);
		} catch (error) {
			feedRefreshingStore.set(false);
			throw error;
		}
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
