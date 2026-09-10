import { error, json } from '@sveltejs/kit';
import z from 'zod';
import {
	authenticateDevice,
	getSealedMasterKey,
	ownsDevice,
	storeSealedMasterKey
} from '$lib/server/devices';

const zSealedSchema = z.object({
	sealed: z.string().min(1).max(1024)
});

/**
 * Hands a television the account's master key, sealed to it.
 *
 * Subscriptions and history are encrypted with a key derived from the account
 * password, which never reaches this server. A television that is to show them
 * therefore has to be given that key by a browser that already holds it, sealed
 * so that only that device can open it.
 */
export async function POST({ params, request, locals }) {
	if (!locals.userId) {
		throw error(401);
	}

	if (!(await ownsDevice(params.deviceId, locals.userId))) {
		throw error(404, 'Device not found');
	}

	const data = zSealedSchema.safeParse(await request.json().catch(() => null));

	if (!data.success) {
		throw error(400, data.error.message);
	}

	const stored = await storeSealedMasterKey(params.deviceId, locals.userId, data.data.sealed);

	if (!stored) {
		throw error(404, 'Device not found');
	}

	return json({ stored: true });
}

/** The television collecting its sealed key, authenticated by its own token. */
export async function GET({ params, request }) {
	const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
	const device = await authenticateDevice(params.deviceId, token);

	if (!device) {
		throw error(401, 'Unknown device');
	}

	const sealed = await getSealedMasterKey(params.deviceId);

	if (!sealed) {
		// Paired, but nobody has handed over a key yet.
		throw error(404, 'No key available for this device');
	}

	return json({ sealed });
}
