/**
 * When a page never finishes loading, the useful question is what it is still
 * waiting for. Requests are held here while they are outstanding so a stall
 * report can name them, rather than saying only that something is slow.
 */
type PendingRequest = {
	url: string;
	startedAt: number;
};

type FailedRequest = {
	url: string;
	/** Whatever the request came back as, eg "HTTP 500" or "TypeError". */
	failure: string;
	/** How long it ran before giving up. */
	tookMs: number;
	/** When it gave up, so a report can leave out anything long past. */
	at: number;
};

let nextId = 0;

const pending = new Map<number, PendingRequest>();

/** Enough to show a pattern, few enough to keep a report readable. */
const FAILURES_KEPT = 8;

/** Older than this and it belongs to whatever the reader was doing before. */
const FAILURE_WINDOW_MS = 120_000;

const failures: FailedRequest[] = [];

/** Signatures and tokens make these long, and nothing here needs to be exact. */
function shorten(url: string): string {
	const proxied = url.split('/api/proxy/')[1];

	if (proxied) {
		try {
			const target = new URL(decodeURIComponent(proxied));
			return `${target.host}${target.pathname}`;
		} catch {
			// Fall through to the raw URL.
		}
	}

	return url.split('?')[0];
}

export function requestStarted(url: string): number {
	const id = nextId++;
	pending.set(id, { url: shorten(url), startedAt: Date.now() });
	return id;
}

export function requestSettled(id: number, failure?: string): void {
	const request = pending.get(id);
	pending.delete(id);

	if (!request || !failure) return;

	failures.push({
		url: request.url,
		failure,
		tookMs: Date.now() - request.startedAt,
		at: Date.now()
	});

	if (failures.length > FAILURES_KEPT) failures.shift();
}

/**
 * What has failed lately, newest first.
 *
 * A page that gave up on something is no longer waiting for it, so a stall
 * report built only from outstanding requests says the page is waiting for
 * nothing - which reads as though nothing went wrong. These are what went
 * wrong.
 */
export function recentFailures(): {
	url: string;
	failure: string;
	tookMs: number;
	agoMs: number;
}[] {
	const now = Date.now();

	return [...failures]
		.reverse()
		.filter((failure) => now - failure.at < FAILURE_WINDOW_MS)
		.map(({ url, failure, tookMs, at }) => ({ url, failure, tookMs, agoMs: now - at }));
}

export function outstandingRequests(): { url: string; waitingMs: number }[] {
	const now = Date.now();

	return [...pending.values()]
		.map((request) => ({ url: request.url, waitingMs: now - request.startedAt }))
		.sort((a, b) => b.waitingMs - a.waitingMs)
		.slice(0, 8);
}
