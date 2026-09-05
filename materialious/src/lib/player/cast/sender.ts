import { get, writable, type Writable } from 'svelte/store';

/**
 * Google Cast sender.
 *
 * The receiver is Google's stock media receiver: it is handed a DASH manifest
 * served by our own gateway, because a Chromecast cannot speak YouTube's SABR
 * protocol itself. Everything the receiver plays therefore comes from the
 * instance, ad free for the same reason the browser player is.
 */

const CAST_SDK_URL = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';

export type CastStatus = {
	/** The SDK loaded and at least one receiver could be used. */
	available: boolean;
	connected: boolean;
	deviceName: string | null;
	videoId: string | null;
	title: string | null;
	currentTime: number;
	duration: number;
	paused: boolean;
	/** Height cap currently in force, so the quality picker can show it. */
	maxHeight: number;
	/** Thumbnail last sent to the receiver, reused when reloading media. */
	poster: string | null;
	/** Set when a cast attempt failed, for surfacing to the viewer. */
	errorMessage: string | null;
};

/** Height caps offered while casting. 0 means "let the receiver decide". */
export const CAST_QUALITIES = [0, 1080, 720, 480, 360] as const;

export const castStatus: Writable<CastStatus> = writable({
	available: false,
	connected: false,
	deviceName: null,
	videoId: null,
	title: null,
	currentTime: 0,
	duration: 0,
	paused: false,
	maxHeight: 1080,
	poster: null,
	errorMessage: null
});

let remotePlayer: any;
let remoteController: any;
let sdkPromise: Promise<boolean> | undefined;

function cast(): any {
	return (window as any).cast;
}

function chromeCast(): any {
	return (window as any).chrome?.cast;
}

/** True when this browser can cast at all: Chromium exposes the SDK, others do not. */
export function isCastSupported(): boolean {
	return typeof window !== 'undefined' && !!(window as any).chrome && !('safari' in window);
}

/**
 * Loads the Cast sender SDK once and wires up the remote player.
 *
 * Resolves false when the SDK never reports itself available, which is the
 * normal outcome in browsers without Cast support.
 */
export function loadCastSdk(): Promise<boolean> {
	if (sdkPromise) return sdkPromise;

	sdkPromise = new Promise<boolean>((resolve) => {
		if (!isCastSupported()) {
			resolve(false);
			return;
		}

		const timeout = setTimeout(() => resolve(false), 8000);

		(window as any).__onGCastApiAvailable = (isAvailable: boolean) => {
			clearTimeout(timeout);

			if (!isAvailable) {
				resolve(false);
				return;
			}

			try {
				initialise();
				castStatus.update((status) => ({ ...status, available: true }));
				resolve(true);
			} catch {
				resolve(false);
			}
		};

		const script = document.createElement('script');
		script.src = CAST_SDK_URL;
		script.async = true;
		script.onerror = () => {
			clearTimeout(timeout);
			resolve(false);
		};
		document.head.appendChild(script);
	});

	return sdkPromise;
}

function initialise(): void {
	const context = cast().framework.CastContext.getInstance();

	context.setOptions({
		receiverApplicationId: chromeCast().media.DEFAULT_MEDIA_RECEIVER_APP_ID,
		autoJoinPolicy: chromeCast().AutoJoinPolicy.ORIGIN_SCOPED
	});

	remotePlayer = new (cast().framework.RemotePlayer)();
	remoteController = new (cast().framework.RemotePlayerController)(remotePlayer);

	const sync = () => {
		castStatus.update((status) => ({
			...status,
			connected: !!remotePlayer.isConnected,
			deviceName:
				cast().framework.CastContext.getInstance().getCurrentSession()?.getCastDevice()
					?.friendlyName ?? status.deviceName,
			currentTime: remotePlayer.currentTime ?? 0,
			duration: remotePlayer.duration ?? 0,
			paused: !!remotePlayer.isPaused
		}));
	};

	const events = cast().framework.RemotePlayerEventType;
	for (const event of [
		events.IS_CONNECTED_CHANGED,
		events.IS_PAUSED_CHANGED,
		events.CURRENT_TIME_CHANGED,
		events.DURATION_CHANGED,
		events.PLAYER_STATE_CHANGED
	]) {
		remoteController.addEventListener(event, sync);
	}

	remoteController.addEventListener(events.IS_CONNECTED_CHANGED, () => {
		if (!remotePlayer.isConnected) {
			castStatus.update((status) => ({
				...status,
				connected: false,
				videoId: null,
				title: null,
				currentTime: 0,
				duration: 0
			}));
		}
	});
}

type CastSessionResponse = {
	sessionId: string;
	title: string;
	author: string;
	duration: number;
	source: 'vod' | 'live';
	manifestUrl: string;
};

/**
 * Starts (or reuses) a receiver session and plays a video on it.
 *
 * @param videoId - Video to cast.
 * @param startTime - Where to resume from, matching the local player.
 * @param poster - Thumbnail shown on the television.
 */
