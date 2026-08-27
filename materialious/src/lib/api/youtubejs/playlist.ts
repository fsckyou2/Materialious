import { extractNumber } from '$lib/numbers';
import { YT, YTNodes } from 'youtubei.js';
import { getInnertube } from '.';
import type { PlaylistPage, PlaylistPageVideo } from '../model';
import { invidiousItemSchema } from './schema';

async function fetchPlaylistWithContinuation(
	playlist: YT.Playlist,
	playlistId: string
): Promise<PlaylistPage> {
	const videos: PlaylistPageVideo[] = [];

	playlist.videos.forEach((video, position) => {
		if (video.is(YTNodes.PlaylistVideo)) {
			const videoIndex = video.index.text ?? '0';
			videos.push({
				type: 'video',
				author: video.author.name,
				authorId: video.author.id,
				index: extractNumber(videoIndex),
				indexId: videoIndex,
				viewCount: 0,
				title: video.title.text ?? '',
				videoId: video.id ?? '',
				lengthSeconds: video.duration.seconds,
				videoThumbnails: video.thumbnails
			});
			return;
		}

		// Playlists now hand back their entries as lockups instead. Those carry no
		// index of their own, so position in the list stands in for it.
		const entry = invidiousItemSchema(video);
		if (entry?.type !== 'video') return;

		videos.push({
			type: 'video',
			author: entry.author || playlist.info.author.name,
			authorId: entry.authorId,
			index: position + 1,
			indexId: (position + 1).toString(),
			viewCount: entry.viewCount ?? 0,
			title: entry.title,
			videoId: entry.videoId,
			lengthSeconds: entry.lengthSeconds,
			videoThumbnails: entry.videoThumbnails
		});
	});

	const playlistPage: PlaylistPage = {
		type: 'playlist',
		title: playlist.info.title ?? '',
		description: playlist.info.description ?? '',
		descriptionHtml: playlist.info.description ?? '',
		viewCount: extractNumber(playlist.info.views ?? '0'),
		updated: 0,
		isListed: true,
		videos: videos,
		playlistId,
		videoCount: playlist.videos.length,
		author: playlist.info.author.name,
		authorId: playlist.info.author.id,
		authorVerified: true,
		playlistThumbnail: playlist.info.thumbnails[0].url ?? ''
	};

	// Attaching this unconditionally made the page ask for a continuation that was
	// never there, and youtubei.js throws rather than returning nothing, which took
	// the whole playlist down with it.
	if (playlist.has_continuation) {
		playlistPage.getContinuation = async () => {
			const continuation = await playlist.getContinuation();
			return fetchPlaylistWithContinuation(continuation, playlistId);
		};
	}

	return playlistPage;
}

export async function getPlaylistYTjs(playlistId: string): Promise<PlaylistPage> {
	const innertube = await getInnertube();
	const playlist = await innertube.getPlaylist(playlistId);

	return fetchPlaylistWithContinuation(playlist, playlistId);
}
