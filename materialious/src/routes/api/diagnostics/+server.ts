import { json } from '@sveltejs/kit';

/**
 * Receives a report from a page that stopped making progress. It is written to
 * the server log so that stalls, which happen now and then and leave nothing
 * behind in the browser, can be read after the fact.
 */
export async function POST({ request, locals }) {
	if (!locals.userId) {
		return json({ message: 'Auth required' }, { status: 401 });
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ message: 'Expected JSON' }, { status: 400 });
	}

	console.warn('[stall]', JSON.stringify(body).slice(0, 2000));

	return json({ ok: true });
}
