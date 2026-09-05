import { error, json } from '@sveltejs/kit';
import z from 'zod';
import { isOnline, ownsDevice, sendCommand } from '$lib/server/devices';

const zCommandSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('pause') }),
	z.object({ type: z.literal('resume') }),
	z.object({ type: z.literal('stop') }),
	z.object({ type: z.literal('seek'), positionSeconds: z.number().nonnegative() })
]);

/** Transport controls for whatever a paired television is already playing. */
export async function POST({ params, request, locals }) {
	// Devices belong to an account, so unlike the rest of the API there is no
	// anonymous case to fall back to even on an instance without required auth.
	if (!locals.userId) {
		throw error(401);
	}

	if (!(await ownsDevice(params.deviceId, locals.userId))) {
		throw error(404, 'Device not found');
	}

	const data = zCommandSchema.safeParse(await request.json().catch(() => null));

	if (!data.success) {
		throw error(400, data.error.message);
	}

	if (!isOnline(params.deviceId) || !sendCommand(params.deviceId, data.data)) {
		throw error(409, 'That device is not connected');
	}

	return json({ sent: true });
}
