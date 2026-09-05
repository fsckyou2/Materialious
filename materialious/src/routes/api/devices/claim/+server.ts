import { error, json } from '@sveltejs/kit';
import z from 'zod';
import { claimPairing } from '$lib/server/devices';

const zClaimSchema = z.object({
	code: z.string().length(6)
});

/** Binds a code shown on a television to the account claiming it. */
export async function POST({ request, locals }) {
	// Devices belong to an account, so unlike the rest of the API there is no
	// anonymous case to fall back to even on an instance without required auth.
	if (!locals.userId) {
		throw error(401);
	}

	const data = zClaimSchema.safeParse(await request.json().catch(() => null));

	if (!data.success) {
		throw error(400, 'A six character code is required');
	}

	const device = await claimPairing(data.data.code, locals.userId);

	if (!device) {
		throw error(404, 'That code is not valid, or it has expired');
	}

	return json(device);
}
