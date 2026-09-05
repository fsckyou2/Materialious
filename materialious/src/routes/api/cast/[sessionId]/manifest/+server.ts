import { getCastSession, type CastProfile } from '@materialious/shared/cast';
import { error } from '@sveltejs/kit';
import { castBaseUrl, castCorsHeaders } from '$lib/server/cast';

export async function GET(event) {
	const { params, url } = event;

	const session = getCastSession(params.sessionId);
	if (!session) {
		throw error(404, 'Cast session not found or expired');
	}

	const profile: CastProfile = url.searchParams.get('profile') === 'modern' ? 'modern' : 'legacy';
	const maxHeight = Number(url.searchParams.get('maxHeight') ?? 1080);

	const manifest = await session.getManifest(
		castBaseUrl(event, session.id),
		profile,
		Number.isFinite(maxHeight) ? maxHeight : 1080,
		url.searchParams.get('captions') !== '0'
	);

	return new Response(manifest, {
		headers: {
			'content-type': 'application/dash+xml',
			'cache-control': 'no-store',
			...castCorsHeaders
		}
	});
}

export async function OPTIONS() {
	return new Response(null, { status: 204, headers: castCorsHeaders });
}
