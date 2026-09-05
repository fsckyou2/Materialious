import { writable, type Writable } from 'svelte/store';

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
	/** Set when a cast attempt failed, for surfacing to the viewer. */
	errorMessage: string | null;
};

export const castStatus: Writable<CastStatus> = writable({
	available: false,
	connected: false,
	deviceName: null,
	videoId: null,
	title: null,
	currentTime: 0,
	duration: 0,
	paused: false,
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

	const manifestUrl = new URL(castSession.manifestUrl);
	manifestUrl.searchParams.set('profile', options.profile ?? 'legacy');
	manifestUrl.searchParams.set('maxHeight', String(options.maxHeight ?? 1080));

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

	castStatus.update((status) => ({
		...status,
		connected: true,
		videoId: options.videoId,
		title: castSession.title,
		deviceName: session.getCastDevice()?.friendlyName ?? null,
		duration: castSession.duration
	}));
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

/** Fires when the receiver reaches the end of a video, for playlist advance. */
export function onCastMediaEnded(callback: () => void): () => void {
	if (!remoteController) return () => {};

	const events = cast().framework.RemotePlayerEventType;
	const handler = () => {
		const state = remotePlayer.playerState;
		if (state === chromeCast().media.PlayerState.IDLE && remotePlayer.savedPlayerState === null) {
			callback();
		}
	};

	remoteController.addEventListener(events.PLAYER_STATE_CHANGED, handler);
	return () => remoteController.removeEventListener(events.PLAYER_STATE_CHANGED, handler);
}
