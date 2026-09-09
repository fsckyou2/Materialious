import { error, json } from '@sveltejs/kit';
import z from 'zod';
import { startPairing } from '$lib/server/devices';

const zPairSchema = z.object({
	name: z.string().min(1).max(64),
	// Base64 public key the master key will be sealed to, if this device wants
	// to be able to read subscriptions and history.
	publicKey: z.string().min(1).max(256).optional()
});

/**
 * Starts pairing a television.
 *
 * Deliberately unauthenticated: the device has no credentials yet, which is the
 * whole point of pairing. Nothing is persisted until somebody signed in claims
 * the returned code, and the code expires on its own.
 */
export async function POST({ request }) {
	const data = zPairSchema.safeParse(await request.json().catch(() => null));

	if (!data.success) {
		throw error(400, 'A device name is required');
	}

	const pairing = startPairing(data.data.name, data.data.publicKey ?? null);

	return json({
		deviceId: pairing.deviceId,
		token: pairing.token,
		code: pairing.code,
		expiresAt: pairing.expiresAt
	});
}
