import { Constants, YT, type Innertube, type Mixins } from 'youtubei.js';
import {
	SabrStreamingAdapter,
	SabrUmpProcessor,
	type RequestFilter,
	type ResponseFilter,
	type SabrPlayerAdapter
} from 'googlevideo/sabr-streaming-adapter';
import { buildSabrFormat, FormatKeyUtils } from 'googlevideo/utils';
import type { CacheManager, RequestMetadataManager } from 'googlevideo/utils';
import type { SabrFormat } from 'googlevideo/shared-types';
import { getDownloadSession } from '../download/session.js';
import { parseSegmentIndex, type SegmentIndexEntry } from './sidx.js';

/**
 * Codec profiles a receiver can be asked to play.
 *
 * Chromecast generations 1-3 decode H.264 and AAC only, so that is the default.
 * Newer Google TV hardware handles VP9 and Opus, which YouTube ships at lower
 * bitrates for the same quality.
 */
export type CastProfile = 'legacy' | 'modern';

export type CastMediaSource = 'vod' | 'live';

type FormatState = {
	format: SabrFormat;
	/** The moov + sidx blob, served verbatim for ranges that land in it. */
	init: Uint8Array;
	segments: SegmentIndexEntry[];
	totalSize: number;
};

const SEGMENT_CACHE_LIMIT = 24;

function decodeXmlEntities(value: string): string {
	return value
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'");
}

/**
 * Drops subtitle tracks from a manifest.
 *
 * Not every player copes with text adaptation sets - ffmpeg's DASH demuxer
 * fails outright on them - so a receiver that trips over subtitles can be given
 * a manifest without any.
 */
function stripTextAdaptationSets(manifest: string): string {
	return manifest.replace(
		/<AdaptationSet(?:(?!<\/AdaptationSet>)[\s\S])*?contentType="text"[\s\S]*?<\/AdaptationSet>/g,
		''
	);
}

/**
 * Player adapter with no player behind it.
 *
 * `SabrStreamingAdapter` normally drives Shaka: it asks the player what time
 * playback is at and rewrites the requests the player makes. Here every request
 * originates from a receiver's HTTP range instead, so the "player time" is
 * whatever segment we are being asked for, and the interceptors are called by
 * hand rather than registered with a networking engine.
 */
class HeadlessPlayerAdapter implements SabrPlayerAdapter {
	public requestMetadataManager?: RequestMetadataManager;
	public cache: CacheManager | null = null;
	public requestInterceptor?: RequestFilter;
	public responseInterceptor?: ResponseFilter;

	/** Presentation time of the segment currently being fetched, in seconds. */
	public playerTime = 0;
	/** The audio/video pair this session serves, so the other can be discarded. */
	public pinned: { audio?: SabrFormat; video?: SabrFormat } = {};

	initialize(
		_player: unknown,
		requestMetadataManager: RequestMetadataManager,
		cache: CacheManager | null
	): void {
		this.requestMetadataManager = requestMetadataManager;
		this.cache = cache;
	}

	getPlayerTime(): number {
		return this.playerTime;
	}

	getPlaybackRate(): number {
		return 1;
	}

	getBandwidthEstimate(): number {
		// The receiver picks the rendition; we only ever fetch what it asks for,
		// so this just has to be high enough not to look like a stalling client.
		return 10_000_000;
	}

	getActiveTrackFormats(activeFormat: SabrFormat): {
		audioFormat?: SabrFormat;
		videoFormat?: SabrFormat;
	} {
		return activeFormat.width
			? { videoFormat: activeFormat, audioFormat: this.pinned.audio }
			: { videoFormat: this.pinned.video, audioFormat: activeFormat };
	}

	registerRequestInterceptor(interceptor: RequestFilter): void {
		this.requestInterceptor = interceptor;
	}

	registerResponseInterceptor(interceptor: ResponseFilter): void {
		this.responseInterceptor = interceptor;
	}

	dispose(): void {
		this.requestInterceptor = undefined;
		this.responseInterceptor = undefined;
	}
}

/**
 * A cast session: everything needed to answer a receiver's requests for one
 * video, held server side because the receiver cannot speak SABR itself.
 */
export class CastSession {
	public lastUsed = Date.now();

	private readonly adapter = new HeadlessPlayerAdapter();
	private sabr!: SabrStreamingAdapter;
	private formats: SabrFormat[] = [];

	private readonly formatStates = new Map<string, FormatState>();
	private readonly pendingStates = new Map<string, Promise<FormatState>>();
	private readonly segmentCache = new Map<string, Uint8Array>();
	private readonly pendingSegments = new Map<string, Promise<Uint8Array>>();

	private constructor(
		public readonly id: string,
		public readonly videoId: string,
		public readonly userId: string | undefined,
		private innertube: Innertube,
		private info: YT.VideoInfo | Mixins.MediaInfo
	) {}

