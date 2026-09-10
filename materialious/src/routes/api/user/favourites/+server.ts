import { getUser } from '$lib/server/user';
import { error, json } from '@sveltejs/kit';
import z from 'zod';

/**
 * Starred channels, as an encrypted blob.
 *
 * Which channels somebody has starred is theirs, so it is stored the way the
 * rest of their account is: sealed with a key this server does not hold. It
 * lives in the key value table rather than a table of its own because that is
 * all it is - one list, read and written whole.
 *
 * It sits here rather than in a browser's own storage so that a television and
 * a browser agree about it.
 */
const KEY = 'favouriteChannels';

export async function GET({ locals }) {
	if (!locals.userId) throw error(401);

	const user = await getUser(locals.userId);

	try {
		const stored = await user.getKeyValue(KEY);

		return json({ valueCipher: stored.valueCipher, valueNonce: stored.valueNonce });
	} catch {
		// Nothing starred yet is not an error; it is an empty list.
		return json({ valueCipher: null, valueNonce: null });
	}
}

const zFavourites = z.object({
	valueCipher: z.string().max(3000),
	valueNonce: z.string().max(255)
});

export async function POST({ locals, request }) {
	if (!locals.userId) throw error(401);

	const body = zFavourites.safeParse(await request.json());
	if (!body.success) throw error(400, body.error.message);

	const user = await getUser(locals.userId);
	await user.addOrUpdateKeyValue(KEY, body.data.valueCipher, body.data.valueNonce);

	return new Response();
}
