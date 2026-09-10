import { YTNodes, type Helpers } from 'youtubei.js';
import { randomUUID } from 'node:crypto';
import { getBrowseSession } from './session.js';

/**
 * Browsing on behalf of a client that cannot browse for itself.
 *
 * The web app runs youtubei.js in the browser, which a television app has no
 * way to reach, so the same lookups are exposed here instead. Shapes are
 * deliberately flat: a client rendering a row of thumbnails should not have to
 * understand YouTube's node types.
 */

export type BrowseVideo = {
	videoId: string;
	title: string;
	author: string;
	authorId: string;
	lengthSeconds: number;
	publishedText: string;
	/**
	 * Roughly how old the video is, in seconds.
	 *
	 * Feeds carry an age in words rather than a date, so this is read back out
	 * of that text. It is approximate by construction - "2 weeks ago" covers a
	 * week either side - but it is enough to put a merged feed in order, which
	 * is the only thing asking for it.
	 */
	publishedSecondsAgo: number | null;
	viewCountText: string;
	thumbnail: string | null;
	isLive: boolean;
	/** What kind of thing this is, since a feed can hold all three. */
	kind: VideoKind;
};

export type VideoKind = 'video' | 'short' | 'live';

/** The channel tabs a feed can be built from. */
export type FeedKind = 'videos' | 'shorts' | 'live';

export type BrowseChannel = {
	channelId: string;
	name: string;
	thumbnail: string | null;
	/** The @handle, which is what YouTube returns in `subscriber_count`. */
	handle: string;
	subscriberText: string;
};

export type BrowseResults = {
	videos: BrowseVideo[];
	channels: BrowseChannel[];
	/** Brings back the next page of results, when there is one. */
	continuation: string | null;
};

function secondsFromLabel(label: string | undefined): number {
	if (!label) return 0;

	const parts = label.split(':').map((part) => parseInt(part, 10));
	if (parts.some(Number.isNaN)) return 0;

	return parts.reduce((total, part) => total * 60 + part, 0);
}

const AGE_UNITS: Record<string, number> = {
	second: 1,
	minute: 60,
	hour: 3600,
	day: 86_400,
	week: 604_800,
	month: 2_629_800,
	year: 31_557_600
};

/**
 * Turns YouTube's "3 days ago" into an age in seconds.
 *
 * Anything it cannot read - a scheduled premiere, a live badge, a language this
 * instance does not run in - comes back null, and sorts to the end rather than
 * pretending to be new.
 */
export function secondsSincePublished(text: string | undefined): number | null {
	if (!text) return null;

	const match = text.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i);
	if (!match) return null;

	const unit = AGE_UNITS[match[2].toLowerCase()];
	if (!unit) return null;

	return Number(match[1]) * unit;
}

function bestThumbnail(thumbnails: { url: string; width?: number }[] | undefined): string | null {
	if (!thumbnails?.length) return null;

	const best = [...thumbnails].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
	if (!best?.url) return null;

	return best.url.startsWith('//') ? `https:${best.url}` : best.url;
}

/**
 * Flattens one item of a YouTube feed.
 *
 * YouTube returns the same video as several different node types depending on
 * the surface it came from, and has been migrating surfaces to `LockupView`, so
 * each shape it actually sends has to be handled rather than assuming one.
 */
