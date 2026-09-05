<script lang="ts">
	import { onDestroy } from 'svelte';
	import { _ } from '$lib/i18n';
	import { videoLength } from '$lib/numbers';
	import { updateWatchHistory } from '$lib/api';
	import { goToNextVideo } from '$lib/player';
	import { playerSavePlaybackPositionStore } from '$lib/store';
	import type { VideoPlay } from '$lib/api/model';
	import {
		castStatus,
		seekTo,
		stopCasting,
		togglePlayPause,
		onCastMediaEnded
	} from '$lib/player/cast/sender';

	let { video, playlistId }: { video: VideoPlay; playlistId: string | null } = $props();

	let scrubbing = $state(false);
	let scrubTime = $state(0);

	const displayTime = $derived(scrubbing ? scrubTime : $castStatus.currentTime);

	// The receiver keeps playing whether or not this tab is open, but watch
	// progress and playlist advance are driven from here, so both stop if the
	// viewer closes the page mid-cast.
	const historyInterval = setInterval(() => {
		if (!$castStatus.connected || video.liveNow || !$playerSavePlaybackPositionStore) return;
		if ($castStatus.currentTime > 0) {
			updateWatchHistory(video.videoId, $castStatus.currentTime);
		}
	}, 60000);

	const unsubscribeEnded = onCastMediaEnded(() => {
		goToNextVideo(video, playlistId);
	});

	onDestroy(() => {
		clearInterval(historyInterval);
		unsubscribeEnded();
	});
</script>

<div class="cast-overlay surface-container">
	<i class="extra">cast_connected</i>
	<p class="large-text">{$_('player.cast.castingTo')} {$castStatus.deviceName ?? ''}</p>
	<p class="no-margin bold">{video.title}</p>

	<div class="cast-controls">
		<nav class="no-wrap center-align">
			<button class="circle large" onclick={togglePlayPause}>
				<i>{$castStatus.paused ? 'play_arrow' : 'pause'}</i>
			</button>
		</nav>

		<nav class="no-wrap">
			<span class="chip">{videoLength(displayTime)}</span>
			<input
				class="cast-seek"
				type="range"
				min="0"
				max={$castStatus.duration || video.lengthSeconds}
				value={displayTime}
				oninput={(event) => {
					scrubbing = true;
					scrubTime = Number(event.currentTarget.value);
				}}
				onchange={(event) => {
					seekTo(Number(event.currentTarget.value));
					scrubbing = false;
				}}
			/>
			<span class="chip">{videoLength($castStatus.duration || video.lengthSeconds)}</span>
		</nav>

		<button class="border" onclick={stopCasting}>
			<i>cast</i>
			<span>{$_('player.cast.stop')}</span>
		</button>
	</div>
</div>

<style>
	.cast-overlay {
		position: absolute;
		inset: 0;
		z-index: 5;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		text-align: center;
		padding: 1rem;
	}

	.cast-controls {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		width: min(100%, 30rem);
		margin-top: 1rem;
	}

	.cast-seek {
		flex: 1;
		min-width: 0;
	}
</style>