export async function castVideo(options: {
	videoId: string;
	startTime?: number;
	poster?: string;
	profile?: 'legacy' | 'modern';
	maxHeight?: number;
}): Promise<void> {
	castStatus.update((status) => ({ ...status, errorMessage: null }));

	const loaded = await loadCastSdk();
	if (!loaded) {
		throw new Error('Casting is not available in this browser');
	}

	const context = cast().framework.CastContext.getInstance();

	if (!context.getCurrentSession()) {
		// Opens the device picker; rejects if the viewer cancels it.
		await context.requestSession();
	}

	const session = context.getCurrentSession();
	if (!session) {
		throw new Error('No cast session');
	}

	const response = await fetch('/api/cast', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ videoId: options.videoId })
	});

	if (!response.ok) {
		const message = await response.text();
		throw new Error(message || 'Failed to prepare the video for casting');
	}

	const castSession: CastSessionResponse = await response.json();

	const load = async (captions: boolean) => {
		const manifestUrl = new URL(castSession.manifestUrl);
		manifestUrl.searchParams.set('profile', options.profile ?? 'legacy');
		manifestUrl.searchParams.set('maxHeight', String(options.maxHeight ?? 1080));
		if (!captions) manifestUrl.searchParams.set('captions', '0');

		const mediaInfo = new (chromeCast().media.MediaInfo)(
			manifestUrl.toString(),
			'application/dash+xml'
		);
		mediaInfo.streamType = chromeCast().media.StreamType.BUFFERED;
		mediaInfo.duration = castSession.duration;

		const metadata = new (chromeCast().media.GenericMediaMetadata)();
		metadata.title = castSession.title;
		metadata.subtitle = castSession.author;
		if (options.poster) {
			metadata.images = [new (chromeCast().Image)(options.poster)];
		}
		mediaInfo.metadata = metadata;

		const request = new (chromeCast().media.LoadRequest)(mediaInfo);
		request.autoplay = true;
		request.currentTime = Math.max(0, Math.floor(options.startTime ?? 0));

		await session.loadMedia(request);
	};

	try {
		await load(true);
	} catch (error) {
		// Subtitle tracks are the part of the manifest a player is most likely to
		// reject - ffmpeg refuses them outright - so rather than failing the cast,
		// try once more without them and let the viewer watch without subtitles.
		console.warn('Cast load failed with subtitles, retrying without:', error);
		await load(false);
	}

	castStatus.update((status) => ({
		...status,
		connected: true,
		videoId: options.videoId,
		title: castSession.title,
		deviceName: session.getCastDevice()?.friendlyName ?? null,
		duration: castSession.duration,
		maxHeight: options.maxHeight ?? status.maxHeight,
		poster: options.poster ?? status.poster
	}));
}

/**
 * Re-sends the current video with a different height cap.
 *
 * The stock receiver picks its own rendition and offers no way to override it,
 * so a quality choice is expressed by handing it a manifest that only contains
 * the renditions the viewer allowed, resuming where it left off. The server
 * side session is reused, so this costs one manifest fetch.
 */
export async function setCastQuality(maxHeight: number): Promise<void> {
	const status = get(castStatus);
	if (!status.videoId) return;

	await castVideo({
		videoId: status.videoId,
		startTime: status.currentTime,
		poster: status.poster ?? undefined,
		maxHeight: maxHeight || 2160
	});

	castStatus.update((current) => ({ ...current, maxHeight }));
}

export function togglePlayPause(): void {
	remoteController?.playOrPause();
}

export function seekTo(seconds: number): void {
	if (!remotePlayer) return;
	remotePlayer.currentTime = seconds;
	remoteController?.seek();
}

export function setVolume(volume: number): void {
	if (!remotePlayer) return;
	remotePlayer.volumeLevel = Math.min(1, Math.max(0, volume));
	remoteController?.setVolumeLevel();
}

export function stopCasting(): void {
	cast()?.framework?.CastContext.getInstance().endCurrentSession(true);
	castStatus.update((status) => ({
		...status,
		connected: false,
		videoId: null,
		title: null
	}));
}

const MEDIA_NAMESPACE = 'urn:x-cast:com.google.cast.media';

/**
 * Fires when the receiver finishes a video, for playlist advance.
 *
 * The remote player only reports that it went idle, not why, so this reads the
 * receiver's own media status instead: an idle reason of FINISHED is the end of
 * the video, while INTERRUPTED or CANCELLED mean something else replaced it.
 */
export function onCastMediaEnded(callback: () => void): () => void {
	const session = cast()?.framework?.CastContext.getInstance().getCurrentSession();
	if (!session) return () => {};

	const listener = (_namespace: string, message: string) => {
		try {
			const payload = JSON.parse(message);
			if (payload.type !== 'MEDIA_STATUS') return;

			for (const status of payload.status ?? []) {
				if (status.idleReason === 'FINISHED') {
					callback();
					return;
				}
			}
		} catch {
			// Not a message we can read; nothing to do.
		}
	};

	session.addMessageListener(MEDIA_NAMESPACE, listener);
	return () => {
		try {
			session.removeMessageListener(MEDIA_NAMESPACE, listener);
		} catch {
			// The session may already be gone.
		}
	};
}
