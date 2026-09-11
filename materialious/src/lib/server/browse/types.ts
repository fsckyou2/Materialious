import type { VideoBase } from '$lib/api/model';

/**
 * What this instance tells a device about what it can watch.
 *
 * This file is the contract, and nothing in it knows how the answers are found:
 * no YouTube, no parsing, no caches. It is here on its own because its only
 * consumer is in another repository, written in another language, and so cannot
 * be broken by a compiler when a field is renamed. Keeping the whole surface on
 * one screen is what makes it reviewable before it changes.
 *
 * Anything shared with the app's own model is taken from there rather than
 * restated - see `BrowseVideo` - so the two vocabularies cannot quietly drift
 * into disagreeing about the same thing.
 */

/**
 * What version of this contract the instance speaks.
 *
 * Raised whenever a field is renamed, removed, or changes meaning. Devices send
 * back what they were built against, so a mismatch can be said out loud instead
 * of showing up as a feed that is mysteriously blank in one column.
 */
export const BROWSE_CONTRACT_VERSION = 1;

/**
 * One video, as a device is told about it.
 *
 * Deliberately not the app's own `Video`: that shape carries an array of
 * thumbnails to choose between, a description, and fields only a browser has a
 * use for, and it is shaped by the Invidious API that a television has no
 * reason to learn. What a television gets is flat - one picture, already
 * chosen; one line of text, already written.
 *
 * The fields it does share are taken from the app's shape rather than
 * redeclared, so the two cannot drift apart quietly: rename one there and this
 * stops compiling here, which is the moment to decide whether the wire should
 * follow.
 */
export type BrowseVideo = Pick<
	VideoBase,
	'videoId' | 'title' | 'author' | 'authorId' | 'lengthSeconds' | 'viewCountText' | 'type'
> & {
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
	/** The one picture to show, picked here so a device need not choose. */
	thumbnail: string | null;
	liveNow: boolean;
};

/**
 * What kind of thing a feed item is.
 *
 * The app already had a word for this, and a set of values for it, before this
 * module existed. Inventing a second set - `short` beside `shortVideo`, `live`
 * beside `stream` - bought nothing and cost a translation nobody could see.
 */
export type VideoKind = VideoBase['type'];

/** The channel tabs a feed can be built from. */
export type FeedKind = 'videos' | 'shorts' | 'live';

/**
 * Browsing on behalf of a client that cannot browse for itself.
 *
 * The web app runs youtubei.js in the browser, which a television app has no
 * way to reach, so the same lookups are exposed here instead. Shapes are
 * deliberately flat: a client rendering a row of thumbnails should not have to
 * understand YouTube's node types.
 */

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

export type ChannelPage = {
	channelId: string;
	name: string;
	thumbnail: string | null;
	description: string;
	/** "1.2M subscribers", as YouTube phrases it. */
	subscriberText: string;
	videos: BrowseVideo[];
	continuation: string | null;
};

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
	liveNow: boolean;
	related: BrowseVideo[];
};

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

export type FeedPage = {
	videos: BrowseVideo[];
	/** Whether asking for the next offset could return anything. */
	hasMore: boolean;
};