export function toBrowseVideo(item: Helpers.YTNode): BrowseVideo | null {
	if (item.is(YTNodes.Video, YTNodes.GridVideo, YTNodes.CompactVideo)) {
		// These three carry the same fields in practice but do not share them in
		// the type union, so they are read through one shape rather than
		// duplicating the mapping three times.
		const video = item as unknown as {
			video_id: string;
			title?: { toString(): string };
			author?: { name?: string; id?: string };
			length_text?: { text?: string };
			published?: { toString(): string };
			view_count?: { toString(): string };
			thumbnails?: { url: string; width?: number }[];
			is_live?: boolean;
		};

		return {
			videoId: video.video_id,
			title: video.title?.toString() ?? '',
			author: video.author?.name ?? '',
			authorId: video.author?.id ?? '',
			lengthSeconds: secondsFromLabel(video.length_text?.text),
			publishedText: video.published?.toString() ?? '',
			publishedSecondsAgo: secondsSincePublished(video.published?.toString()),
			viewCountText: video.view_count?.toString() ?? '',
			thumbnail: bestThumbnail(video.thumbnails),
			isLive: video.is_live === true,
			kind: video.is_live === true ? 'live' : 'video'
		};
	}

	if (item.is(YTNodes.LockupView)) {
		if (item.content_type !== 'VIDEO' || !item.content_id) return null;

		const metadata = item.metadata;
		const rows = metadata?.metadata?.metadata_rows ?? [];

		let lengthSeconds = 0;
		if (item.content_image?.is(YTNodes.ThumbnailView)) {
			for (const overlay of item.content_image.overlays ?? []) {
				if (!overlay.is(YTNodes.ThumbnailBottomOverlayView)) continue;
				for (const badge of overlay.badges ?? []) {
					if (badge.is(YTNodes.ThumbnailBadgeView)) {
						lengthSeconds = secondsFromLabel(badge.text);
					}
				}
			}
		}

		// The rows mean different things depending on where the lockup came
		// from: a search result names its channel first, while a channel's own
		// feed omits it because the channel is implied. Presence of a channel
		// link is what distinguishes them.
		const authorId =
			metadata?.image?.renderer_context?.command_context?.on_tap?.payload?.browseId ?? '';
		const statsRow = authorId ? rows[1] : rows[0];

		// A live lockup says so on its thumbnail rather than in a field.
		const live = JSON.stringify(item.content_image ?? {}).includes('LIVE');

		return {
			videoId: item.content_id,
			title: metadata?.title?.toString() ?? '',
			author: authorId ? (rows[0]?.metadata_parts?.[0]?.text?.text ?? '') : '',
			authorId,
			lengthSeconds,
			publishedText: statsRow?.metadata_parts?.[1]?.text?.text ?? '',
			publishedSecondsAgo: secondsSincePublished(statsRow?.metadata_parts?.[1]?.text?.text),
			viewCountText: statsRow?.metadata_parts?.[0]?.text?.text ?? '',
			thumbnail: bestThumbnail(
				item.content_image?.is(YTNodes.ThumbnailView) ? item.content_image.image : undefined
			),
			isLive: live,
			kind: live ? 'live' : 'video'
		};
	}

	// Shorts come as their own lockup, which carries almost nothing: no
	// duration, no date, and its two lines of text rather than named fields.
	if (item.is(YTNodes.ShortsLockupView)) {
		const videoId =
			(item.on_tap_endpoint?.payload as { videoId?: string } | undefined)?.videoId ??
			item.entity_id;

		if (!videoId) return null;

		return {
			videoId,
			title: item.overlay_metadata?.primary_text?.toString() ?? '',
			author: '',
			authorId: '',
			lengthSeconds: 0,
			publishedText: '',
			publishedSecondsAgo: null,
			viewCountText: item.overlay_metadata?.secondary_text?.toString() ?? '',
			thumbnail: bestThumbnail(item.thumbnail),
			isLive: false,
			kind: 'short'
		};
	}

	return null;
}

function toBrowseChannel(item: Helpers.YTNode): BrowseChannel | null {
	if (item.is(YTNodes.Channel)) {
		// YouTube moved the handle into subscriber_count and the subscriber
		// count into video_count; the web app reads them the same way.
		return {
			channelId: item.id,
			name: item.author?.name ?? '',
			thumbnail: bestThumbnail(item.author?.thumbnails),
			handle: item.subscriber_count?.toString() ?? '',
			subscriberText: item.video_count?.toString() ?? ''
		};
	}

	// Search returns channels as lockups now, the same migration that moved
	// videos onto them.
	if (item.is(YTNodes.LockupView) && item.content_type === 'CHANNEL' && item.content_id) {
		const rows = item.metadata?.metadata?.metadata_rows ?? [];

		return {
			channelId: item.content_id,
			name: item.metadata?.title?.toString() ?? '',
			thumbnail: bestThumbnail(
				item.content_image?.is(YTNodes.ThumbnailView) ? item.content_image.image : undefined
			),
			handle: rows[0]?.metadata_parts?.[0]?.text?.text ?? '',
			subscriberText: rows[1]?.metadata_parts?.[0]?.text?.text ?? ''
		};
	}

	return null;
}

/**
 * Feeds that still have more to give.
 *
 * YouTube pages its results with an opaque continuation, and the library only
 * offers it through the feed object it came from - there is no token to hand a
 * client and take back later. So the feed stays here, under a token of our own,
 * and a client asking for more brings the token back.
 */
