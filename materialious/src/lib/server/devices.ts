import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getSequelize, type DeviceModel } from './database';

/**
 * Televisions that call in to this instance.
 *
 * Google's cast stack requires the sender to discover the receiver on the local
 * network, which is exactly what fails on a phone without working Play
 * services. Inverting the connection avoids the problem rather than working
 * around it: the television holds an open stream to the instance, and a browser
 * asks the instance to play something on it. The browser only ever talks to a
 * server it can already reach.
 */

export type DeviceCommand =
	| {
			type: 'play';
			videoId: string;
			manifestUrl: string;
			title: string;
			author: string;
			duration: number;
			poster?: string;
			startTime: number;
	  }
	| { type: 'pause' }
	| { type: 'resume' }
	| { type: 'stop' }
	| { type: 'seek'; positionSeconds: number };

export type DeviceStatus = {
	state: 'idle' | 'buffering' | 'playing' | 'paused';
	videoId?: string;
	title?: string;
	currentTime: number;
	duration: number;
	updatedAt: number;
};

type PendingPairing = {
	deviceId: string;
	token: string;
	name: string;
	/** The device's public key, which the master key is later sealed to. */
	publicKey: string | null;
	expiresAt: number;
};

/** Ambiguous characters are left out: this gets read off a television. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const PAIRING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_PAIRINGS = 32;

const pendingPairings = new Map<string, PendingPairing>();
const connections = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
const statuses = new Map<string, DeviceStatus>();

const encoder = new TextEncoder();

function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

function generateCode(): string {
	let code = '';
	const bytes = randomBytes(CODE_LENGTH);
	for (let i = 0; i < CODE_LENGTH; i++) {
		code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
	}
	return code;
}

function prunePairings(): void {
	const now = Date.now();
	for (const [code, pairing] of pendingPairings) {
		if (pairing.expiresAt < now) pendingPairings.delete(code);
	}
}

/**
 * Begins pairing. The television displays the returned code; nothing is
 * persisted until somebody signed in claims it.
 */
export function startPairing(
	name: string,
	publicKey: string | null = null
): {
	code: string;
	deviceId: string;
	token: string;
	expiresAt: number;
} {
	prunePairings();

	// The endpoint that reaches this cannot be authenticated - a device being
	// paired has no credentials yet - so cap how many codes can be outstanding
	// rather than letting anyone fill memory with them.
	if (pendingPairings.size >= MAX_PENDING_PAIRINGS) {
		throw new Error('Too many devices are waiting to be paired');
	}

	let code = generateCode();
	while (pendingPairings.has(code)) code = generateCode();

	const pairing: PendingPairing = {
		deviceId: randomBytes(16).toString('hex'),
		token: randomBytes(32).toString('base64url'),
		name,
		publicKey,
		expiresAt: Date.now() + PAIRING_TTL_MS
	};

	pendingPairings.set(code, pairing);

	return { code, deviceId: pairing.deviceId, token: pairing.token, expiresAt: pairing.expiresAt };
}

/** Binds a displayed code to the account that claimed it. */
export async function claimPairing(
	code: string,
	userId: string
): Promise<{ deviceId: string; name: string; publicKey: string | null } | null> {
	prunePairings();

	const pairing = pendingPairings.get(code.toUpperCase());
	if (!pairing) return null;

	pendingPairings.delete(code.toUpperCase());

	const { DeviceTable } = getSequelize();

	await DeviceTable.create({
		id: pairing.deviceId,
		name: pairing.name,
		tokenHash: hashToken(pairing.token),
		created: new Date(),
		lastSeen: null,
		publicKey: pairing.publicKey,
		masterKeyCipher: null,
		UserId: userId
	});

	return {
		deviceId: pairing.deviceId,
		name: pairing.name,
		publicKey: pairing.publicKey
	};
}

/**
 * Resolves a bare device token to its device.
 *
 * Used where the device id is not in the path - a television calling the rest
 * of the API as its owner carries only the token.
 */
export async function authenticateDeviceByToken(token: string): Promise<DeviceModel | null> {
	const { DeviceTable } = getSequelize();
	const device = (await DeviceTable.findOne({
		where: { tokenHash: hashToken(token) }
	})) as DeviceModel | null;

	return device;
}

