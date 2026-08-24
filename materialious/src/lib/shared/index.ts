import { env } from '$env/dynamic/public';

/**
 * Marks a proxied request body as base64 encoded.
 *
 * The name must stay hyphenated. Reverse proxies routinely drop headers whose
 * names contain underscores — nginx does so by default via
 * `underscores_in_headers off` — which leaves the server treating the base64
 * text as if it were the original binary body. For SABR media requests YouTube
 * then rejects the payload with `sabr.malformed_config` and playback stalls
 * forever without surfacing an error.
 */
export const BASE64_BODY_HEADER = 'x-materialious-base64-body';

export type IsOwnBackend = {
	builtWithBackend: boolean;
	internalAuth: boolean;
	requireAuth: boolean;
	registrationAllowed: boolean;
	allowAnyProxy: boolean;
	captchaDisabled: boolean;
};

export function isOwnBackend(): IsOwnBackend | null {
	if (env.PUBLIC_BUILD_WITH_BACKEND !== 'true') return null;

	return {
		builtWithBackend: true,
		internalAuth: env.PUBLIC_INTERNAL_AUTH !== 'false',
		requireAuth: env.PUBLIC_REQUIRE_AUTH !== 'false',
		registrationAllowed: env.PUBLIC_REGISTRATION_ALLOWED === 'true',
		allowAnyProxy: env.PUBLIC_DANGEROUS_ALLOW_ANY_PROXY === 'true',
		captchaDisabled: env.PUBLIC_CAPTCHA_DISABLED === 'true'
	};
}

function getAdminUsernames(): string[] {
	return (env.PUBLIC_ADMIN_USERNAMES || '')
		.split(',')
		.map((s) => s.trim());
}

export function isAdminUsername(username: string): boolean {
	return getAdminUsernames().includes(username);
}
