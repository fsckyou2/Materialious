<script lang="ts">
	import { onMount } from 'svelte';
	import { _ } from '$lib/i18n';
	import { addToast } from '$lib/components/Toast.svelte';
	import { getBestThumbnail } from '$lib/images';
	import { isOwnBackend } from '$lib/shared';
	import type { VideoPlay } from '$lib/api/model';
	import {
		castStatus,
		castVideo,
		isCastSupported,
		loadCastSdk,
		stopCasting
	} from '$lib/player/cast/sender';

	let { video, playerElement }: { video: VideoPlay; playerElement: HTMLMediaElement | undefined } =
		$props();

	let busy = $state(false);

	// Casting is served by this instance's own gateway, so it only exists on
	// deployments that have a backend to serve it. Live streams have no segment
	// index to seek around, so the gateway cannot serve them yet.
	const supported = !!isOwnBackend() && isCastSupported() && !video.liveNow;

	onMount(() => {
		if (supported) loadCastSdk();
	});

	async function toggleCast() {
		if ($castStatus.connected) {
			stopCasting();
			return;
		}

		busy = true;
		try {
			await castVideo({
				videoId: video.videoId,
				startTime: playerElement?.currentTime ?? 0,
				poster: getBestThumbnail(video.videoThumbnails, 1280, 720)
			});
			playerElement?.pause();
		} catch (error) {
			// A viewer dismissing the device picker is not worth a toast.
			const message = error instanceof Error ? error.message : String(error);
			if (!message.toLowerCase().includes('cancel')) {
				addToast({ data: { text: $_('player.cast.failed') } });
			}
		} finally {
			busy = false;
		}
	}
</script>

{#if supported && $castStatus.available}
	<button
		class="surface-container-highest"
		class:primary={$castStatus.connected}
		disabled={busy}
		onclick={toggleCast}
		title={$castStatus.connected
			? `${$_('player.cast.castingTo')} ${$castStatus.deviceName ?? ''}`
			: $_('player.cast.title')}
	>
		<i>{$castStatus.connected ? 'cast_connected' : 'cast'}</i>
	</button>
{/if}
