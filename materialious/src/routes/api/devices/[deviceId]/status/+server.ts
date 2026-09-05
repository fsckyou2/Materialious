import { error, json } from '@sveltejs/kit';
import z from 'zod';
import { authenticateDevice, getStatus, ownsDevice, setStatus } from '$lib/server/devices';

const zStatusSchema = z.object({
	state: z.enum(['idle', 'buffering', 'playing', 'paused']),
	videoId: z.string().length(11).optional(),
	title: z.string().max(300).optional(),
	currentTime: z.number().nonnegative().default(0),
	duration: z.number().nonnegative().default(0)
});

/** A television reporting what it is doing, authenticated by its own token. */
export async function POST({ params, request }) {
	const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
	const device = await authenticateDevice(params.deviceId, token);

	if (!device) {
		throw error(401, 'Unknown device');
	}

	const data = zStatusSchema.safeParse(await request.json().catch(() => null));

	if (!data.success) {
		throw error(400, data.error.message);
	}

	setStatus(device.id, data.data);

	return json({ received: true });
}

/** The browser polling what a device is playing, to drive its controls. */
export async function GET({ params, locals }) {
	// Devices belong to an account, so unlike the rest of the API there is no
	// anonymous case to fall back to even on an instance without required auth.
	if (!locals.userId) {
		throw error(401);
	}

	if (!(await ownsDevice(params.deviceId, locals.userId))) {
		throw error(404, 'Device not found');
	}

	return json({ status: getStatus(params.deviceId) });
}