const pages = new Map<string, { feed: FeedLike; at: number }>();

/** How long an unused page is kept before it is forgotten. */
const PAGE_TTL_MS = 15 * 60 * 1000;

type FeedLike = {
	videos: Helpers.YTNode[];
	has_continuation: boolean;
	getContinuation(): Promise<FeedLike>;
};

function forgetStalePages(): void {
	const now = Date.now();
	for (const [token, page] of pages) {
		if (now - page.at > PAGE_TTL_MS) pages.delete(token);
	}
}

/** Files a feed away and returns the token that brings back its next page. */
function keepPage(feed: FeedLike | undefined): string | null {
	if (!feed?.has_continuation) return null;

	forgetStalePages();

	const token = randomUUID();
	pages.set(token, { feed, at: Date.now() });

	return token;
}

/**
 * The next page of whatever produced this token.
 *
 * An expired or unknown token is not an error: the client simply stops asking,
 * which is the same thing that happens at the end of a feed.
 */
export async function continuePage(token: string): Promise<{
	videos: BrowseVideo[];
	continuation: string | null;
}> {
	const page = pages.get(token);
	if (!page) return { videos: [], continuation: null };

	pages.delete(token);

	const next = await page.feed.getContinuation();

	return {
		videos: (next.videos ?? [])
			.map(toBrowseVideo)
			.filter((video): video is BrowseVideo => video !== null),
		continuation: keepPage(next)
	};
}

/**
 * Searches for videos, or for channels.
 *
 * Channels do not appear in an unfiltered search's results at all - they sit
 * inside cards and shelves that vary by query - so asking for them explicitly
 * is the only dependable way to find one.
 */
export async function search(
	query: string,
	type: 'video' | 'channel' = 'video',
	cacheDir?: string
): Promise<BrowseResults> {
	const innertube = await getBrowseSession(cacheDir);
	const results =
		type === 'channel'
			? await innertube.search(query, { type: 'channel' })
			: await innertube.search(query);

	const videos: BrowseVideo[] = [];
	const channels: BrowseChannel[] = [];

	for (const item of results.results ?? []) {
		const video = toBrowseVideo(item);
		if (video) {
			videos.push(video);
			continue;
		}

		const channel = toBrowseChannel(item);
		if (channel) channels.push(channel);
	}

	return { videos, channels, continuation: keepPage(results as unknown as FeedLike) };
}

export type ChannelPage = {
	channelId: string;
	name: string;
	thumbnail: string | null;
	description: string;
	videos: BrowseVideo[];
	continuation: string | null;
};

export async function getChannel(
	channelId: string,
	cacheDir?: string,
	kind: FeedKind = 'videos'
): Promise<ChannelPage> {
	const innertube = await getBrowseSession(cacheDir);
	const channel = await innertube.getChannel(channelId);

	let videos: BrowseVideo[] = [];
	let continuation: string | null = null;

	try {
		const tab =
			kind === 'shorts'
				? await channel.getShorts()
				: kind === 'live'
					? await channel.getLiveStreams()
					: await channel.getVideos();
		continuation = keepPage(tab as unknown as FeedLike);
		videos = (tab.videos ?? [])
			.map(toBrowseVideo)
			.filter((video): video is BrowseVideo => video !== null)
			// A channel's own feed does not repeat whose channel it is, so fill
			// it in from the channel being browsed rather than leaving it blank.
			.map((video) => ({
				...video,
				author: video.author || (channel.metadata?.title ?? ''),
				authorId: video.authorId || channelId
			}));
	} catch {
		// A channel without a videos tab is unusual but not an error worth
		// failing the whole page over.
	}

	return {
		channelId,
		name: channel.metadata?.title ?? '',
		thumbnail: bestThumbnail(channel.metadata?.avatar as { url: string; width?: number }[]),
		description: channel.metadata?.description ?? '',
		videos,
		continuation
	};
}

export type VideoPage = {
	videoId: string;
	title: string;
	author: string;
	authorId: string;
	description: string;
	lengthSeconds: number;
	viewCountText: string;
	publishedText: string;
	thumbnail: string | null;
	isLive: boolean;
	related: BrowseVideo[];
};

