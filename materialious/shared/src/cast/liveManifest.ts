import type { CastProfile } from './CastSession.js';

/**
 * Builds the manifest for a live stream.
 *
 * Live cannot reuse the manifest a recording gets. YouTube publishes no index
 * for it - no `sidx`, no Cues, no content length - so there is no virtual file
 * to serve byte ranges of. What it does give is segments addressed by
 * presentation time, at a fixed target duration, which is exactly what a
 * `SegmentTemplate` numbered by `$Number$` describes.
 *
 * Segments arrive with their own `ftyp` and `moov`, so no separate
 * initialisation segment is advertised.
 */

export type LiveFormat = {
	itag: number;
	key: string;
	mimeType: string;
	codecs: string;
	bitrate: number;
	width?: number;
	height?: number;
	fps?: number;
	audioSampleRate?: number;
	audioChannels?: number;
	language?: string;
};

export type LiveManifestOptions = {
	baseUrl: string;
	formats: LiveFormat[];
	targetDurationSeconds: number;
	/** Segment number at the live edge when the manifest was built. */
	edgeSegment: number;
	/** Oldest segment still seekable. */
	firstSegment: number;
	profile: CastProfile;
	maxHeight: number;
};

/** How far back a viewer may seek, in segments. */
const TIME_SHIFT_SEGMENTS = 360;

/**
 * How far behind the head the presentation is anchored, in segments.
 *
 * A player works out where "now" is from the wall clock and the availability
 * start time, and the segment at the head is still being produced. Anchoring a
 * little behind it means the first thing a player asks for already exists,
 * whether or not it honours `suggestedPresentationDelay`.
 */
const LIVE_EDGE_SAFETY_SEGMENTS = 3;

function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function playable(format: LiveFormat, profile: CastProfile, maxHeight: number): boolean {
	if ((format.height ?? 0) > maxHeight) return false;

	if (profile === 'legacy') {
		return format.codecs.includes('avc1') || format.codecs.includes('mp4a');
	}

	return !format.codecs.includes('av01');
}

export function buildLiveManifest(options: LiveManifestOptions): string {
	const { baseUrl, targetDurationSeconds, edgeSegment, firstSegment, profile, maxHeight } = options;

	const formats = options.formats.filter((format) => playable(format, profile, maxHeight));

	const video = formats.filter((format) => format.mimeType.startsWith('video/'));
	const audio = formats.filter((format) => format.mimeType.startsWith('audio/'));

	// Everything before the window is gone from the server's point of view, so
	// the manifest should not offer it. YouTube says how far back it will go;
	// the cap keeps a stream that has been running for days from advertising a
	// window no receiver would use. How far back that is is expressed as a time
	// shift depth rather than a first segment number, because numbering has to
	// start where presentation time does - see below.
	const windowStart = Math.max(firstSegment, edgeSegment - TIME_SHIFT_SEGMENTS, 0);
	const windowSegments = Math.max(1, edgeSegment - windowStart);

	// When segment 0 would have been available, which is what anchors a live
	// presentation to the wall clock.
	const anchorSegment = Math.max(windowStart, edgeSegment - LIVE_EDGE_SAFETY_SEGMENTS);
	const availabilityStart = new Date(
		Date.now() - anchorSegment * targetDurationSeconds * 1000
	).toISOString();

	// Numbering starts at zero because a segment's number is its presentation
	// time divided by the target duration, which is how the gateway addresses
	// media. A player derives the same number from `availabilityStartTime`, so
	// both sides agree without either having to know YouTube's own sequence
	// numbers - which drift from presentation time as segments come in slightly
	// under their target duration.
	const segmentTemplate = (format: LiveFormat) =>
		`<SegmentTemplate media="${escapeXml(`${baseUrl}/live/${encodeURIComponent(format.key)}/$Number$`)}" ` +
		`duration="${targetDurationSeconds}" timescale="1" startNumber="0"/>`;

	const representation = (format: LiveFormat) => {
		const attributes = [
			`id="${escapeXml(format.key)}"`,
			`codecs="${escapeXml(format.codecs)}"`,
			`bandwidth="${Math.max(1, Math.round(format.bitrate))}"`
		];

		if (format.width) attributes.push(`width="${format.width}"`);
		if (format.height) attributes.push(`height="${format.height}"`);
		if (format.fps) attributes.push(`frameRate="${format.fps}"`);
		if (format.audioSampleRate) attributes.push(`audioSamplingRate="${format.audioSampleRate}"`);

		const channels = format.audioChannels
			? `<AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="${format.audioChannels}"/>`
			: '';

		return `<Representation ${attributes.join(' ')}>${channels}${segmentTemplate(format)}</Representation>`;
	};

	const adaptationSet = (members: LiveFormat[], index: number) => {
		if (members.length === 0) return '';

		const mimeType = members[0].mimeType;
		const language = members[0].language ? ` lang="${escapeXml(members[0].language)}"` : '';

		return (
			`<AdaptationSet id="${index}" mimeType="${escapeXml(mimeType)}"${language} ` +
			`segmentAlignment="true" startWithSAP="1">` +
			members.map(representation).join('') +
			`</AdaptationSet>`
		);
	};

	// Grouped by container so a player is not offered mp4 and webm in one set.
	const groups: LiveFormat[][] = [];
	for (const set of [video, audio]) {
		for (const container of ['mp4', 'webm']) {
			const members = set.filter((format) => format.mimeType.includes(container));
			if (members.length) groups.push(members);
		}
	}

	const buffer = Math.max(targetDurationSeconds * 3, 10);

	// A little further back again for players that honour it.
	const delay = targetDurationSeconds * 2;

	return (
		`<?xml version="1.0" encoding="utf-8"?>` +
		`<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" ` +
		`profiles="urn:mpeg:dash:profile:isoff-live:2011" ` +
		`availabilityStartTime="${availabilityStart}" ` +
		`publishTime="${new Date().toISOString()}" ` +
		`minimumUpdatePeriod="PT${targetDurationSeconds}S" ` +
		`timeShiftBufferDepth="PT${windowSegments * targetDurationSeconds}S" ` +
		`suggestedPresentationDelay="PT${delay}S" ` +
		`minBufferTime="PT${buffer}S">` +
		`<Period id="0" start="PT0S">` +
		groups.map(adaptationSet).join('') +
		`</Period>` +
		`</MPD>`
	);
}
