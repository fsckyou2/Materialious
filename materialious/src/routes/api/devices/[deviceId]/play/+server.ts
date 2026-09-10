import { createCastSession } from '@materialious/shared/cast';
import { error, json } from '@sveltejs/kit';
import z from 'zod';
import { castBaseUrl } from '$lib/server/cast';
import { isOnline, ownsDevice, sendCommand } from '$lib/server/devices';

const zPlaySchema = z.object({
	videoId: z.string().length(11),
	startTime: z.number().nonnegative().default(0),
	poster: z.string().url().optional(),
	profile: z.enum(['legacy', 'modern']).default('modern'),
	maxHeight: z.number().int().positive().default(1080)
});

/**
 * Plays a video on a paired television.
 *
 * The browser holds the account, so it is the browser that opens the playback
 * session; the television is only handed a URL. That keeps the device's own
 * credentials narrow - enough to receive commands and report progress, not
 * enough to open sessions of its own.
 */
export async function POST(event) {
	const { params, request, locals } = event;

	// Devices belong to an account, so unlike the rest of the API there is no
	// anonymous case to fall back to even on an instance without required auth.
	if (!locals.userId) {
		throw error(401);
	}

	if (!(await ownsDevice(params.deviceId, locals.userId))) {
		throw error(404, 'Device not found');
	}

	if (!isOnline(params.deviceId)) {
		throw error(409, 'That device is not connected');
	}

	const data = zPlaySchema.safeParse(await request.json().catch(() => null));

	if (!data.success) {
		throw error(400, data.error.message);
	}

	let session;
	try {
		session = await createCastSession(data.data.videoId, locals.userId);
	} catch (err) {
		throw error(500, err instanceof Error ? err.message : 'Failed to open a playback session');
	}

	if (session.source === 'live') {
		throw error(501, 'Playing live streams on a device is not supported yet');
	}

	const manifestUrl = new URL(`${castBaseUrl(event, session.id)}/manifest`);
	manifestUrl.searchParams.set('profile', data.data.profile);
	manifestUrl.searchParams.set('maxHeight', String(data.data.maxHeight));

	const delivered = sendCommand(params.deviceId, {
		type: 'play',
		videoId: data.data.videoId,
		manifestUrl: manifestUrl.toString(),
		title: session.title,
		author: session.author,
		duration: session.durationSeconds,
		poster: data.data.poster,
		startTime: data.data.startTime
	});

	if (!delivered) {
		throw error(409, 'That device disconnected before it could be told to play');
	}

	return json({
		playing: true,
		title: session.title,
		duration: session.durationSeconds
	});
}
