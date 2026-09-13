import { YTNodes } from 'youtubei.js';
import { getInnertube } from '.';
import type { PlaylistPage, PlaylistPageVideo, Thumbnail } from '../model';

/**
 * Mixes are the queues YouTube generates rather than playlists anyone made, and
 * asking for one through the playlist endpoint fails outright: it answers "This
 * playlist type is unviewable". They come from the watch queue instead.
 *
 * Every family behaves the same way here — a channel mix (RDEM), a mix seeded
 * from a video (RD<videoId>), the personal mix (RDMM) and a curated one
 * (RDCLAK) all return the same queue holding the same items — so one path
 * covers them.
 */
export function isMixPlaylistId(playlistId: string): boolean {
	return playlistId.startsWith('RD');
}

/**
 * The queue names itself with a Text for a generated mix but with an author
 * node for a curated one, and neither is worth a branch of its own.
 */
function readAuthor(author: unknown): string {
	if (!author) return '';
	if (typeof author === 'string') return author;

	const named = author as { name?: string; toString?: () => string };
	return named.name ?? named.toString?.() ?? '';
}

export async function getMixYTjs(playlistId: string): Promise<PlaylistPage> {
	const innertube = await getInnertube();

	const response = await innertube.actions.execute('/next', { playlistId, parse: true });
	const queue = response.contents_memo?.getType(YTNodes.TwoColumnWatchNextResults)[0]?.playlist;

	if (!queue) {
		throw new Error(`No queue returned for mix ${playlistId}`);
	}

	const author = readAuthor(queue.author);

	const videos: PlaylistPageVideo[] = [];

	queue.contents.forEach((item, position) => {
		if (!item.is(YTNodes.PlaylistPanelVideo)) return;

		videos.push({
			type: 'video',
			// Queue entries carry no author of their own, so the mix stands in for
			// one, and no index either, so their place in the queue does.
			author,
			authorId: '',
			index: position + 1,
			indexId: (position + 1).toString(),
			viewCount: 0,
			title: item.title.toString(),
			videoId: item.video_id,
			lengthSeconds: item.duration?.seconds ?? 0,
			videoThumbnails: (item.thumbnail ?? []) as Thumbnail[]
		});
	});

	return {
		type: 'playlist',
		title: queue.title?.toString() ?? '',
		description: '',
		descriptionHtml: '',
		viewCount: 0,
		updated: 0,
		isListed: true,
		videos,
		playlistId,
		videoCount: videos.length,
		author,
		authorId: '',
		authorVerified: false,
		playlistThumbnail: videos[0]?.videoThumbnails?.[0]?.url ?? '',
		// A mix has no end: YouTube keeps extending it as you watch. Anything that
		// walks a playlist to completion has to stop rather than follow that.
		isInfinite: queue.is_infinite ?? true
	};
}
