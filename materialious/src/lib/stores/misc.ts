import { writable, type Writable } from 'svelte/store';
import { persist } from '@macfja/svelte-persistent-store';
import { createStorage } from './storage';

export const rawMasterKeyStore: Writable<string | undefined> = persist(
	writable(),
	createStorage(),
	'rawMasterKey'
);

export const watchHistoryEnabledStore: Writable<boolean> = persist(
	writable(true),
	createStorage(),
	'watchHistoryEnabled'
);

export const poTokenCacheStore: Writable<string | undefined> = writable();

/**
 * The cookies of a signed-in youtube.com session, for the videos YouTube will
 * only play to somebody signed in - age-restricted ones, chiefly. Empty when
 * nobody has signed in, which is how everything else is watched regardless.
 */
export const youtubeCookieStore: Writable<string> = persist(
	writable(''),
	createStorage(),
	'youtubeCookie'
);

export const isAndroidTvStore: Writable<boolean> = writable(false);
