import { getCastSession } from '@materialious/shared/cast';
import { error } from '@sveltejs/kit';
import { castCorsHeaders } from '$lib/server/cast';

/**
 * Serves one format as if it were a file on disk.
 *
 * The receiver reads the manifest's byte ranges and asks for them here; each
 * range is answered from the SABR segments it covers. Ranges are what make
 * seeking work, so this route has to behave like an ordinary static file
 * server, including on the open-ended requests some players make.
 */
export async function GET({ params, request }) {
	const session = getCastSession(params.sessionId);
	if (!session) {
		throw error(404, 'Cast session not found or expired');
	}

	const key = decodeURIComponent(params.key);

	let total: number;
	let mimeType: string;
	try {
		total = await session.getFormatSize(key);
		mimeType = await session.getFormatMimeType(key);
	} catch (err) {
		throw error(404, err instanceof Error ? err.message : 'Unknown format');
	}

	const rangeHeader = request.headers.get('range');
	const match = rangeHeader?.match(/bytes=(\d*)-(\d*)/);

	const start = match?.[1] ? Number(match[1]) : 0;
	const end = match?.[2] ? Math.min(Number(match[2]), total - 1) : total - 1;

	if (start > end || start >= total) {
		return new Response(null, {
			status: 416,
			headers: { 'content-range': `bytes */${total}`, ...castCorsHeaders }
		});
	}

	const bytes = session.readRange(key, start, end, () => request.signal.aborted);

	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { value, done } = await bytes.next();
				if (done) {
					controller.close();
					return;
				}
				controller.enqueue(value);
			} catch (err) {
				controller.error(err);
			}
		},
		cancel() {
			void bytes.return(undefined);
		}
	});

	const headers = {
		'content-type': mimeType,
		'content-length': String(end - start + 1),
		'accept-ranges': 'bytes',
		'cache-control': 'no-store',
		...castCorsHeaders
	};

	if (!rangeHeader) {
		return new Response(stream, { status: 200, headers });
	}

	return new Response(stream, {
		status: 206,
		headers: { ...headers, 'content-range': `bytes ${start}-${end}/${total}` }
	});
}

export async function OPTIONS() {
	return new Response(null, { status: 204, headers: castCorsHeaders });
}
