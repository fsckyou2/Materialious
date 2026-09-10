import { error, json } from '@sveltejs/kit';
import { listDevices } from '$lib/server/devices';

export async function GET({ locals }) {
	// Devices belong to an account, so unlike the rest of the API there is no
	// anonymous case to fall back to even on an instance without required auth.
	if (!locals.userId) {
		throw error(401);
	}

	return json({ devices: await listDevices(locals.userId) });
}
