import fs from 'fs';
import path from 'path';

const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const timingsFile = path.join(logsDir, 'gateway-timings.log');

export function logTiming(requestId, step, elapsed_ms, extra = {}) {
    const entry = {
        ts: new Date().toISOString(),
        requestId,
        step,
        elapsed_ms: +elapsed_ms.toFixed(2),
        ...extra,
    };

    const line = JSON.stringify(entry);
    console.log(`[TIMING] ${line}`);
    fs.appendFile(timingsFile, line + '\n', () => {});
}
