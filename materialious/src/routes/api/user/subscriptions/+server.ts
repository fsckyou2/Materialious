import { requireUser } from '$lib/server/user';
import { json } from '@sveltejs/kit';

export async function GET({ locals }) {
	const user = await requireUser(locals.userId);

	return json({
		subscriptions: await user.subscriptions()
	});
}
