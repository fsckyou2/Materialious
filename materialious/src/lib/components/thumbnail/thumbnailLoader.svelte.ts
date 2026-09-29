import { imageHandleCors } from '$lib/images';

/**
 * How long to wait before going back through the list once every picture in it
 * has failed. A failure that clears up on its own - a dropped connection, a
 * proxy that was busy or still starting - gets two more chances. One that does
 * not is left as the placeholder rather than asked about all evening.
 */
const RETRY_DELAYS_MS = [2_000, 8_000];

/** The size of the picture YouTube sends in place of one it does not have. */
const YOUTUBE_MISSING_WIDTH = 120;
const YOUTUBE_MISSING_HEIGHT = 90;

/**
 * Loads the first picture in a list that will load.
 *
 * An image that fails to load does not try again by itself, so a single missing
 * size or dropped request used to leave the card grey for as long as the page
 * stayed open.
 */
export class ThumbnailLoader {
	#sources: () => string[];
	#index = $state(0);
	#round = 0;
	#retryTimer: ReturnType<typeof setTimeout> | undefined;

	/** Changes on every retry, so the image can be keyed on it and asked again. */
	attempt = $state(0);
	loaded = $state(false);

	constructor(sources: () => string[]) {
		this.#sources = sources;
	}

	get src(): string {
		return imageHandleCors(this.#sources()[this.#index] ?? '');
	}

	/** Starts again from the first picture, for when the list itself changed. */
	reset() {
		clearTimeout(this.#retryTimer);
		this.#index = 0;
		this.#round = 0;
		this.loaded = false;
	}

	onload = (event: Event) => {
		const image = event.currentTarget as HTMLImageElement;

		// YouTube answers a size it does not have with a 404 that still carries a
		// picture: a plain grey 120x90 frame. The browser counts that as loaded, so
		// the card showed a grey box that looked like nothing had loaded at all.
		// A smaller real size is a better picture, but when it is the last one
		// there is, the frame is still better than the placeholder.
		if (
			image.naturalWidth === YOUTUBE_MISSING_WIDTH &&
			image.naturalHeight === YOUTUBE_MISSING_HEIGHT &&
			this.#next()
		) {
			return;
		}

		this.loaded = true;
	};

	onerror = () => {
		this.loaded = false;

		if (this.#next()) return;

		const delay = RETRY_DELAYS_MS[this.#round];
		if (delay === undefined) return;

		this.#round++;
		this.#retryTimer = setTimeout(() => {
			this.#index = 0;
			this.attempt++;
		}, delay);
	};

	/** Moves on to the next picture, if there is one. */
	#next(): boolean {
		if (this.#index >= this.#sources().length - 1) return false;

		this.#index++;
		return true;
	}

	destroy() {
		clearTimeout(this.#retryTimer);
	}
}
