import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { env } from '$env/dynamic/private';
import { currentEgress } from '@materialious/shared/identity';

/**
 * Tells the egress watchdog that YouTube has bot-flagged this server's
 * address, or is refusing its streams.
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
	flagEgress(`bot-checked (${where})`);
}

/**
 * How many refused streams within `REFUSALS_WITHIN_MS` say the address is to
 * blame rather than the one token. A refusal on its own is common enough - a
 * new session gets past it as often as not - but they also come in runs that
 * no new session gets past: three casts in an hour on 2026-11-17, one of them
 * refused again after both of its fresh starts, with no bot check to say so.
 */
const REFUSALS_IN_A_RUN = 3;
const REFUSALS_WITHIN_MS = 30 * 60 * 1000;

/** The same refusal reported several times over is one refusal. */
const SAME_REFUSAL_WITHIN_MS = 15_000;

let refusals: { at: number; videoId: string }[] = [];

/**
 * Records that YouTube refused a stream of `videoId` (stream protection
 * status 2 or more, or the empty answers that follow it), and flags the
 * address once that has happened often enough.
 */
export function noteRefusal(videoId: string, where: string): void {
	const now = Date.now();

	refusals = refusals.filter((refusal) => now - refusal.at < REFUSALS_WITHIN_MS);

	if (
		refusals.some(
			(refusal) => refusal.videoId === videoId && now - refusal.at < SAME_REFUSAL_WITHIN_MS
		)
	) {
		return;
	}

	refusals.push({ at: now, videoId });

	if (refusals.length >= REFUSALS_IN_A_RUN) {
		const videos = new Set(refusals.map((refusal) => refusal.videoId)).size;
		refusals = [];
		flagEgress(
			`refused ${REFUSALS_IN_A_RUN} streams of ${videos} video${videos === 1 ? '' : 's'}` +
				` within ${REFUSALS_WITHIN_MS / 60_000} minutes (last ${where})`
		);
	}
}

/**
 * Whether a stall report from a browser's player is of a refused stream, by
 * the player's own reckoning (`streamRefused` in Player.svelte): YouTube said
 * so, or the player gave up on answers with no video in them.
 */
export function isRefusalReport(report: unknown): report is { id: string } {
	const fields = report as { phase?: unknown; id?: unknown; severity?: unknown; data?: unknown };
	if (fields?.phase !== 'playerError' || typeof fields.id !== 'string') return false;

	const said = /"streamProtectionStatus":\{"status":([2-9])/.test(JSON.stringify(fields.data));
	const givenUpOnEmpty =
		fields.severity === 2 &&
		Array.isArray(fields.data) &&
		fields.data[0] === 'Empty response with no redirect information';

	return said || givenUpOnEmpty;
}

/** Writes the flag the watchdog acts on, saying why. */
function flagEgress(why: string): void {
	if (Date.now() - lastNoted < NOTE_EVERY_MS) return;
	lastNoted = Date.now();

	const egress = currentEgress() ?? 'an unknown address';
	console.warn(`[egress] YouTube ${why} at ${egress}`);

	const file = flagFile();
	if (!file) return;

	writeFile(
		file,
		JSON.stringify({ at: new Date().toISOString(), egress: currentEgress() ?? null, why })
	).catch((error) => {
		console.warn(
			'[egress] could not write the egress flag:',
			error instanceof Error ? error.message : error
		);
	});
}
