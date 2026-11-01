/**
 * The most response header Node will read, in bytes.
 *
 * Node stops at 16 KiB. YouTube answers anything that says it is Chrome with
 * more than that - client-hint requests, reporting endpoints, cookies, some
 * 18 KiB in all - and the fetch fails with UND_ERR_HEADERS_OVERFLOW before
 * the body is read.
 */
export const MAX_HEADER_SIZE = 64 * 1024;
