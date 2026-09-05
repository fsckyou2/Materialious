<script lang="ts">
	import { onMount } from 'svelte';
	import { _ } from '$lib/i18n';
	import { addToast } from '../Toast.svelte';
	import { listDevices, pairDevice, unpairDevice, type PairedDevice } from '$lib/devices';

	let devices: PairedDevice[] = $state([]);
	let code = $state('');
	let pairing = $state(false);
	let error = $state('');

	async function refresh() {
		try {
			devices = await listDevices();
		} catch {
			// A failure here only means the list is stale, which the next refresh
			// fixes; there is nothing useful to tell the viewer.
		}
	}

	async function pair(event: Event) {
		event.preventDefault();

		error = '';
		pairing = true;

		try {
			const device = await pairDevice(code.trim().toUpperCase());
			code = '';
			addToast({ data: { text: $_('layout.devices.paired', { name: device.name }) } });
			await refresh();
		} catch (err) {
			error = err instanceof Error ? err.message : $_('layout.devices.pairFailed');
		} finally {
			pairing = false;
		}
	}

	async function unpair(device: PairedDevice) {
		try {
			await unpairDevice(device.id);
			await refresh();
		} catch {
			addToast({ data: { text: $_('layout.devices.unpairFailed') } });
		}
	}

	onMount(() => {
		refresh();
		// Devices come and go as televisions are switched on and off.
		const interval = setInterval(refresh, 15000);
		return () => clearInterval(interval);
	});
</script>

<h6>{$_('layout.devices.title')}</h6>
<p class="secondary-text">{$_('layout.devices.description')}</p>

<form onsubmit={pair}>
	<nav class="no-wrap">
		<div class="field label border max" class:invalid={error}>
			<input
				bind:value={code}
				maxlength="6"
				autocapitalize="characters"
				autocomplete="off"
				spellcheck="false"
			/>
			<label for="code">{$_('layout.devices.code')}</label>
			{#if error}
				<span class="error">{error}</span>
			{/if}
		</div>
		<button disabled={pairing || code.trim().length !== 6}>
			{#if pairing}
				<progress class="circle small"></progress>
			{:else}
				<i>add_to_queue</i>
			{/if}
			<span>{$_('layout.devices.pair')}</span>
		</button>
	</nav>
</form>

<div class="space"></div>

{#if devices.length === 0}
	<p class="secondary-text">{$_('layout.devices.none')}</p>
{:else}
	{#each devices as device (device.id)}
		<article class="no-padding">
			<nav class="row padding">
				<i class={device.online ? 'primary-text' : 'secondary-text'}>
					{device.online ? 'tv' : 'tv_off'}
				</i>
				<div class="max">
					<h6 class="small">{device.name}</h6>
					<p class="secondary-text no-margin">
						{#if device.online && device.status?.title}
							{$_('layout.devices.playing')}: {device.status.title}
						{:else if device.online}
							{$_('layout.devices.online')}
						{:else}
							{$_('layout.devices.offline')}
						{/if}
					</p>
				</div>
				<button class="border" onclick={() => unpair(device)}>
					<i>link_off</i>
					<span>{$_('layout.devices.unpair')}</span>
				</button>
			</nav>
		</article>
	{/each}
{/if}
