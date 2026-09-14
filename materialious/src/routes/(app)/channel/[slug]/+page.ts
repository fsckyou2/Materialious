import { getChannel, getChannelContent } from '$lib/api/index';
import type { ChannelContentVideos, Video } from '$lib/api/model';
import { excludeDuplicateFeeds } from '$lib/feed';
import { watchForStall } from '$lib/diagnostics/stallWatch';
import { channelCacheStore } from '$lib/store';
import { error } from '@sveltejs/kit';
import { get } from 'svelte/store';

export function load({ params }) {
	const currentChannelCache = get(channelCacheStore);

	if (params.slug in currentChannelCache) {
		getChannelContent(params.slug, {
			type: 'videos'
		}).then((channelContent) => {
			if (!('videos' in currentChannelCache[params.slug].displayContent)) return;

			(currentChannelCache[params.slug].displayContent.videos as ChannelContentVideos).videos =
				excludeDuplicateFeeds(
					(currentChannelCache[params.slug].displayContent.videos as ChannelContentVideos).videos,
					(channelContent as ChannelContentVideos).videos
				) as Video[];
		});
		return;
	}

	const detailsSettled = watchForStall({ phase: 'channel', id: params.slug });

	return {
		streamed: {
			details: (async () => {
				let channel;

				try {
					channel = await getChannel(params.slug);
				} catch (errorMessage: any) {
					detailsSettled();
					error(500, errorMessage);
				}

				const displayContent = await getChannelContent(params.slug, {
					type: 'videos'
				});

				detailsSettled();

				channelCacheStore.set({
					...currentChannelCache,
					[params.slug]: {
						channel: channel,
						displayContent: { videos: displayContent }
					}
				});
			})()
		}
	};
}
