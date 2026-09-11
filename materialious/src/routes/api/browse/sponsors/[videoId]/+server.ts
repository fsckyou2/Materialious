import { BROWSE_CONTRACT_VERSION } from '$lib/server/browse';
import { env } from '$env/dynamic/public';
import { error, json } from '@sveltejs/kit';
import { createHash } from 'node:crypto';

/**
 * The stretches of a video worth skipping, from SponsorBlock.
 *
 * A television has no add-ons and no browser to run one in, so the lookup
 * happens here. It is made by the hash of the video id rather than by the id:
 * SponsorBlock answers a four character prefix with every video that shares it,
 * which means neither SponsorBlock nor anything watching this connection learns
 * which video was asked about.
 */
const SPONSORBLOCK = env.PUBLIC_DEFAULT_SPONSERBLOCK_INSTANCE || 'https://sponsor.ajay.app';

/**
 * What is skipped by default.
 *
 * Everything here is an interruption to what the viewer chose to watch.
 * "filler" - tangents and jokes - is part of the video rather than an
 * interruption to it, so it is not asked for.
 */
const CATEGORIES = [
	'sponsor',
	'selfpromo',
	'interaction',
	'intro',
	'outro',
	'preview',
	'music_offtopic'
];

/** How long a video's segments are worth keeping. They change slowly. */
const CACHE_MS = 30 * 60 * 1000;
const MAX_CACHED = 400;

type Segment = { category: string; start: number; end: number };

const cache = new Map<string, { at: number; segments: Segment[] }>();

function remember(videoId: string, segments: Segment[]): void {
	cache.set(videoId, { at: Date.now(), segments });

	while (cache.size > MAX_CACHED) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
}

export async function GET({ params, locals }) {
	if (!locals.userId) {
		throw error(401);
	}

	const videoId = params.videoId;
	if (videoId.length !== 11) {
		throw error(400, 'Invalid video id');
	}

	const cached = cache.get(videoId);
	if (cached && Date.now() - cached.at < CACHE_MS) {
		return json({ segments: cached.segments, contract: BROWSE_CONTRACT_VERSION });
	}

	const prefix = createHash('sha256').update(videoId).digest('hex').slice(0, 4);
	const url = new URL(`${SPONSORBLOCK.replace(/\/+$/, '')}/api/skipSegments/${prefix}`);
	url.searchParams.set('categories', JSON.stringify(CATEGORIES));

	let answered: unknown;
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(8000) });

		// Nothing in the prefix has any segments at all, which is an answer.
		if (response.status === 404) {
			remember(videoId, []);
			return json({ segments: [], contract: BROWSE_CONTRACT_VERSION });
		}

		if (!response.ok) throw new Error(`SponsorBlock returned ${response.status}`);

		answered = await response.json();
	} catch (err) {
		throw error(502, err instanceof Error ? err.message : 'SponsorBlock is unreachable');
	}

	const videos = Array.isArray(answered) ? answered : [];
	const mine = videos.find((entry) => (entry as { videoID?: string }).videoID === videoId) as
		| { segments?: unknown[] }
		| undefined;

	const segments: Segment[] = (mine?.segments ?? [])
		.map((raw) => {
			const entry = raw as { category?: string; segment?: [number, number] };
			const [start, end] = entry.segment ?? [];

			return {
				category: entry.category ?? '',
				start: Number(start),
				end: Number(end)
			};
		})
		.filter(
			(segment) =>
				CATEGORIES.includes(segment.category) &&
				Number.isFinite(segment.start) &&
				Number.isFinite(segment.end) &&
				segment.end > segment.start
		)
		.sort((a, b) => a.start - b.start);

	remember(videoId, segments);

	return json({ segments, contract: BROWSE_CONTRACT_VERSION });
}
