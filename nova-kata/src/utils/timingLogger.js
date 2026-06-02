const fs = require('fs');
const path = require('path');

const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const timingsFile = path.join(logsDir, 'kata-timings.log');

/**
 * Log a timing checkpoint to console and to kata-timings.log.
 *
 * @param {string} requestId  - container id (first 8 chars) or equivalent label
 * @param {string} step       - step label
 * @param {number} elapsed_ms - milliseconds since the operation started
 * @param {object} [extra]    - any additional key/value data
 */
function logTiming(requestId, step, elapsed_ms, extra = {}) {
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

module.exports = { logTiming };
