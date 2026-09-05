import { randomBytes } from 'node:crypto';
import { CastSession } from './CastSession.js';

/**
 * Cast sessions live only in memory, keyed by an unguessable id.
 *
 * The id is the only credential the receiver carries: a Chromecast sends no
 * cookies, so the gateway routes cannot use the instance's normal auth. Ids are
 * 256 bits of randomness, scoped to one video, and expire on their own, which
 * keeps a leaked manifest URL from being useful for anything but that video.
 */
const IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const sessions = new Map<string, CastSession>();
let sweeper: ReturnType<typeof setInterval> | undefined;

function startSweeper(): void {
	if (sweeper) return;

	sweeper = setInterval(() => {
		const now = Date.now();
		for (const [id, session] of sessions) {
			if (now - session.lastUsed > IDLE_TIMEOUT_MS) {
				session.dispose();
				sessions.delete(id);
			}
		}
		if (sessions.size === 0 && sweeper) {
			clearInterval(sweeper);
			sweeper = undefined;
		}
	}, SWEEP_INTERVAL_MS);

	// Never hold the process open for the sake of the sweep.
	sweeper.unref?.();
}

export async function createCastSession(
	videoId: string,
	userId: string | undefined,
	cacheDir?: string
): Promise<CastSession> {
	// Reuse a warm session for the same viewer and video: setting one up costs a
	// PO token mint and a player fetch, and YouTube makes the first SABR request
	// of a session wait out a backoff.
	for (const session of sessions.values()) {
		if (session.videoId === videoId && session.userId === userId) {
			session.lastUsed = Date.now();
			return session;
		}
	}

	const id = randomBytes(32).toString('base64url');
	const session = await CastSession.create(id, videoId, userId, cacheDir);

	sessions.set(id, session);
	startSweeper();

	await session.warmUp();

	return session;
}

export function getCastSession(id: string): CastSession | undefined {
	const session = sessions.get(id);
	if (session) session.lastUsed = Date.now();
	return session;
}

export function endCastSession(id: string): void {
	const session = sessions.get(id);
	if (!session) return;
	session.dispose();
	sessions.delete(id);
}
