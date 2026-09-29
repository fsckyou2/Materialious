import type { Thumbnail } from './model';

/**
 * Where a video's pictures live when the item it arrived in did not carry them.
 *
 * YouTube returns the same video through a growing number of node shapes, and
 * keeps moving the image between fields as it migrates surfaces to lockups.
 * Whenever a shape turns up that the parsing library does not read yet, the
 * item arrives with no picture at all and the card renders as a grey box.
 *
 * These paths are served for every video regardless of the shape it was listed
 * in, so they are what is left to fall back on. Only the two sizes below exist
 * for all videos; the ones in the original aspect ratio do not.
 */
export function thumbnailsForVideoId(videoId: string): Thumbnail[] {
	if (!videoId) return [];

	return [
		{ url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, width: 480, height: 360 },
		{ url: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`, width: 320, height: 180 }
	];
}

/**
 * The same picture, for callers that hold one URL rather than a list.
 */
export function thumbnailUrlForVideoId(videoId: string): string {
	return thumbnailsForVideoId(videoId)[0]?.url ?? '';
}

/**
 * A short is filmed upright, so the widescreen frame above would letterbox it.
 * This is the same frame in the shape it was filmed in.
 */
export function shortsThumbnailUrl(videoId: string): string {
	if (!videoId) return '';

	return `https://i.ytimg.com/vi/${videoId}/oardefault.jpg`;
}

/**
 * Pictures to try for a video, in order, when the one it came with may not load.
 *
 * The larger sizes - hq720, maxres, and the upright one shorts use - are made a
 * while after upload, and never at all for some older videos, so a video that
 * went up recently often points at one that answers 404 for the time being. The
 * two sizes above are there from the start and are what is left to fall back on.
 *
 * They are asked for from wherever the preferred picture was served, so a
 * picture from an Invidious instance falls back to that instance rather than
 * going to YouTube directly. Only a picture whose address says nothing about
 * where the others live falls back to YouTube's own.
 */
export function thumbnailCandidates(preferred: string, videoId: string): string[] {
	const candidates = [preferred];

	const sameHost = sameHostThumbnails(preferred);
	if (sameHost.length > 0) {
		candidates.push(...sameHost);
	} else {
		candidates.push(...thumbnailsForVideoId(videoId).map((thumbnail) => thumbnail.url));
	}

	return [...new Set(candidates.filter(Boolean))];
}

function sameHostThumbnails(source: string): string[] {
	let url: URL;
	try {
		url = new URL(source.startsWith('//') ? `https:${source}` : source);
	} catch {
		return [];
	}

	if (url.protocol !== 'https:' && url.protocol !== 'http:') return [];

	// YouTube and Invidious both lay pictures out as /vi/<id>/<size>.jpg, with
	// /vi_webp/ for the same pictures in another format.
	const match = url.pathname.match(/^(.*)\/vi(?:_webp)?\/([^/]+)\/[^/]+$/);
	if (!match) return [];

	const base = `${url.origin}${match[1]}/vi/${match[2]}`;
	return [`${base}/hqdefault.jpg`, `${base}/mqdefault.jpg`];
}
