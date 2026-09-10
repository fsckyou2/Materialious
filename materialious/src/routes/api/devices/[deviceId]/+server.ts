import { error, json } from '@sveltejs/kit';
import { removeDevice } from '$lib/server/devices';

export async function DELETE({ params, locals }) {
	// Devices belong to an account, so unlike the rest of the API there is no
	// anonymous case to fall back to even on an instance without required auth.
	if (!locals.userId) {
		throw error(401);
	}

	const removed = await removeDevice(params.deviceId, locals.userId);

	if (!removed) {
		throw error(404, 'Device not found');
	}

	return json({ removed: true });
}
