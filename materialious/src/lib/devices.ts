import sodium from 'libsodium-wrappers-sumo';
import { getRawKey } from '$lib/api/backend/encryption';

/**
 * Televisions paired to this account.
 *
 * Everything here talks only to the instance. The browser never has to find a
 * device on the local network, which is what makes this work from phones and
 * browsers that have no working cast stack of their own.
 */

export type DeviceStatus = {
	state: 'idle' | 'buffering' | 'playing' | 'paused';
	videoId?: string;
	title?: string;
	currentTime: number;
	duration: number;
	updatedAt: number;
};

export type ClaimedDevice = {
	deviceId: string;
	name: string;
	/** Base64 key the master key is sealed to, when the device offered one. */
	publicKey: string | null;
};

export type PairedDevice = {
	id: string;
	name: string;
	online: boolean;
	status: DeviceStatus | null;
	lastSeen: string | null;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, { credentials: 'same-origin', ...init });

	if (!response.ok) {
		const body = await response.text();
		let message = body;
		try {
			message = JSON.parse(body).message ?? body;
		} catch {
			// Not JSON; the raw body is the best message available.
		}
		throw new Error(message || `Request failed (${response.status})`);
	}

	return (await response.json()) as T;
}

export async function listDevices(): Promise<PairedDevice[]> {
	const { devices } = await request<{ devices: PairedDevice[] }>('/api/devices');
	return devices;
}

/**
 * Claims a code displayed on a television, and hands it the master key.
 *
 * Subscriptions and history are encrypted with a key this server never sees, so
 * a television can only read them if a browser that holds the key gives it one.
 * It is sealed to the device's own public key, so it is readable by that
 * television and nothing else - the instance stores it without being able to
 * open it.
 */
export async function pairDevice(code: string): Promise<ClaimedDevice> {
	const device = await request<ClaimedDevice>('/api/devices/claim', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ code })
	});

	if (device.publicKey) {
		await sealMasterKeyFor(device.deviceId, device.publicKey);
	}

	return device;
}

async function sealMasterKeyFor(deviceId: string, publicKey: string): Promise<void> {
	const rawKey = await getRawKey();

	// Without a master key in this browser there is nothing to hand over; the
	// television still pairs and plays, it just cannot read subscriptions.
	if (!rawKey) return;

	await sodium.ready;

	// Standard base64 both ways, so the device can decode it with the platform
	// decoder rather than a URL-safe variant.
	const sealed = sodium.crypto_box_seal(
		rawKey,
		sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL)
	);

	await request(`/api/devices/${deviceId}/key`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			sealed: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL)
		})
	});
}

export async function unpairDevice(deviceId: string): Promise<void> {
	await request(`/api/devices/${deviceId}`, { method: 'DELETE' });
}

export async function playOnDevice(
	deviceId: string,
	options: { videoId: string; startTime?: number; poster?: string; maxHeight?: number }
): Promise<{ title: string; duration: number }> {
	return request(`/api/devices/${deviceId}/play`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			videoId: options.videoId,
			startTime: Math.max(0, Math.floor(options.startTime ?? 0)),
			...(options.poster ? { poster: options.poster } : {}),
			...(options.maxHeight ? { maxHeight: options.maxHeight } : {})
		})
	});
}

export async function sendDeviceCommand(
	deviceId: string,
	command:
		| { type: 'pause' }
		| { type: 'resume' }
		| { type: 'stop' }
		| { type: 'seek'; positionSeconds: number }
): Promise<void> {
	await request(`/api/devices/${deviceId}/command`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(command)
	});
}

export async function getDeviceStatus(deviceId: string): Promise<DeviceStatus | null> {
	const { status } = await request<{ status: DeviceStatus | null }>(
		`/api/devices/${deviceId}/status`
	);
	return status;
}