	static async create(
		id: string,
		videoId: string,
		userId: string | undefined,
		cacheDir?: string
	): Promise<CastSession> {
		const innertube = await getDownloadSession(videoId, cacheDir);
		const info = await innertube.getInfo(videoId);

		const session = new CastSession(id, videoId, userId, innertube, info);
		await session.attachSabr();
		return session;
	}

	get title(): string {
		return this.info.basic_info.title ?? '';
	}

	get author(): string {
		return this.info.basic_info.author ?? '';
	}

	get durationSeconds(): number {
		return this.info.basic_info.duration ?? 0;
	}

	get source(): CastMediaSource {
		return this.info.basic_info.is_live ? 'live' : 'vod';
	}

	private async attachSabr(): Promise<void> {
		const client = this.innertube.session.context.client;
		const streamingData = this.info.streaming_data;

		if (!streamingData) {
			throw new Error('Video has no streaming data');
		}

		this.formats = (streamingData.adaptive_formats ?? []).map(buildSabrFormat);

		this.sabr = new SabrStreamingAdapter({
			playerAdapter: this.adapter,
			clientInfo: {
				osName: client.osName,
				osVersion: client.osVersion,
				clientName: parseInt(
					Constants.CLIENT_NAME_IDS[client.clientName as keyof typeof Constants.CLIENT_NAME_IDS]
				),
				clientVersion: client.clientVersion
			}
		});

		this.sabr.onMintPoToken(async () => this.innertube.session.po_token ?? '');
		this.sabr.onReloadPlayerResponse(async (reloadContext) => {
			await this.reloadPlayerResponse(reloadContext);
		});

		this.sabr.setServerAbrFormats(this.formats);
		this.sabr.setUstreamerConfig(
			this.info.player_config?.media_common_config.media_ustreamer_request_config
				?.video_playback_ustreamer_config
		);

		if (!this.innertube.session.player) {
			throw new Error('Player script is required for cast sessions');
		}

		this.sabr.setStreamingURL(
			await this.innertube.session.player.decipher(streamingData.server_abr_streaming_url)
		);

		this.sabr.attach({});

		// Pin the highest H.264 and AAC pair by default; the receiver may switch
		// renditions later, and `getActiveTrackFormats` follows whatever it asks
		// for. This only decides which track is marked as already buffered.
		this.adapter.pinned = {
			audio: this.formats.find((format) => format.mimeType?.includes('mp4a')),
			video: this.formats.find((format) => format.mimeType?.includes('avc1'))
		};
	}

	/** Re-fetches the player response when the SABR server invalidates ours. */
	private async reloadPlayerResponse(reloadContext: unknown): Promise<void> {
		const reloaded = await this.innertube.actions.execute('/player', {
			videoId: this.videoId,
			contentCheckOk: true,
			racyCheckOk: true,
			playbackContext: {
				contentPlaybackContext: {
					signatureTimestamp: this.innertube.session.player?.signature_timestamp
				},
				reloadPlaybackContext: reloadContext
			}
		});

		const info = new YT.VideoInfo(
			[reloaded],
			this.innertube.actions,
			(this.info as Mixins.MediaInfo).cpn
		);

		this.info = info;

		if (!info.streaming_data || !this.innertube.session.player) return;

		this.sabr.setStreamingURL(
			await this.innertube.session.player.decipher(info.streaming_data.server_abr_streaming_url)
		);
		this.sabr.setUstreamerConfig(
			info.player_config?.media_common_config.media_ustreamer_request_config
				?.video_playback_ustreamer_config
		);
	}

	/**
	 * Runs one request through the SABR interceptor pair and returns the media
	 * bytes. Mirrors what `ShakaPlayerAdapter` does inside the browser.
	 */
	private async sabrRequest(options: {
		url: string;
		headers: Record<string, string>;
		startTime: number | null;
		isInit: boolean;
	}): Promise<Uint8Array> {
		if (!this.adapter.requestInterceptor || !this.adapter.responseInterceptor) {
			throw new Error('SABR adapter is not attached');
		}

		const request = await this.adapter.requestInterceptor({
			url: options.url,
			method: 'GET',
			headers: { ...options.headers },
			segment: {
				getStartTime: () => options.startTime,
				isInit: () => options.isInit
			},
			body: null
		});

		if (!request) {
			throw new Error('SABR request was dropped by the adapter');
		}

		const response = await fetch(request.url, {
			method: request.method,
			headers: request.headers,
			body: request.body as BodyInit
		});

		const metadata = this.adapter.requestMetadataManager?.getRequestMetadata(request.url);
		let data: Uint8Array | undefined;

		if (metadata && response.headers.get('content-type') === 'application/vnd.yt-ump') {
			const processor = new SabrUmpProcessor(metadata, this.adapter.cache ?? undefined);
			const reader = response.body?.getReader();

			if (!reader) throw new Error('SABR response had no body');

			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				const result = await processor.processChunk(value);
				if (result?.data) {
					data = result.data;
					await reader.cancel().catch(() => {});
					break;
				}
			}
		} else {
			data = new Uint8Array(await response.arrayBuffer());
		}

