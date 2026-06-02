import { createLogger, format, transports } from 'winston';
import path from 'path';
import fs from 'fs';

const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const logger = createLogger({
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    format: format.combine(
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        format.errors({ stack: true }),
        format.json()
    ),
    defaultMeta: { service: 'nova-kata-gateway' },
    transports: [
        new transports.Console({
            format: format.combine(
                format.colorize(),
                format.timestamp({ format: 'HH:mm:ss' }),
                format.printf(({ timestamp, level, message, ...meta }) => {
                    const metaStr = Object.keys(meta).length
                        ? ' ' + JSON.stringify(meta)
                        : '';
                    return `[${timestamp}] ${level}: ${message}${metaStr}`;
                })
            ),
        }),
        new transports.File({
            filename: path.join(logsDir, 'error.log'),
            level: 'error',
        }),
        new transports.File({
            filename: path.join(logsDir, 'combined.log'),
        }),
    ],
});

export default logger;
