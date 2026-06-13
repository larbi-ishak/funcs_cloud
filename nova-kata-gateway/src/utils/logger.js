import pino from 'pino';
import path from 'path';
import fs from 'fs';

const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const logLevel = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

// In development, use pino-pretty for human-readable output.
// In production, write JSON to combined.log + error.log via destinations.
const isDev = process.env.NODE_ENV !== 'production';

const transport = isDev
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' } }
    : undefined;

const logger = pino(
    {
        level: logLevel,
        ...(transport ? { transport } : {}),
        redact: {
            paths: ['req.headers.authorization', 'req.headers["x-api-key"]'],
            censor: '[REDACTED]',
        },
        formatters: {
            level(label) {
                return { level: label };
            },
            bindings(bindings) {
                return { pid: bindings.pid, host: bindings.hostname, service: 'nova-kata-gateway' };
            },
        },
        timestamp: pino.stdTimeFunctions.isoTime,
    },
    isDev
        ? undefined // pino-pretty handles the destination
        : pino.destination({ dest: path.join(logsDir, 'combined.log'), sync: false })
);

// Graceful shutdown — flush pending log writes
const shutdown = () => {
    logger.info('Shutting down logger...');
    if (!isDev) {
        // pino.destination needs to be flushed on exit for async mode
        logger.flush();
    }
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export default logger;