export async function getVideo(videoId: string, cacheDir?: string): Promise<VideoPage> {
	const innertube = await getBrowseSession(cacheDir);
	const info = await innertube.getInfo(videoId);

	const related = (info.watch_next_feed ?? [])
		.map(toBrowseVideo)
		.filter((video): video is BrowseVideo => video !== null);

	return {
		videoId,
		title: info.basic_info.title ?? '',
		author: info.basic_info.author ?? '',
		authorId: info.basic_info.channel_id ?? '',
		description: info.basic_info.short_description ?? '',
		lengthSeconds: info.basic_info.duration ?? 0,
		viewCountText: info.basic_info.view_count?.toString() ?? '',
		publishedText: info.primary_info?.published?.toString() ?? '',
		thumbnail: bestThumbnail(info.basic_info.thumbnail),
		isLive: info.basic_info.is_live === true,
		related
	};
}

export type BrowseComment = {
	commentId: string;
	author: string;
	authorThumbnail: string | null;
	content: string;
	publishedText: string;
	likeText: string;
	replyCount: number;
	isPinned: boolean;
	isOwner: boolean;
};

/**
 * The top comments on a video.
 *
 * Replies are counted but not fetched: a television shows a column of comments
 * to read, not a thread to navigate, and each expansion is another round trip.
 */
export async function getComments(videoId: string, cacheDir?: string): Promise<BrowseComment[]> {
	const innertube = await getBrowseSession(cacheDir);
	const comments = await innertube.getComments(videoId, 'TOP_COMMENTS');

	const flattened: BrowseComment[] = [];

	for (const thread of comments.contents ?? []) {
		const comment = thread.comment;
		if (!comment) continue;

		flattened.push({
			commentId: comment.comment_id,
			author: comment.author?.name ?? '',
			authorThumbnail: bestThumbnail(comment.author?.thumbnails),
			content: comment.content?.toString() ?? '',
			publishedText: comment.published_time ?? '',
			likeText: comment.like_count ?? '',
			replyCount: Number(comment.reply_count ?? 0) || 0,
			isPinned: comment.is_pinned === true,
			isOwner: comment.author_is_channel_owner === true
		});
	}

	return flattened;
}

/** How long a channel's videos are served for before being fetched again. */
const FEED_CACHE_MS = 30 * 60 * 1000;

/** How many channels are fetched at once. */
const FEED_CONCURRENCY = 8;

/** How many rounds deeper one request will go looking for older videos. */
const FEED_MAX_DEEPENING = 3;

/** How long one channel may hold up a feed of a hundred and sixty others. */
const CHANNEL_TIMEOUT_MS = 10_000;

type ChannelFeed = {
	videos: BrowseVideo[];
	/** Token for this channel's next page, or null once it is exhausted. */
	next: string | null;
	at: number;
};

const feedCache = new Map<string, ChannelFeed>();

/** Channels being fetched right now, so two callers wait on one request. */
const inFlight = new Map<string, Promise<ChannelFeed>>();

async function fetchChannel(
	channelId: string,
	kind: FeedKind,
	cacheDir?: string
): Promise<ChannelFeed> {
	const key = `${kind}:${channelId}`;

	const existing = inFlight.get(key);
	if (existing) return existing;

	const request = (async () => {
		try {
			const channel = await getChannel(channelId, cacheDir, kind);
			const loaded: ChannelFeed = {
				videos: channel.videos.map((video) => ({
					...video,
					author: video.author || channel.name,
					authorId: video.authorId || channelId
				})),
				next: channel.continuation,
				at: Date.now()
			};

			feedCache.set(key, loaded);

			return loaded;
		} catch {
			// One unreachable channel should not empty the whole feed.
			return feedCache.get(key) ?? { videos: [], next: null, at: Date.now() };
		} finally {
			inFlight.delete(key);
		}
	})();

	inFlight.set(key, request);

	return request;
}

/**
 * Gives up waiting after a while, without giving up on the work.
 *
 * The request carries on and fills the cache, so a channel that answers slowly
 * is merely late to the feed rather than absent from it.
 */
function withDeadline(work: Promise<ChannelFeed>, fallback: ChannelFeed): Promise<ChannelFeed> {
	return Promise.race([
		work,
		new Promise<ChannelFeed>((resolve) => {
			setTimeout(() => resolve(fallback), CHANNEL_TIMEOUT_MS).unref?.();
		})
	]);
}

