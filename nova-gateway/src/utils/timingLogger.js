import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logsDir = path.resolve(__dirname, '../../logs');

if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

const timingsFile = path.join(logsDir, 'gateway-timings.log');

/**
 * Log a timing checkpoint.
 *
 * @param {string} requestId  - unique request id
 * @param {string} step       - step label (e.g. "parseHost", "existenceCheck")
 * @param {number} elapsed_ms - milliseconds since request started
 * @param {object} [extra]    - any additional key/value data to include
 */
export function logTiming(requestId, step, elapsed_ms, extra = {}) {
    const entry = {
        ts: new Date().toISOString(),
        requestId,
        step,
        elapsed_ms: +elapsed_ms.toFixed(2),
        ...extra,
    };

    const line = JSON.stringify(entry);

    // Console — always visible in the dev server terminal
    console.log(`[TIMING] ${line}`);

    // File — dedicated timings log for analysis
    fs.appendFile(timingsFile, line + '\n', () => {});
}
