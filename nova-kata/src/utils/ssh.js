const { Client } = require('ssh2');
const logger = require('./logger');
const { decrypt } = require('./crypto');

const DEFAULT_TIMEOUT = parseInt(process.env.SSH_CONNECT_TIMEOUT) || 10000;
const DEFAULT_EXEC_TIMEOUT = parseInt(process.env.SSH_EXEC_TIMEOUT) || 30000;

/**
 * Creates and connects an SSH client to a remote host.
 * Returns an object with exec() and close() helpers.
 *
 * Supports keyboard-interactive auth (required by some servers that
 * disable the SSH "password" method but allow keyboard-interactive).
 */
function createSSHClient({ ip, username, password, port = 22 }) {
    // Decrypt password if it's encrypted (AES-256-GCM).
    // Legacy plaintext passwords are returned as-is by decrypt().
    const actualPassword = decrypt(password);

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
             * @param {number} [timeout]  Optional per-command timeout in ms. Defaults to SSH_EXEC_TIMEOUT.
             * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
             */
            const exec = (command, timeout = DEFAULT_EXEC_TIMEOUT) =>
                new Promise((res, rej) => {
                    const cmdTimer = setTimeout(() => {
                        rej(new Error(`SSH exec timed out: ${command}`));
                    }, timeout);

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

        conn.on('keyboard-interactive', (name, instructions, instructionsLang, prompts, finish) => {
            finish([actualPassword]);
        });

        conn.connect({
            host: ip,
            port,
            username,
            password: actualPassword,
            tryKeyboard: true,
            readyTimeout: DEFAULT_TIMEOUT,
            authHandler: ['password', 'keyboard-interactive', 'publickey'],
        });
    });
}

module.exports = { createSSHClient };
