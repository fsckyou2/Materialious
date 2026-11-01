import { getCastSession } from '$lib/server/cast';
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

	// SvelteKit has already decoded the route parameter.
	const key = params.key;

	// Refused, and started over as often as it will be: say so, rather than
	// take every retry of the receiver's back to YouTube to be refused again.
	if (session.exhausted) {
		throw error(503, 'YouTube refused this stream');
	}

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

	// `bytes=-500` asks for the last five hundred bytes, not the first. Read as
	// a start of zero it answers a question nobody asked, with the wrong end of
	// the file and a straight face - players that check a file's tail get bytes
	// that look like data and are not.
	const suffix = !match?.[1] && !!match?.[2];

	const start = suffix ? Math.max(0, total - Number(match[2])) : match?.[1] ? Number(match[1]) : 0;

	const end = !suffix && match?.[2] ? Math.min(Number(match[2]), total - 1) : total - 1;

	if (start > end || start >= total) {
		return new Response(null, {
			status: 416,
			headers: { 'content-range': `bytes */${total}`, ...castCorsHeaders }
		});
	}

	const bytes = session.readRange(key, start, end, () => request.signal.aborted);

	// The first piece is fetched before anything is promised. A range that
	// fails once its 206 has gone out reaches the receiver only as a body cut
	// short, which it takes for the network and quietly asks again.
	let first: IteratorResult<Uint8Array> | undefined;
	try {
		first = await bytes.next();
	} catch (err) {
		console.warn(
			`cast: ${session.videoId} ${key} bytes ${start}-${end} failed:`,
			err instanceof Error ? err.message : err
		);
		throw error(503, err instanceof Error ? err.message : 'YouTube refused this stream');
	}

	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const next = first ?? (await bytes.next());
				first = undefined;
				const { value, done } = next;
				if (done) {
					controller.close();
					return;
				}
				controller.enqueue(value);
			} catch (err) {
				// The receiver only learns that its range ended early, so the
				// reason is said here or nowhere.
				console.warn(
					`cast: ${session.videoId} ${key} bytes ${start}-${end} failed:`,
					err instanceof Error ? err.message : err
				);
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
