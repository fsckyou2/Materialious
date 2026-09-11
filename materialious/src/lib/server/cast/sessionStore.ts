import { randomBytes } from 'node:crypto';
import { CastSession } from './CastSession';

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

/**
 * A session holds a rolling window of decoded segments, so a few dozen of them
 * is real memory rather than bookkeeping. An hour of idle time is generous for
 * a viewer who wandered off; this is the ceiling for everyone at once.
 */
const MAX_SESSIONS = 12;

const sessions = new Map<string, CastSession>();
const pending = new Map<string, Promise<CastSession>>();
let sweeper: ReturnType<typeof setInterval> | undefined;

function dropSession(id: string): void {
	const session = sessions.get(id);
	if (!session) return;
	session.dispose();
	sessions.delete(id);
}

function startSweeper(): void {
	if (sweeper) return;

	sweeper = setInterval(() => {
		const now = Date.now();
		for (const [id, session] of sessions) {
			if (now - session.lastUsed > IDLE_TIMEOUT_MS) dropSession(id);
		}
		if (sessions.size === 0 && sweeper) {
			clearInterval(sweeper);
			sweeper = undefined;
		}
	}, SWEEP_INTERVAL_MS);

	// Never hold the process open for the sake of the sweep.
	sweeper.unref?.();
}

/** Evicts least recently used sessions until there is room for one more. */
function makeRoom(): void {
	while (sessions.size >= MAX_SESSIONS) {
		let oldestId: string | undefined;
		let oldestUsed = Infinity;
		for (const [id, session] of sessions) {
			if (session.lastUsed < oldestUsed) {
				oldestUsed = session.lastUsed;
				oldestId = id;
			}
		}
		if (!oldestId) return;
		dropSession(oldestId);
	}
}

export async function createCastSession(
	videoId: string,
	userId: string | undefined
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

	// A receiver that asks twice before the first setup finishes - a retry, or a
	// phone and a TV starting the same video - would otherwise pay for it twice.
	const key = `${videoId} ${userId ?? ''}`;
	const inFlight = pending.get(key);
	if (inFlight) return inFlight;

	const setup = (async () => {
		const id = randomBytes(32).toString('base64url');
		const session = await CastSession.create(id, videoId, userId);

		makeRoom();
		sessions.set(id, session);
		startSweeper();

		await session.warmUp();

		return session;
	})();

	pending.set(key, setup);
	try {
		return await setup;
	} finally {
		pending.delete(key);
	}
}

export function getCastSession(id: string): CastSession | undefined {
	const session = sessions.get(id);
	if (session) session.lastUsed = Date.now();
	return session;
}
