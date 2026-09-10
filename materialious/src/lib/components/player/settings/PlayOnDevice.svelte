<script lang="ts">
	import { onMount } from 'svelte';
	import { _ } from '$lib/i18n';
	import { addToast } from '$lib/components/Toast.svelte';
	import { getBestThumbnail } from '$lib/images';
	import { isOwnBackend } from '$lib/shared';
	import { listDevices, playOnDevice, type PairedDevice } from '$lib/devices';
	import type { VideoPlay } from '$lib/api/model';

	let { video, playerElement }: { video: VideoPlay; playerElement: HTMLMediaElement | undefined } =
		$props();

	let devices: PairedDevice[] = $state([]);
	let menuOpen = $state(false);
	let sending = $state(false);
	let button: HTMLButtonElement | undefined = $state();

	// Only instances with a backend can hold the paired televisions, and live
	// streams have no segment index for the gateway to serve yet.
	const supported = $derived(!!isOwnBackend() && !video.liveNow);

	async function refresh() {
		if (!supported) return;
		try {
			devices = await listDevices();
		} catch {
			devices = [];
		}
	}

	function onButtonClick(event: MouseEvent) {
		if ((event.target as HTMLElement).closest('menu')) return;
		menuOpen = !menuOpen;
		if (menuOpen) refresh();
		else button?.blur();
	}

	async function play(device: PairedDevice) {
		sending = true;
		try {
			await playOnDevice(device.id, {
				videoId: video.videoId,
				startTime: playerElement?.currentTime ?? 0,
				poster: getBestThumbnail(video.videoThumbnails, 1280, 720)
			});
			playerElement?.pause();
			addToast({ data: { text: $_('player.playOn.started', { name: device.name }) } });
		} catch (error) {
			addToast({
				data: { text: error instanceof Error ? error.message : $_('player.playOn.failed') }
			});
		} finally {
			sending = false;
			menuOpen = false;
			button?.blur();
		}
	}

	onMount(refresh);
</script>

{#if supported && devices.length > 0}
	<button
		bind:this={button}
		class="surface-container-highest"
		disabled={sending}
		onclick={onButtonClick}
		onblur={() => (menuOpen = false)}
		title={$_('player.playOn.title')}
	>
		<i>tv</i>
		<!-- Without this the menu opens downwards and is clipped by the bottom of
		     the video, since the control bar sits at the player's edge. -->
		<menu class="no-wrap mobile player-settings">
			{#each devices as device (device.id)}
				<li role="presentation" onclick={() => play(device)}>
					<nav class="no-wrap" style="width: 100%;">
						<i>{device.online ? 'tv' : 'tv_off'}</i>
						<span class="max">{device.name}</span>
						{#if !device.online}
							<span class="secondary-text">{$_('layout.devices.offline')}</span>
						{/if}
					</nav>
				</li>
			{/each}
		</menu>
	</button>
{/if}
