/**
 * When a page never finishes loading, the useful question is what it is still
 * waiting for. Requests are held here while they are outstanding so a stall
 * report can name them, rather than saying only that something is slow.
 */
type PendingRequest = {
	url: string;
	startedAt: number;
};

let nextId = 0;

const pending = new Map<number, PendingRequest>();

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

export function requestSettled(id: number): void {
	pending.delete(id);
}

export function outstandingRequests(): { url: string; waitingMs: number }[] {
	const now = Date.now();

	return [...pending.values()]
		.map((request) => ({ url: request.url, waitingMs: now - request.startedAt }))
		.sort((a, b) => b.waitingMs - a.waitingMs)
		.slice(0, 8);
}
