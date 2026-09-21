import { authProtected } from '$lib/auth';
import { feedCacheStore, feedLoadingStore } from '$lib/store';
import { loadSubscriptionFeed, refreshSubscriptionFeed } from '$lib/subscriptionFeed';
import { error } from '@sveltejs/kit';
import { get } from 'svelte/store';

export async function load() {
	authProtected();

	if (!get(feedCacheStore).subscription) {
		loadSubscriptionFeed((reason) => error(500, reason as string));
		return;
	}

	feedLoadingStore.set(false);

	// Arriving back at a feed that is already on screen still asks for the
	// newest videos, and still goes back for the channels the instance had not
	// gathered yet. A screen that is never closed - a television, or a browser
	// tab left open for days - only ever comes through here.
	await refreshSubscriptionFeed();
}
