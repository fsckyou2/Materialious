import { error } from '@sveltejs/kit';
import {
	authenticateDevice,
	closeConnection,
	openConnection,
	sendKeepAlive,
	touchDevice
} from '$lib/server/devices';

const KEEP_ALIVE_MS = 20000;

/**
 * The stream a television holds open to receive commands.
 *
 * Authenticated by the device's own token rather than a session cookie: this is
 * the connection that removes the need for the sender to discover anything on
 * the local network, so it has to work for a device with no browser session.
 */
export async function GET({ params, request }) {
	const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
	const device = await authenticateDevice(params.deviceId, token);

	if (!device) {
		throw error(401, 'Unknown device');
	}

	await touchDevice(device.id);

	let keepAlive: ReturnType<typeof setInterval>;

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			openConnection(device.id, controller);
			controller.enqueue(new TextEncoder().encode(': connected\n\n'));

			keepAlive = setInterval(() => sendKeepAlive(device.id), KEEP_ALIVE_MS);

			request.signal.addEventListener('abort', () => {
				clearInterval(keepAlive);
				closeConnection(device.id);
			});
		},
		cancel() {
			clearInterval(keepAlive);
			closeConnection(device.id);
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-store',
			connection: 'keep-alive',
			// Without this a buffering proxy would hold commands until the stream
			// filled, which for an event stream is forever.
			'x-accel-buffering': 'no'
		}
	});
}
