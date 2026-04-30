const { Client } = require('ssh2');
const logger = require('./logger');

const DEFAULT_TIMEOUT = parseInt(process.env.SSH_CONNECT_TIMEOUT) || 10000;
const DEFAULT_EXEC_TIMEOUT = parseInt(process.env.SSH_EXEC_TIMEOUT) || 30000;

/**
 * Creates and connects an SSH client to a remote host.
 * Returns an object with exec() and close() helpers.
 */
function createSSHClient({ ip, username, password, port = 22 }) {
    return new Promise((resolve, reject) => {
        const conn = new Client();
        const timer = setTimeout(() => {
            conn.destroy();
            reject(new Error(`SSH connection to ${ip} timed out after ${DEFAULT_TIMEOUT}ms`));
        }, DEFAULT_TIMEOUT);

        conn.on('ready', () => {
            clearTimeout(timer);
            logger.debug(`SSH connected to ${ip}`);

            /**
             * Execute a command on the remote host.
             * @param {string} command
             * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
             */
            const exec = (command) =>
                new Promise((res, rej) => {
                    const cmdTimer = setTimeout(() => {
                        rej(new Error(`SSH exec timed out: ${command}`));
                    }, DEFAULT_EXEC_TIMEOUT);

                    conn.exec(command, (err, stream) => {
                        if (err) {
                            clearTimeout(cmdTimer);
                            return rej(err);
                        }

                        let stdout = '';
                        let stderr = '';

                        stream
                            .on('close', (code) => {
                                clearTimeout(cmdTimer);
                                res({ stdout: stdout.trim(), stderr: stderr.trim(), code });
                            })
                            .on('data', (data) => { stdout += data; })
                            .stderr.on('data', (data) => { stderr += data; });
                    });
                });

            const close = () => conn.end();

            resolve({ exec, close, raw: conn });
        });

        conn.on('error', (err) => {
            clearTimeout(timer);
            reject(new Error(`SSH error connecting to ${ip}: ${err.message}`));
        });

        conn.connect({
            host: ip,
            port,
            username,
            password,
            readyTimeout: DEFAULT_TIMEOUT,
        });
    });
}

module.exports = { createSSHClient };
