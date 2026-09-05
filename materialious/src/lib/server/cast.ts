import type { RequestEvent } from '@sveltejs/kit';

/**
 * The absolute origin a cast receiver should call back on.
 *
 * A Chromecast fetches the manifest and every segment itself, so the URLs we
 * hand it have to be reachable from the television rather than from the server.
 * Behind the reverse proxy `url.origin` is the internal address, so the
 * forwarded headers win where they are present.
 */
export function castBaseUrl(event: RequestEvent, sessionId: string): string {
	const { request, url } = event;

	const protocol =
		request.headers.get('x-forwarded-proto')?.split(',')[0].trim() || url.protocol.replace(':', '');
	const host =
		request.headers.get('x-forwarded-host')?.split(',')[0].trim() ||
		request.headers.get('host') ||
		url.host;

	return `${protocol}://${host}/api/cast/${sessionId}`;
}

/** Receivers are a different origin, and adaptive streaming needs CORS. */
export const castCorsHeaders = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, HEAD, OPTIONS',
	'access-control-allow-headers': 'Range, Content-Type',
	'access-control-expose-headers': 'Content-Length, Content-Range, Accept-Ranges'
};
