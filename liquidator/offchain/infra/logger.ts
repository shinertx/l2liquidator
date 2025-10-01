import { mkdirSync } from 'fs';
import { resolve } from 'path';
import pino, { TransportMultiOptions } from 'pino';

type Target = TransportMultiOptions['targets'][number];

const level = process.env.LOG_LEVEL || 'info';
const targets: Target[] = [];

function parseSize(input: string | undefined, fallback: number): number {
	if (!input) return fallback;
	const match = /^\s*(\d+(?:\.\d+)?)([kKmMgG]?[bB]?)?\s*$/.exec(input);
	if (!match) return fallback;
	const value = Number(match[1]);
	if (!Number.isFinite(value) || value <= 0) return fallback;
	const unit = match[2]?.toLowerCase() ?? '';
	switch (unit.replace('b', '')) {
		case 'k':
			return Math.floor(value * 1024);
		case 'm':
			return Math.floor(value * 1024 * 1024);
		case 'g':
			return Math.floor(value * 1024 * 1024 * 1024);
		default:
			return Math.floor(value);
	}
}

function parseIntEnv(input: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(input ?? '', 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

if (process.env.LOG_DISABLE_STDOUT !== '1') {
	targets.push({
		target: 'pino/file',
		options: { destination: 1 },
		level,
	});
}

const logDir = process.env.LOG_DIR
	? resolve(process.cwd(), process.env.LOG_DIR)
	: resolve(process.cwd(), 'logs');
const logFileName = process.env.LOG_FILE_NAME ?? 'live.log';
const logMaxBytes = parseSize(process.env.LOG_MAX_BYTES, 20 * 1024 * 1024);
const logMaxFiles = parseIntEnv(process.env.LOG_MAX_FILES, 10);

try {
	mkdirSync(logDir, { recursive: true });
	targets.push({
		target: resolve(__dirname, './rolling-log-target.js'),
		options: {
			dir: logDir,
			baseName: logFileName,
			maxBytes: logMaxBytes,
			maxFiles: logMaxFiles,
		},
		level,
	});
} catch (err) {
	// eslint-disable-next-line no-console
	console.warn('logger-file-init-failed', (err as Error).message);
}

const transport = targets.length > 0 ? pino.transport({ targets }) : undefined;

export const log = transport ? pino({ level }, transport) : pino({ level });
