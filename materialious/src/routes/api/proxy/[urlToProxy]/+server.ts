import { BASE64_BODY_HEADER, isOwnBackend } from '$lib/shared';
import { env } from '$env/dynamic/public';
import { env as privateEnv } from '$env/dynamic/private';
import { Agent } from 'undici';
import fs from 'fs';
import tls from 'tls';

import { error } from '@sveltejs/kit';
import { parse as tldParse } from 'tldts';
import { USER_AGENT } from 'bgutils-js/utils';
import sodium from 'libsodium-wrappers-sumo';

const ALLOWED_HEADERS = [
	'Origin',
	'X-Requested-With',
	'Content-Type',
	'Accept',
	'Authorization',
	'x-goog-visitor-id',
	'x-goog-api-key',
	'x-origin',
	'x-youtube-client-version',
	'x-youtube-client-name',
	'x-goog-api-format-version',
	'x-goog-authuser',
	'x-user-agent',
	'Accept-Language',
	'X-Goog-FieldMask',
	'Range',
	'Referer',
	'Cookie',
	BASE64_BODY_HEADER
].join(', ');

const allowedBaseDomains: string[] = [
	'youtube.com',
	'ytimg.com',
	'googlevideo.com',
	'returnyoutubedislikeapi.com',
  'ajay.app',
	'googleapis.com'
];

if (privateEnv.WHITELIST_BASE_DOMAIN) {
	for (const baseDomain of privateEnv.WHITELIST_BASE_DOMAIN.split(',')) {
		if (baseDomain) allowedBaseDomains.push(baseDomain);
	}
}

const dynamicAllowDomainsEnvVars = [
	env.PUBLIC_DEFAULT_DEARROW_THUMBNAIL_INSTANCE,
	env.PUBLIC_DEFAULT_DEARROW_INSTANCE,
	env.PUBLIC_DEFAULT_INVIDIOUS_INSTANCE,
	env.PUBLIC_DEFAULT_RETURNYTDISLIKES_INSTANCE,
	env.PUBLIC_DEFAULT_API_EXTENDED_INSTANCE,
	env.PUBLIC_DEFAULT_COMPANION_INSTANCE
];

const dynamicAllowDomains: string[] = [];

