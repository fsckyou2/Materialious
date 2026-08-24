/**
 * Shaka queries `navigator.mediaCapabilities.decodingInfo()` once per variant,
 * and a DASH manifest's variants are the cross product of its video and audio
 * renditions. A YouTube video carrying 22 video renditions and 92 audio
 * renditions — 20 dubbed languages in four encodings apiece — is 2024 queries.
 *
 * Chrome answers those from a lookup table, so the cost is invisible. Firefox
 * asks the platform decoder and takes tens of milliseconds each, which leaves
 * playback stalled for around a minute before a track can be chosen. On mobile
 * Shaka also gives each query a five second timeout, so a queue that long
 * starts dropping results outright.
 *
 * A combined query is only ever as capable as its parts, so the video and audio
 * halves can be resolved separately and reused across every pairing. The same
 * manifest then costs 114 queries instead of 2024. Every engine Shaka supports
 * evaluates the two tracks independently anyway — its own MediaCapabilities
 * polyfill checks each half and ands the results — so the split matches what
 * the platform would have done with the combined configuration.
 */

type DecodingInfoFn = (
	configuration: MediaDecodingConfiguration
) => Promise<MediaCapabilitiesDecodingInfo>;

const cache = new Map<string, Promise<MediaCapabilitiesDecodingInfo>>();

let wrapper: DecodingInfoFn | undefined;

/**
 * Shaka builds its configurations from object literals, so key order is stable
 * in practice, but sorting keeps a cache miss from turning into a duplicate
 * platform query if that order ever changes.
 */
function cacheKey(configuration: MediaDecodingConfiguration): string {
	return JSON.stringify(configuration, (_, value) =>
		value && typeof value === 'object' && !Array.isArray(value)
			? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
			: value
	);
}

function resolveTrack(
	decodingInfo: DecodingInfoFn,
	configuration: MediaDecodingConfiguration
): Promise<MediaCapabilitiesDecodingInfo> {
	const key = cacheKey(configuration);

	let result = cache.get(key);
	if (!result) {
		result = decodingInfo(configuration);
		// Callers still see the rejection; this only keeps a cached failure from
		// being reported as an unhandled one.
		result.catch(() => {});
		cache.set(key, result);
	}

	return result;
}

/**
 * Must run after `shaka.polyfill.installAll()`. On platforms without native
 * media capabilities Shaka installs its own implementation and does so again on
 * every player mount, replacing whatever is already there, so this reinstalls
 * whenever the wrapper is no longer the function in place.
 */
export function installDecodingInfoCache(): void {
	const capabilities = navigator.mediaCapabilities;
	if (typeof capabilities?.decodingInfo !== 'function') return;

	// Configurations carry each rendition's bitrate and sample rate, so almost
	// nothing is shared between videos. Dropping the entries as the player mounts
	// keeps the map from growing for as long as the tab is open, and discards
	// answers that came from an implementation Shaka has since replaced.
	cache.clear();

	if (capabilities.decodingInfo === wrapper) return;

	const decodingInfo = capabilities.decodingInfo.bind(capabilities);

	wrapper = async (configuration: MediaDecodingConfiguration) => {
		// Key system queries negotiate with the CDM and hand back a
		// MediaKeySystemAccess, which can't be rebuilt from two separate lookups.
		// They stay uncached, but YouTube's manifests are unencrypted so nothing
		// reaches this branch today.
		if (configuration.keySystemConfiguration || !configuration.video || !configuration.audio) {
			return decodingInfo(configuration);
		}

		const [video, audio] = await Promise.all([
			resolveTrack(decodingInfo, { type: configuration.type, video: configuration.video }),
			resolveTrack(decodingInfo, { type: configuration.type, audio: configuration.audio })
		]);

		return {
			supported: video.supported && audio.supported,
			// Shaka only reads these two when preferredDecodingAttributes is set,
			// which it isn't here. A combined query is where they could legitimately
			// differ from the two halves anded together.
			smooth: video.smooth && audio.smooth,
			powerEfficient: video.powerEfficient && audio.powerEfficient,
			keySystemAccess: null,
			configuration
		};
	};

	capabilities.decodingInfo = wrapper;
}
