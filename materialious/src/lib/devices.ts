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

/** Claims a code displayed on a television. */
export async function pairDevice(code: string): Promise<{ deviceId: string; name: string }> {
	return request('/api/devices/claim', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ code })
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