for (const dynamicDomain of dynamicAllowDomainsEnvVars) {
	if (dynamicDomain) {
		dynamicAllowDomains.push(dynamicDomain.replace(/^https?:\/\//, ''));
	}
}

/**
 * A path that is not going to answer should be given up on while there is still
 * time to ask again, rather than spending the whole budget finding out. Four
 * seconds is far longer than a reachable host needs.
 */
const CONNECT_TIMEOUT_MS = 4_000;

/** Upstream answers in well under a second when it is answering at all. */
const HEADERS_TIMEOUT_MS = 8_000;

/**
 * Media segments keep arriving long after their headers did, so this is an
 * allowance for silence rather than for the size of the thing being sent.
 */
const BODY_TIMEOUT_MS = 60_000;

let dispatcher: Agent;

const certPath = privateEnv.PROXY_TRUST_CA;
const agentOptions = {
	// Reaching the host, and hearing the first of its answer, are the parts
	// worth putting a clock on. Timing the whole exchange instead cuts off long
	// replies that were arriving perfectly well.
	connectTimeout: CONNECT_TIMEOUT_MS,
	headersTimeout: HEADERS_TIMEOUT_MS,
	bodyTimeout: BODY_TIMEOUT_MS
};

if (certPath && fs.existsSync(certPath)) {
	dispatcher = new Agent({
		...agentOptions,
		connect: {
			timeout: CONNECT_TIMEOUT_MS,
			ca: [fs.readFileSync(certPath), ...tls.rootCertificates]
		}
	});
} else {
	dispatcher = new Agent({ ...agentOptions, connect: { timeout: CONNECT_TIMEOUT_MS } });
}

/** Undici reports the reason for a failed fetch as the cause of a plain error. */
function failureCode(err: unknown): string {
	let cause: unknown = err;

	for (let depth = 0; depth < 4 && cause; depth++) {
		const code = (cause as { code?: unknown }).code;
		if (typeof code === 'string') return code;
		cause = (cause as { cause?: unknown }).cause;
	}

	return (err as { name?: string })?.name ?? 'Error';
}

/**
 * Whether asking again could plausibly do better.
 *
 * All of these happen before any of the answer has been read, so a second
 * attempt repeats nothing and opens a fresh connection, which upstream usually
 * answers at once. A refusal or a bad response is not here: that is upstream
 * saying something, and it would say the same thing again.
 */
const RETRYABLE = new Set([
	'UND_ERR_CONNECT_TIMEOUT',
	'UND_ERR_HEADERS_TIMEOUT',
	'UND_ERR_SOCKET',
	'ECONNRESET',
	'ECONNREFUSED',
	'ETIMEDOUT',
	'EAI_AGAIN',
	'TimeoutError'
]);

async function proxyRequest(
	request: Request,
	urlToProxy: string,
	userId: string | undefined = undefined
): Promise<Response> {
	const backendRestrictions = isOwnBackend();
	if (!backendRestrictions) {
		// Shouldn't be possible.
		throw error(400, 'How did you get here?');
	}

	if (backendRestrictions.requireAuth && !userId) {
		throw error(401, 'Auth required');
	}

	let urlToProxyObj: URL;
	try {
		urlToProxyObj = new URL(decodeURIComponent(urlToProxy));
	} catch {
		throw error(400, 'Invalid URL');
	}

	const baseDomain = tldParse(urlToProxyObj.host).domain;

	if (
		!dynamicAllowDomains.includes(urlToProxyObj.host) &&
		(!baseDomain || !allowedBaseDomains.includes(baseDomain))
	) {
		// allowAnyProxy allows a instance owner to bypass the whitelist.
		// BUT is extremely strict.
		// AND I still don't recommend this.
		if (
			!backendRestrictions.allowAnyProxy ||
			!backendRestrictions.requireAuth ||
			backendRestrictions.registrationAllowed ||
			!userId
		) {
			throw error(400, 'URL not whitelisted');
		}
	}

	const requestHeaders = new Headers(request.headers);
	requestHeaders.set('host', urlToProxyObj.host);
	requestHeaders.set('origin', urlToProxyObj.origin);
	requestHeaders.set('user-agent', USER_AGENT);

	// Remove headers that may cause issues or be auto-managed
	for (const key of [
		'referer',
		'x-forwarded-for',
		'x-requested-with',
		'sec-ch-ua-mobile',
		'sec-ch-ua',
		'sec-ch-ua-platform',
		'cookie', // Ensure auth cookies don't become included.
		'content-type',
		'content-length'
	]) {
		requestHeaders.delete(key);
	}

	const requestOptions: RequestInit = {
		method: request.method,
		headers: requestHeaders,
		credentials: 'same-origin',
		...(request.body ? { duplex: 'half' } : {})
	};

	const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
	const isBase64Body = hasBody && request.headers.has(BASE64_BODY_HEADER);

	requestHeaders.delete(BASE64_BODY_HEADER);

	let body: any = request.body;
	if (body) {
		if (isBase64Body) {
			await sodium.ready;
			try {
				body = sodium.from_base64(await request.text());
			} catch {
				throw error(400, 'Malformed base64 request body');
			}
		} else if (hasBody) {
			body = await request.blob();
		}
	}

	// Upstream occasionally hangs rather than being slow: a call that usually
	// answers in well under a second sits there until the timeout, and the page
	// waiting on it has nothing to show for the wait. A second attempt opens a
	// fresh connection and normally answers at once. The body is held in memory
	// by this point and can be sent twice.
	const attempts = 2;

	// Which call it was is the first thing anyone reading the log wants, and the
	// query carries signatures and tokens, so it is left out.
	const target = `${request.method} ${urlToProxyObj.host}${urlToProxyObj.pathname}`;

	let response: Response | undefined;
	let errorMsg = '';

	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			response = await fetch(urlToProxyObj.toString(), {
				...requestOptions,
				body,
				// @ts-expect-error Node-specific option
				dispatcher
			});
			errorMsg = '';
			break;
		} catch (err) {
			const code = failureCode(err);
			errorMsg = (err as any).toString();

			if (RETRYABLE.has(code) && attempt < attempts) {
				console.warn(`Proxy ${code}, asking once more: ${target}`);
				continue;
			}

			console.warn(`Proxy failed (${code}): ${target}`);
			break;
		}
	}

	if (!response || errorMsg) {
		throw error(500, errorMsg);
	}

	const responseHeaders = new Headers(response.headers);
	responseHeaders.delete('content-encoding');
	responseHeaders.delete('content-length');

	return new Response(response.body, {
		status: response.status,
		headers: responseHeaders
	});
}

export async function GET({ request, params, locals }) {
	return await proxyRequest(request, params.urlToProxy, locals.userId);
}
export async function PATCH({ request, params, locals }) {
	return await proxyRequest(request, params.urlToProxy, locals.userId);
}

export async function DELETE({ request, params, locals }) {
	return await proxyRequest(request, params.urlToProxy, locals.userId);
}

export async function PUT({ request, params, locals }) {
	return await proxyRequest(request, params.urlToProxy, locals.userId);
}

export async function POST({ request, params, locals }) {
	return await proxyRequest(request, params.urlToProxy, locals.userId);
}

export async function OPTIONS({ request }) {
	return new Response('', {
		status: 200,
		headers: new Headers({
			'Access-Control-Allow-Origin': request.headers.get('origin') || '',
			'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, OPTIONS',
			'Access-Control-Allow-Headers': ALLOWED_HEADERS,
			'Access-Control-Max-Age': '86400',
			'Access-Control-Allow-Credentials': 'true'
		})
	});
}