		// Redirects, context updates and player reloads are all signalled in the
		// response rather than by status code, so the adapter has to see it.
		const handled = await this.adapter.responseInterceptor({
			url: request.url,
			method: request.method,
			headers: Object.fromEntries(response.headers),
			data,
			makeRequest: async (url, headers) => ({
				url,
				method: 'POST',
				headers: {},
				data: await this.sabrRequest({
					url,
					headers: headers ?? {},
					startTime: options.startTime,
					isInit: options.isInit
				})
			})
		});

		const resolved = (handled?.data as Uint8Array | undefined) ?? data;

		if (!resolved) {
			throw new Error('SABR request produced no media data');
		}

		return resolved;
	}

	private formatUrl(format: SabrFormat): string {
		return `sabr://${format.width ? 'video' : 'audio'}?key=${FormatKeyUtils.fromFormat(format)}`;
	}

	private rawFormat(itag: number) {
		return (this.info.streaming_data?.adaptive_formats ?? []).find(
			(format) => format.itag === itag
		);
	}

	/** Fetches (once) the init blob and segment index for a format. */
	private async getFormatState(key: string): Promise<FormatState> {
		const cached = this.formatStates.get(key);
		if (cached) return cached;

		const pending = this.pendingStates.get(key);
		if (pending) return pending;

		const promise = (async (): Promise<FormatState> => {
			const format = this.formats.find((candidate) => FormatKeyUtils.fromFormat(candidate) === key);
			if (!format) throw new Error(`Unknown format ${key}`);

			const raw = this.rawFormat(format.itag);
			const indexStart = raw?.index_range?.start ?? 0;
			const indexEnd = raw?.index_range?.end;

			if (indexEnd === undefined) {
				throw new Error(`Format ${key} has no index range`);
			}

			this.adapter.playerTime = 0;
			const init = await this.sabrRequest({
				url: this.formatUrl(format),
				headers: { Range: `bytes=0-${indexEnd}` },
				startTime: 0,
				isInit: true
			});

			const segments = parseSegmentIndex(init, indexStart, indexEnd + 1);
			if (!segments?.length) {
				throw new Error(`Could not read a segment index for format ${key}`);
			}

			const state: FormatState = {
				format,
				init,
				segments,
				totalSize: Number(raw?.content_length ?? segments[segments.length - 1].end + 1)
			};

			this.formatStates.set(key, state);
			this.pendingStates.delete(key);
			return state;
		})();

		this.pendingStates.set(key, promise);
		promise.catch(() => this.pendingStates.delete(key));
		return promise;
	}

	private async getSegment(key: string, entry: SegmentIndexEntry): Promise<Uint8Array> {
		const cacheKey = `${key}@${entry.start}`;

		const cached = this.segmentCache.get(cacheKey);
		if (cached) return cached;

		const pending = this.pendingSegments.get(cacheKey);
		if (pending) return pending;

		const promise = (async () => {
			const state = await this.getFormatState(key);
			this.adapter.playerTime = entry.startTime;

			const data = await this.sabrRequest({
				url: this.formatUrl(state.format),
				headers: {},
				startTime: entry.startTime,
				isInit: false
			});

			this.segmentCache.set(cacheKey, data);
			while (this.segmentCache.size > SEGMENT_CACHE_LIMIT) {
				const oldest = this.segmentCache.keys().next().value;
				if (oldest === undefined) break;
				this.segmentCache.delete(oldest);
			}

			this.pendingSegments.delete(cacheKey);
			return data;
		})();

		this.pendingSegments.set(cacheKey, promise);
		promise.catch(() => this.pendingSegments.delete(cacheKey));
		return promise;
	}

	/**
	 * Absorbs the backoff YouTube imposes on a session's first SABR request.
	 *
	 * That first request waits several seconds; later ones return in about a
	 * tenth of a second. Spending it here, while the viewer is still watching a
	 * connecting spinner, keeps the receiver from stalling on its own first
	 * fetch. Failure is not fatal - the receiver would simply wait instead.
	 */
	async warmUp(): Promise<void> {
		const audio = this.formats.find((format) => format.mimeType?.includes('mp4a'));
		if (!audio) return;

		try {
			await this.getFormatState(FormatKeyUtils.fromFormat(audio) ?? '');
		} catch {
			// Continue regardless; the gateway will retry when asked for real.
		}
	}

	/**
	 * Fetches a subtitle track for the receiver.
	 *
	 * YouTube answers a bare timedtext URL with an empty body: the parameters the
	 * browser player adds are what make it return actual cues, so the same ones
	 * are applied here. Only YouTube's own hosts are accepted, so a session id
	 * cannot be turned into a general purpose proxy.
	 */
	async getCaption(target: string): Promise<string> {
		this.lastUsed = Date.now();

		const url = new URL(target);

		if (url.host !== 'www.youtube.com' && url.host !== 'youtube.com') {
			throw new Error('Caption url is not whitelisted');
		}

		url.searchParams.set('fmt', 'vtt');
		url.searchParams.set('potc', '1');
		url.searchParams.set('c', this.innertube.session.context.client.clientName);
		if (this.innertube.session.po_token) {
			url.searchParams.set('pot', this.innertube.session.po_token);
		}
		url.searchParams.delete('xosf');

		const response = await fetch(url, { signal: AbortSignal.timeout(10000) });

		if (!response.ok) {
			throw new Error(`Captions unavailable (${response.status})`);
		}

		return await response.text();
	}

	/** Total byte length a receiver should believe a format has. */
	async getFormatSize(key: string): Promise<number> {
		return (await this.getFormatState(key)).totalSize;
	}

	async getFormatMimeType(key: string): Promise<string> {
		const state = await this.getFormatState(key);
		return state.format.mimeType?.split(';')[0] ?? 'video/mp4';
	}

	/**
	 * Yields the bytes covering `[start, end]` of a format's virtual file,
	 * fetching only the segments the range actually touches.
	 */
	async *readRange(
		key: string,
		start: number,
		end: number,
		isAborted: () => boolean = () => false
	): AsyncGenerator<Uint8Array> {
		this.lastUsed = Date.now();
		const state = await this.getFormatState(key);

		const pieces: { start: number; end: number; get: () => Promise<Uint8Array> }[] = [
			{ start: 0, end: state.init.length - 1, get: async () => state.init },
			...state.segments.map((entry) => ({
				start: entry.start,
				end: entry.end,
				get: () => this.getSegment(key, entry)
			}))
		];

		let cursor = start;

		for (const piece of pieces) {
			if (isAborted()) return;
			if (piece.end < cursor || piece.start > end) continue;

			const data = await piece.get();
			const from = cursor - piece.start;
			const to = Math.min(data.length - 1, end - piece.start);
			if (to < from) continue;

			yield data.slice(from, to + 1);

			cursor = piece.start + to + 1;
			if (cursor > end) return;
		}
	}

	/**
	 * Builds the manifest handed to the receiver: the same DASH presentation the
	 * browser player uses, with the `sabr://` URLs pointed back at this gateway.
	 */
	async getManifest(
		baseUrl: string,
		profile: CastProfile,
		maxHeight: number,
		captions = true
	): Promise<string> {
		this.lastUsed = Date.now();

		const manifest = await this.info.toDash({
			format_filter: (format) => {
				const mimeType = format.mime_type ?? '';
				const height = format.height ?? 0;

				if (height > maxHeight) return true;

				if (profile === 'legacy') {
					// Everything a first generation Chromecast can decode, and
					// nothing it cannot.
					return !(mimeType.includes('avc1') || mimeType.includes('mp4a'));
				}

				return mimeType.includes('av01');
			},
			manifest_options: {
				is_sabr: true,
				include_thumbnails: false,
				...(captions ? { captions_format: 'vtt' as const } : {})
			}
		});

		// `url_transformer` is ignored while `is_sabr` is set, so the emitted
		// sabr:// URLs are rewritten here. A path segment keeps the XML free of
		// the ampersands a query string would need escaped.
		const rewritten = manifest
			.replace(
				/sabr:\/\/(?:video|audio)\?key=([^<"]*)/g,
				(_match, key: string) => `${baseUrl}/media/${encodeURIComponent(key)}`
			)
			.replace(
				/<BaseURL>(https:\/\/[^<]*timedtext[^<]*)<\/BaseURL>/g,
				(_match, url: string) =>
					// The URL is XML encoded in the manifest, so its entities have to
					// be resolved before it is re-encoded as a query parameter -
					// otherwise the gateway would fetch a literal "&amp;" separator
					// and YouTube would ignore every parameter after the first.
					`<BaseURL>${baseUrl}/caption?url=${encodeURIComponent(decodeXmlEntities(url))}</BaseURL>`
			);

		return captions ? rewritten : stripTextAdaptationSets(rewritten);
	}

	dispose(): void {
		this.sabr?.dispose();
		this.adapter.dispose();
		this.formatStates.clear();
		this.segmentCache.clear();
	}
}
