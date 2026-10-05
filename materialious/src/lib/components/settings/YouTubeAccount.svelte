<script lang="ts">
	import { _ } from '$lib/i18n';
	import { youtubeCookieStore } from '$lib/store';
	import { accountNameFor, parseYouTubeCookies } from '$lib/api/youtubejs/account';
	import { onMount } from 'svelte';

	let pasted = $state('');
	let busy = $state(false);
	let error = $state('');
	let accountName: string | undefined = $state();
	let checkFailed = $state(false);

	async function checkSaved() {
		if (!$youtubeCookieStore) return;

		busy = true;
		checkFailed = false;

		try {
			accountName = await accountNameFor($youtubeCookieStore);
			if (!accountName) checkFailed = true;
		} catch {
			checkFailed = true;
		} finally {
			busy = false;
		}
	}

	onMount(checkSaved);

	async function signIn(event: Event) {
		event.preventDefault();
		error = '';

		const cookie = parseYouTubeCookies(pasted);
		if (!cookie) {
			error = $_('layout.youtubeAccount.noSession');
			return;
		}

		busy = true;

		// Asked before anything is kept, so cookies that do not sign anybody in
		// are never saved and never sent with a video.
		try {
			const name = await accountNameFor(cookie);
			if (!name) throw new Error('not signed in');

			youtubeCookieStore.set(cookie);
			accountName = name;
			checkFailed = false;
			pasted = '';
		} catch {
			error = $_('layout.youtubeAccount.rejected');
		} finally {
			busy = false;
		}
	}

	function signOut() {
		youtubeCookieStore.set('');
		accountName = undefined;
		checkFailed = false;
	}
</script>

{#if $youtubeCookieStore}
	<article class="border">
		<nav class="no-padding">
			<i>{checkFailed ? 'warning' : 'account_circle'}</i>
			<div class="max">
				{#if busy}
					<p>{$_('layout.youtubeAccount.checking')}</p>
				{:else if checkFailed}
					<p class="bold">{$_('layout.youtubeAccount.expired')}</p>
				{:else}
					<p class="bold">{$_('layout.youtubeAccount.signedInAs', { name: accountName ?? '' })}</p>
				{/if}
			</div>
			<button class="border" onclick={signOut}>{$_('layout.youtubeAccount.signOut')}</button>
		</nav>
	</article>
	<p class="small-text">{$_('layout.youtubeAccount.whenUsed')}</p>
{:else}
	<p>{$_('layout.youtubeAccount.why')}</p>
	<ol>
		<li>{$_('layout.youtubeAccount.stepPrivateWindow')}</li>
		<li>{$_('layout.youtubeAccount.stepExport')}</li>
		<li>{$_('layout.youtubeAccount.stepPaste')}</li>
	</ol>

	<form onsubmit={signIn}>
		<div class="field textarea label border">
			<textarea
				bind:value={pasted}
				name="youtube-cookies"
				spellcheck="false"
				autocomplete="off"
				disabled={busy}
			></textarea>
			<label for="youtube-cookies">{$_('layout.youtubeAccount.cookiesLabel')}</label>
		</div>
		{#if error}
			<p class="error-text">{error}</p>
		{/if}
		<nav class="right-align no-padding">
			<button type="submit" disabled={busy || !pasted.trim()}>
				{#if busy}
					<progress class="circle small"></progress>
				{:else}
					<i>login</i>
				{/if}
				<span>{$_('layout.youtubeAccount.signIn')}</span>
			</button>
		</nav>
	</form>
	<p class="small-text">{$_('layout.youtubeAccount.privacy')}</p>
{/if}
