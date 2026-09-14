import { get } from 'svelte/store';
import { fetchErrorHandle } from './invidious/request';
import { deArrowInstanceStore, deArrowThumbnailInstanceStore } from '$lib/store';
import type { DeArrow } from './model';

export async function getDeArrow(videoId: string, fetchOptions?: RequestInit): Promise<DeArrow> {
	const resp = await fetchErrorHandle(
		await fetch(`${get(deArrowInstanceStore)}/api/branding?videoID=${videoId}`, fetchOptions)
	);
	return await resp.json();
}

/**
 * Returns an empty string when there is no thumbnail to show, which callers
 * should read as "keep the one you have".
 */
export async function getThumbnailDeArrow(
	videoId: string,
	time: number,
	fetchOptions?: RequestInit
): Promise<string> {
	const resp = await fetchErrorHandle(
		await fetch(
			`${get(deArrowThumbnailInstanceStore)}/api/v1/getThumbnail?videoID=${videoId}&time=${time}`,
			fetchOptions
		)
	);

	// The service answers 204 when it has nothing to give, which is a success and
	// so passes the check above. Making a blob URL out of the empty body hands
	// back something that looks like a thumbnail and renders as nothing.
	if (resp.status === 204) return '';

	const thumbnail = await resp.blob();
	if (thumbnail.size === 0) return '';

	return URL.createObjectURL(thumbnail);
}
