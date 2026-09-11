import { requireUser } from '$lib/server/user';

export async function DELETE({ locals }) {
	const user = await requireUser(locals.userId);
	await user.delete();

	return new Response();
}
