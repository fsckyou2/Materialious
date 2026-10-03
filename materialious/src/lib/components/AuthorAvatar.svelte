<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { _ } from '$lib/i18n';
	import { proxyGoogleImage } from '$lib/images';
	import { avatarFromChannelId } from '$lib/thumbnail';
	import { mergeAttrs } from 'melt';
	import { Avatar } from 'melt/builders';
	import { onMount } from 'svelte';

	type Collaborator = {
		channelId: string;
		name: string;
		subtitle: string;
		thumbnail: string | null;
	};

	let {
		author,
		authorId,
		videoId = '',
		collaboration = false
	}: { author: string; authorId: string; videoId?: string; collaboration?: boolean } = $props();

	let avatarSrc = $state('');
	const avatar = new Avatar({
		src: () => avatarSrc
	});

	onMount(() => {
		avatarFromChannelId(authorId).then((src) => {
			if (src) avatarSrc = proxyGoogleImage(src);
		});
	});

	function goToChannel(channelId = authorId) {
		goto(resolve('/channel/[authorId]', { authorId: channelId }));
	}

	// Only a video made by several channels has a choice to offer. Asked for
	// the first time the list is opened, since it is a watch page each and
	// most lists are never opened.
	const showsCollaborators = $derived(collaboration && videoId !== '');
	const menuId = $derived(`collaborators-${videoId}`);

	let collaborators: Collaborator[] | undefined = $state();
	let failed = $state(false);
	let loading = false;

	async function loadCollaborators() {
		if (collaborators || loading) return;

		loading = true;
		failed = false;

		try {
			const response = await fetch(`/api/browse/collaborators/${encodeURIComponent(videoId)}`, {
				credentials: 'same-origin'
			});

			if (!response.ok) throw new Error(`HTTP ${response.status}`);

			collaborators = ((await response.json()) as { collaborators: Collaborator[] }).collaborators;
		} catch {
			failed = true;
		} finally {
			loading = false;
		}
	}
</script>

{#if showsCollaborators}
	<!-- The picture opens the list rather than going anywhere itself, and sits
	     inside the button that does, so its fallback cannot be a button too. -->
	<button
		class="circle transparent collaborators"
		tabindex="-1"
		title={$_('thumbnail.collaborators')}
		onclick={loadCollaborators}
	>
		<img class="circle small" {...avatar.image} alt="Channel profile" tabindex="-1" />
		<span
			class="circle small secondary-container center-align"
			{...mergeAttrs(avatar.fallback, {
				style: 'text-transform: uppercase;border-radius: 2.5rem !important;'
			})}>{author[0]}</span
		>
		<i class="small badge-icon">group</i>
		<menu class="no-wrap" data-ui={`#${menuId}`} id={menuId}>
			<li class="row header">
				<div class="min bold">{$_('thumbnail.collaborators')}</div>
			</li>
			{#if collaborators}
				{#each collaborators as collaborator (collaborator.channelId)}
					<li
						data-ui={`#${menuId}`}
						class="row"
						role="presentation"
						onclick={() => goToChannel(collaborator.channelId)}
					>
						{#if collaborator.thumbnail}
							<img
								class="circle tiny"
								src={proxyGoogleImage(collaborator.thumbnail)}
								alt=""
								loading="lazy"
							/>
						{:else}
							<span class="circle tiny secondary-container center-align"
								>{collaborator.name[0]}</span
							>
						{/if}
						<div class="max">
							<div>{collaborator.name}</div>
							{#if collaborator.subtitle}
								<div class="small-text secondary-text">{collaborator.subtitle}</div>
							{/if}
						</div>
					</li>
				{/each}
			{:else if failed}
				<li class="row" role="presentation" onclick={loadCollaborators}>
					<i>error</i>
					<div class="min">{$_('thumbnail.collaboratorsFailed')}</div>
				</li>
			{:else}
				<li class="row">
					<progress class="circle small"></progress>
				</li>
			{/if}
		</menu>
	</button>
{:else}
	<img
		class="circle small"
		{...mergeAttrs(avatar.image, { onclick: () => goToChannel() })}
		alt="Channel profile"
		tabindex="-1"
	/>
	<button
		class="circle secondary-container"
		tabindex="-1"
		onclick={() => goToChannel()}
		{...mergeAttrs(avatar.fallback, {
			style: 'text-transform: uppercase;border-radius: 2.5rem !important;'
		})}>{author[0]}</button
	>
{/if}

<style>
	.collaborators {
		position: relative;
		padding: 0;
		block-size: auto;
		inline-size: auto;
	}

	/* A button shrinks what is in it to an icon's size; this is a picture the
	   size of every other channel's beside it. */
	.collaborators > img,
	.collaborators > span {
		inline-size: 2.5rem;
		block-size: 2.5rem;
		min-inline-size: 2.5rem;
		min-block-size: 2.5rem;
		max-inline-size: 2.5rem;
		max-block-size: 2.5rem;
		margin: 0;
	}

	/* Says there is more than one channel behind the picture. */
	.badge-icon {
		position: absolute;
		inset: auto -0.25rem -0.25rem auto;
		font-size: 0.875rem;
		inline-size: 1.125rem;
		block-size: 1.125rem;
		border-radius: 50%;
		background-color: var(--primary);
		color: var(--on-primary);
	}

	.header {
		pointer-events: none;
	}

	.secondary-text {
		color: var(--on-surface-variant);
	}

	.center-align {
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}
</style>
