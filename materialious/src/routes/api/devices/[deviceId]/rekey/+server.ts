import { authenticateDevice, resealDevice } from '$lib/server/devices';
import { error, json } from '@sveltejs/kit';
import z from 'zod';

const zRekeySchema = z.object({
	publicKey: z.string().min(1).max(256)
});

/**
 * A television saying it can no longer open the key it was given.
 *
 * Authenticated by the television's own token, like collecting the key is: it
 * is the only party that can tell, and all it can do is throw away something
 * that was useless to everybody. A browser holding the account key then sees a
 * device without one and offers to send it again - sealed, this time, to the
 * keypair the television actually has.
 */
export async function POST({ params, request }) {
	const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
	const device = await authenticateDevice(params.deviceId, token);

	if (!device) {
		throw error(401, 'Unknown device');
	}

	const data = zRekeySchema.safeParse(await request.json().catch(() => null));

	if (!data.success) {
		throw error(400, data.error.message);
	}

	const done = await resealDevice(params.deviceId, data.data.publicKey);

	if (!done) {
		throw error(404, 'Device not found');
	}

	return json({ cleared: true });
}
