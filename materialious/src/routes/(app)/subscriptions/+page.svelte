<script lang="ts">
	import { getFeed } from '$lib/api/index';
	import type { PlaylistPageVideo, Video, VideoBase } from '$lib/api/model';
	import { feedCacheStore, feedLoadingStore } from '$lib/store';
	import { addToSubscriptionFeed } from '$lib/subscriptionFeed';
	import InfiniteLoading, { type InfiniteEvent } from 'svelte-infinite-loading';
	import ItemsList from '$lib/components/layout/ItemsList.svelte';
	import { resolve } from '$app/paths';
	import { _ } from '$lib/i18n';
	import PageLoading from '$lib/components/PageLoading.svelte';

	let currentPage = 1;
	let videos: (VideoBase | Video | PlaylistPageVideo)[] = $derived($feedCacheStore.subscription);

	async function loadMore(event: InfiniteEvent) {
		currentPage++;

		const feed = await getFeed(100, currentPage);
		if (feed.videos.length === 0) {
			event.detail.complete();
			return;
		}

		// Folded in and put back in order, rather than stacked on the end: a
		// further page is mostly older than what is showing but not entirely,
		// and the two orders have to be one order.
		await addToSubscriptionFeed([...feed.videos, ...feed.notifications]);
		event.detail.loaded();
	}
</script>

<nav class="right-align">
	<a class="button surface-container-highest" href={resolve('/subscriptions/manage', {})}>
		{$_('subscriptions.manageSubscriptions')}
	</a>
</nav>
<div class="space"></div>

{#if !$feedLoadingStore}
	<ItemsList items={videos ?? []} />
	<InfiniteLoading on:infinite={loadMore} />
{:else}
	<PageLoading />
{/if}
