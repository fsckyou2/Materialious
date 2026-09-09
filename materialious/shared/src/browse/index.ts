import { YTNodes, type Helpers } from 'youtubei.js';
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
	viewCountText: string;
	thumbnail: string | null;
	isLive: boolean;
};

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
};

function secondsFromLabel(label: string | undefined): number {
	if (!label) return 0;

	const parts = label.split(':').map((part) => parseInt(part, 10));
	if (parts.some(Number.isNaN)) return 0;

	return parts.reduce((total, part) => total * 60 + part, 0);
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
			viewCountText: video.view_count?.toString() ?? '',
			thumbnail: bestThumbnail(video.thumbnails),
			isLive: video.is_live === true
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

		return {
			videoId: item.content_id,
			title: metadata?.title?.toString() ?? '',
			author: authorId ? (rows[0]?.metadata_parts?.[0]?.text?.text ?? '') : '',
			authorId,
			lengthSeconds,
			publishedText: statsRow?.metadata_parts?.[1]?.text?.text ?? '',
			viewCountText: statsRow?.metadata_parts?.[0]?.text?.text ?? '',
			thumbnail: bestThumbnail(
				item.content_image?.is(YTNodes.ThumbnailView) ? item.content_image.image : undefined
			),
			isLive: false
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

	return { videos, channels };
}

export type ChannelPage = {
	channelId: string;
	name: string;
	thumbnail: string | null;
	description: string;
	videos: BrowseVideo[];
};

export async function getChannel(channelId: string, cacheDir?: string): Promise<ChannelPage> {
	const innertube = await getBrowseSession(cacheDir);
	const channel = await innertube.getChannel(channelId);

	let videos: BrowseVideo[] = [];
	try {
		const tab = await channel.getVideos();
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
		videos
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

export { getBrowseSession };
