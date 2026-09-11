import { isOwnBackend } from '$lib/shared';
import { getSequelize, migrateDevices } from '$lib/server/database';
import { authenticateDeviceByToken } from '$lib/server/devices';
import { unsign } from 'cookie-signature';
import { env } from '$env/dynamic/private';
import { RateLimiter } from 'sveltekit-rate-limiter/server';
import sodium from 'libsodium-wrappers-sumo';

let captchaKey = '';
let captchaSignature = '';
sodium.ready.then(() => {
	captchaKey = sodium.to_base64(sodium.randombytes_buf(32));
	captchaSignature = sodium.to_base64(sodium.randombytes_buf(32));
});

/** What a television's token may not reach, however well it is behaving. */
const deviceForbidden = [
	/^\/api\/user\/me/,
	/^\/api\/user\/delete/,
	/^\/api\/user\/passwordReset/,
	/^\/api\/user\/create/,
	/^\/api\/user\/login/,
	/^\/api\/user\/logout/,
	/^\/api\/admin/,
	/^\/api\/proxy/
];

let sequelizeAuthenticated = false;

const strictLimiter = new RateLimiter({
	IP: [10, 'm']
});

const sensitivePaths = [
	/^\/api\/user\/create$/,
	/^\/api\/user\/login$/,
	// Pairing hands out a six character code to an unauthenticated caller, and
	// claiming one guesses at codes. Neither is something anybody does ten times
	// a minute, and both are worth a lot to somebody who can do it endlessly.
	/^\/api\/devices\/pair$/,
	/^\/api\/devices\/claim$/
];

export async function handle({ event, resolve }) {
	if (!isOwnBackend()?.internalAuth) {
		return await resolve(event);
	}

	event.locals.captchaKey = captchaKey;
	event.locals.captchaSignature = captchaSignature;

	const sequelize = getSequelize();
	if (!sequelizeAuthenticated) {
		await sequelize.sequelize.sync();
		await sequelize.sequelize.authenticate();
		await migrateDevices();
		sequelizeAuthenticated = true;
	}

	if (!env.COOKIE_SECRET) {
		throw new Error('Cookie secret must be set');
	}

	if (env.COOKIE_SECRET.length < 16) {
		throw new Error('COOKIE_SECRET must be at least 16 characters long');
	}

	const signedUserId = event.cookies.get('userid');
	if (signedUserId) {
		const userId = unsign(signedUserId, env.COOKIE_SECRET);
		if (userId) {
			event.locals.userId = userId;
		}
	}

	// A paired television acts for its owner. It carries a bearer token rather
	// than a session cookie, because it has no browser and no login of its own.
	if (!event.locals.userId) {
		const bearer = event.request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
		if (bearer) {
			const device = await authenticateDeviceByToken(bearer);
			if (device) {
				// A television is not a browser, and this token is not a login.
				// It is a long lived secret sitting on a sideloaded box that
				// anybody with a cable can read, so it acts for the account only
				// where a television needs to: watching, browsing, and the
				// history and lists that make watching work. It may not read the
				// account's key material, change its password, delete it, or
				// fetch arbitrary urls through the proxy - none of which a
				// television has ever needed to do.
				if (deviceForbidden.some((path) => path.test(event.url.pathname))) {
					return new Response(JSON.stringify({ error: 'Not available to a device' }), {
						status: 403,
						headers: { 'Content-Type': 'application/json' }
					});
				}

				event.locals.userId = device.UserId;
			}
		}
	}

	if (!env.PUBLIC_RATE_LIMIT_DISABLED) {
		if (sensitivePaths.some((p) => p.test(event.url.pathname))) {
			if (await strictLimiter.isLimited(event)) {
				return new Response(JSON.stringify({ error: 'Too Many Requests' }), {
					status: 429,
					headers: { 'Content-Type': 'application/json' }
				});
			}
		}
	}

	return await resolve(event);
}