/**
 * A channel's videos, from memory where possible.
 *
 * A stale copy is served immediately and refreshed behind it: with a hundred
 * and sixty subscriptions, waiting for every channel to answer would be a
 * minute of blank screen for the sake of the handful that changed.
 */
async function loadChannel(
	channelId: string,
	kind: FeedKind,
	cacheDir?: string
): Promise<ChannelFeed> {
	const cached = feedCache.get(`${kind}:${channelId}`);

	if (!cached) {
		return withDeadline(fetchChannel(channelId, kind, cacheDir), {
			videos: [],
			next: null,
			at: 0
		});
	}

	if (Date.now() - cached.at >= FEED_CACHE_MS) {
		void fetchChannel(channelId, kind, cacheDir);
	}

	return cached;
}

/** Pulls one more page into a channel's list, if it has one. */
async function deepenChannel(channel: ChannelFeed): Promise<boolean> {
	if (!channel.next) return false;

	const page = await continuePage(channel.next);

	channel.videos = [...channel.videos, ...page.videos];
	channel.next = page.continuation;

	return page.videos.length > 0;
}

/** Live first - it is happening now - then newest to oldest. */
function byRecency(a: BrowseVideo, b: BrowseVideo): number {
	if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
	return (a.publishedSecondsAgo ?? Infinity) - (b.publishedSecondsAgo ?? Infinity);
}

/**
 * Merges channels into one list, newest first.
 *
 * Shorts carry no date at all, so anything undated cannot be ordered against
 * anything else. Rather than let it fall into channel order - every video of
 * one channel, then every video of the next - undated videos are dealt out one
 * per channel, which is the same shape a dated feed ends up with.
 */
function mergeChannels(channels: ChannelFeed[]): BrowseVideo[] {
	const dated: BrowseVideo[] = [];
	const undated: BrowseVideo[][] = [];

	for (const channel of channels) {
		const rest: BrowseVideo[] = [];

		for (const video of channel.videos) {
			if (video.publishedSecondsAgo === null) rest.push(video);
			else dated.push(video);
		}

		if (rest.length) undated.push(rest);
	}

	dated.sort(byRecency);

	const dealt: BrowseVideo[] = [];
	const deepest = Math.max(0, ...undated.map((channel) => channel.length));

	for (let index = 0; index < deepest; index += 1) {
		for (const channel of undated) {
			const video = channel[index];
			if (video) dealt.push(video);
		}
	}

	return [...dated, ...dealt];
}

export type FeedPage = {
	videos: BrowseVideo[];
	/** Whether asking for the next offset could return anything. */
	hasMore: boolean;
};

/**
 * The newest videos across a set of channels, merged into one list.
 *
 * Subscriptions are encrypted, so the instance cannot know whose feed this is:
 * the client says which channels it wants. Fetching them here rather than on
 * the client turns a dozen sequential round trips over a television's network
 * into one, and lets the results be cached for everyone asking.
 *
 * Scrolling past the end of what has been gathered goes back a page in every
 * channel at once, because a merged feed cannot know which channel the next
 * oldest video belongs to until it has looked.
 */
export async function getFeed(
	channelIds: string[],
	options: { kind?: FeedKind; offset?: number; limit?: number; cacheDir?: string } = {}
): Promise<FeedPage> {
	const offset = Math.max(0, options.offset ?? 0);
	const limit = Math.max(1, options.limit ?? 60);
	const kind = options.kind ?? 'videos';

	const queue = [...channelIds];
	const channels: ChannelFeed[] = [];

	const workers = Array.from({ length: Math.min(FEED_CONCURRENCY, queue.length) }, async () => {
		for (;;) {
			const channelId = queue.shift();
			if (!channelId) return;

			channels.push(await loadChannel(channelId, kind, options.cacheDir));
		}
	});

	await Promise.all(workers);

	const merged = () => mergeChannels(channels);

	let videos = merged();

	// Only go looking for older videos when somebody has scrolled far enough to
	// need them.
	for (let round = 0; round < FEED_MAX_DEEPENING; round += 1) {
		if (videos.length >= offset + limit) break;
		if (!channels.some((channel) => channel.next)) break;

		await Promise.all(channels.map((channel) => deepenChannel(channel)));

		videos = merged();
	}

	return {
		videos: videos.slice(offset, offset + limit),
		hasMore: videos.length > offset + limit || channels.some((channel) => channel.next)
	};
}

export { getBrowseSession };
