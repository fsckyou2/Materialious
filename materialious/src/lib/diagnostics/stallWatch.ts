import { browser } from '$app/environment';
import { outstandingRequests, recentFailures } from './pendingRequests';

/**
 * Pages that never finish loading are the hardest thing here to look into,
 * because they happen now and then, leave nothing behind, and are over by the
 * time anyone goes looking. A watch is started when a page begins waiting for
 * something and cancelled once that arrives; if it is still waiting when the
 * watch runs out, what the page was waiting for is written to the server log.
 *
 * Nothing is sent unless a page actually stalls.
 */
const DEFAULT_WAIT_MS = 15_000;

/** A session that is stalling repeatedly has said what it has to say. */
const REPORT_LIMIT = 5;

let reportsSent = 0;

export type StallContext = {
	/** What the page was doing, eg "watch" or "channel". */
	phase: string;
	/** The video, channel or playlist being opened. */
	id?: string;
	/** Anything the caller can add once the stall is known, eg player state. */
	detail?: () => Record<string, unknown>;
};

async function report(context: StallContext, waitedMs: number): Promise<void> {
	if (reportsSent >= REPORT_LIMIT) return;
	reportsSent++;

	let detail: Record<string, unknown> = {};
	try {
		detail = context.detail?.() ?? {};
	} catch {
		// A stall report is not worth failing over.
	}

	try {
		await fetch('/api/diagnostics', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				phase: context.phase,
				id: context.id,
				waitedMs,
				route: location.pathname,
				waitingFor: outstandingRequests(),
				recentlyFailed: recentFailures(),
				...detail
			})
		});
	} catch {
		// The report is a courtesy; losing it changes nothing for the reader.
	}
}

/**
 * Starts watching, and returns the function that says the wait is over. Calling
 * it after the watch has already fired is harmless.
 */
export function watchForStall(context: StallContext, waitMs: number = DEFAULT_WAIT_MS): () => void {
	// Loads run on the server as well, where there is no reader waiting on a
	// spinner and nothing to report to.
	if (!browser) return () => {};

	const timer = setTimeout(() => {
		void report(context, waitMs);
	}, waitMs);

	return () => clearTimeout(timer);
}
