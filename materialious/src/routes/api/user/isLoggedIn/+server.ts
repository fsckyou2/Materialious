import { requireUser } from '$lib/server/user';
import { error } from '@sveltejs/kit';

export async function GET({ locals }) {
	if (!locals.userId) {
		throw error(401);
	}

	await requireUser(locals.userId);

	return new Response();
}
