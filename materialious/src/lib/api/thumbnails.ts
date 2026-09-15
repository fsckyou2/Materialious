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