/** Resolves a device's own token to the device, for its stream and reports. */
export async function authenticateDevice(
	deviceId: string,
	token: string | null
): Promise<DeviceModel | null> {
	if (!token) return null;

	const { DeviceTable } = getSequelize();
	const device = (await DeviceTable.findByPk(deviceId)) as DeviceModel | null;
	if (!device) return null;

	const expected = Buffer.from(device.tokenHash, 'utf8');
	const actual = Buffer.from(hashToken(token), 'utf8');

	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
		return null;
	}

	return device;
}

export async function listDevices(userId: string): Promise<
	{
		id: string;
		name: string;
		online: boolean;
		status: DeviceStatus | null;
		lastSeen: Date | null;
	}[]
> {
	const { DeviceTable } = getSequelize();
	const devices = (await DeviceTable.findAll({ where: { UserId: userId } })) as DeviceModel[];

	return devices.map((device) => ({
		id: device.id,
		name: device.name,
		online: connections.has(device.id),
		status: statuses.get(device.id) ?? null,
		lastSeen: device.lastSeen
	}));
}

export async function removeDevice(deviceId: string, userId: string): Promise<boolean> {
	const { DeviceTable } = getSequelize();
	const removed = await DeviceTable.destroy({ where: { id: deviceId, UserId: userId } });

	closeConnection(deviceId);
	statuses.delete(deviceId);

	return removed > 0;
}

export async function ownsDevice(deviceId: string, userId: string): Promise<boolean> {
	const { DeviceTable } = getSequelize();
	const device = (await DeviceTable.findByPk(deviceId)) as DeviceModel | null;
	return !!device && device.UserId === userId;
}

/** Attaches a television's event stream, replacing any previous one. */
export function openConnection(
	deviceId: string,
	controller: ReadableStreamDefaultController<Uint8Array>
): void {
	closeConnection(deviceId);
	connections.set(deviceId, controller);
}

export function closeConnection(deviceId: string): void {
	const existing = connections.get(deviceId);
	if (!existing) return;

	connections.delete(deviceId);
	try {
		existing.close();
	} catch {
		// Already torn down by the client disconnecting.
	}
}

export function isOnline(deviceId: string): boolean {
	return connections.has(deviceId);
}

/** Pushes a command down a television's stream. False when it is not connected. */
export function sendCommand(deviceId: string, command: DeviceCommand): boolean {
	const controller = connections.get(deviceId);
	if (!controller) return false;

	try {
		controller.enqueue(encoder.encode(`data: ${JSON.stringify(command)}\n\n`));
		return true;
	} catch {
		connections.delete(deviceId);
		return false;
	}
}

/** Keeps proxies from closing an idle stream. */
export function sendKeepAlive(deviceId: string): void {
	const controller = connections.get(deviceId);
	if (!controller) return;

	try {
		controller.enqueue(encoder.encode(': keep-alive\n\n'));
	} catch {
		connections.delete(deviceId);
	}
}

export function setStatus(deviceId: string, status: Omit<DeviceStatus, 'updatedAt'>): void {
	statuses.set(deviceId, { ...status, updatedAt: Date.now() });
}

export function getStatus(deviceId: string): DeviceStatus | null {
	return statuses.get(deviceId) ?? null;
}

export async function touchDevice(deviceId: string): Promise<void> {
	const { DeviceTable } = getSequelize();
	await DeviceTable.update({ lastSeen: new Date() }, { where: { id: deviceId } });
}

/**
 * Stores the account's master key, sealed to one device.
 *
 * The server keeps this but can never read it: it is sealed to a public key
 * whose secret half never leaves the television.
 */
export async function storeSealedMasterKey(
	deviceId: string,
	userId: string,
	sealed: string
): Promise<boolean> {
	const { DeviceTable } = getSequelize();

	const [updated] = await DeviceTable.update(
		{ masterKeyCipher: sealed },
		{ where: { id: deviceId, UserId: userId } }
	);

	return updated > 0;
}

export async function getSealedMasterKey(deviceId: string): Promise<string | null> {
	const { DeviceTable } = getSequelize();
	const device = (await DeviceTable.findByPk(deviceId)) as DeviceModel | null;
	return device?.masterKeyCipher ?? null;
}

export async function getDevicePublicKey(deviceId: string, userId: string): Promise<string | null> {
	const { DeviceTable } = getSequelize();
	const device = (await DeviceTable.findByPk(deviceId)) as DeviceModel | null;
	if (!device || device.UserId !== userId) return null;
	return device.publicKey ?? null;
}
