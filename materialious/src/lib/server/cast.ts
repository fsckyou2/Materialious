import { env } from '$env/dynamic/private';
import type { RequestEvent } from '@sveltejs/kit';

/** Hosts only: letters, digits, dots, hyphens, an optional port, nothing else. */
const HOST = /^[a-z0-9.-]+(:\d{1,5})?$/i;

/**
 * The absolute origin a cast receiver should call back on.
 *
 * A Chromecast fetches the manifest and every segment itself, so the URLs we
 * hand it have to be reachable from the television rather than from the server.
 * Behind the reverse proxy `url.origin` is the internal address, so where the
 * instance has been told its own public address - adapter-node's `ORIGIN`, the
 * same value its CSRF check uses - that is what the receiver is given.
 *
 * Failing that the forwarded headers are used, because there is nothing else to
 * go on; they arrive from the client, so a caller can point their own receiver
 * somewhere odd, and the session id in the URL is the only thing that would go
 * with it. Setting `ORIGIN` closes that off.
 */
export function castBaseUrl(event: RequestEvent, sessionId: string): string {
	const { request, url } = event;

	const configured = env.ORIGIN?.trim();
	if (configured) {
		return `${configured.replace(/\/+$/, '')}/api/cast/${sessionId}`;
	}

	const protocol =
		request.headers.get('x-forwarded-proto')?.split(',')[0].trim() || url.protocol.replace(':', '');

	const forwarded = request.headers.get('x-forwarded-host')?.split(',')[0].trim();
	const host = [forwarded, request.headers.get('host'), url.host].find(
		(candidate) => candidate && HOST.test(candidate)
	);

	return `${protocol === 'https' ? 'https' : 'http'}://${host}/api/cast/${sessionId}`;
}

/** Receivers are a different origin, and adaptive streaming needs CORS. */
export const castCorsHeaders = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, HEAD, OPTIONS',
	'access-control-allow-headers': 'Range, Content-Type',
	'access-control-expose-headers': 'Content-Length, Content-Range, Accept-Ranges'
};
