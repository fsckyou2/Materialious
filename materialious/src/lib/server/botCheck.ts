import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { env } from '$env/dynamic/private';
import { currentEgress } from '@materialious/shared/identity';

/**
 * Tells the egress watchdog that YouTube has bot-flagged this server's
 * address.
 *
 * Once flagged ("Sign in to confirm you're not a bot"), an address stays
 * flagged for most videos, and the only way out found so far is a new one:
 * re-registering the WARP container that every request goes out through
 * (2026-11-01, about every twelve hours). The watchdog beside it does that
 * when this file changes; nothing here can, since the app has no say over
 * other containers.
 */

/** No more often than this: one flag is all the watchdog needs to hear. */
const NOTE_EVERY_MS = 60_000;

let lastNoted = 0;

/**
 * Where the flag is written: beside the database, which the watchdog mounts.
 * None for a database that is not a file.
 */
function flagFile(): string | null {
	if (env.EGRESS_FLAG_FILE) return env.EGRESS_FLAG_FILE;

	const database = env.DATABASE_CONNECTION_URI?.match(/^sqlite:\/\/(\/.+)$/)?.[1];

	return database ? join(dirname(database), 'egress-flag.json') : null;
}

/**
 * Whether YouTube's answer about a video is its bot check, rather than the
 * sign-in it asks for a video that is age-restricted or members-only.
 */
export function isBotCheck(playability: { status?: string; reason?: string } | undefined): boolean {
	return playability?.status === 'LOGIN_REQUIRED' && /not a bot/i.test(playability.reason ?? '');
}

/** Records that YouTube answered `where` with its bot check. */
export function noteBotCheck(where: string): void {
	if (Date.now() - lastNoted < NOTE_EVERY_MS) return;
	lastNoted = Date.now();

	const egress = currentEgress() ?? 'an unknown address';
	console.warn(`[egress] YouTube bot-checked this server at ${egress} (${where})`);

	const file = flagFile();
	if (!file) return;

	writeFile(
		file,
		JSON.stringify({ at: new Date().toISOString(), egress: currentEgress() ?? null, where })
	).catch((error) => {
		console.warn(
			'[egress] could not write the bot-check flag:',
			error instanceof Error ? error.message : error
		);
	});
}
