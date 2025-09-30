import { mkdirSync } from 'fs';
import { resolve } from 'path';
import pino, { TransportMultiOptions } from 'pino';

type Target = TransportMultiOptions['targets'][number];

const level = process.env.LOG_LEVEL || 'info';
const targets: Target[] = [];

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

try {
	mkdirSync(logDir, { recursive: true });
	const destination = resolve(logDir, process.env.LOG_FILE_NAME ?? 'live.log');
	targets.push({
		target: 'pino/file',
		options: { destination, mkdir: true },
		level,
	});
} catch (err) {
	// eslint-disable-next-line no-console
	console.warn('logger-file-init-failed', (err as Error).message);
}

const transport = targets.length > 0 ? pino.transport({ targets }) : undefined;

export const log = transport ? pino({ level }, transport) : pino({ level });
