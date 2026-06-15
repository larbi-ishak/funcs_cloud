const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;       // 96-bit IV for GCM
const TAG_LENGTH = 16;      // 128-bit auth tag
const KEY_LENGTH = 32;      // 256-bit key

// Derive a 32-byte key from ENCRYPTION_KEY env var
function getKey() {
    const envKey = process.env.ENCRYPTION_KEY;
    if (!envKey) {
        throw new Error('ENCRYPTION_KEY env var is required for password encryption. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    }
    // If the key is a hex string (64 chars), use it directly
    if (envKey.length === 64 && /^[0-9a-fA-F]+$/.test(envKey)) {
        return Buffer.from(envKey, 'hex');
    }
    // Otherwise derive a key from the passphrase using SHA-256
    return crypto.createHash('sha256').update(envKey).digest();
}

/**
 * Encrypt a plaintext string.
 * Returns a base64-encoded string: IV + authTag + ciphertext
 * @param {string} plaintext
 * @returns {string} encrypted base64 string
 */
function encrypt(plaintext) {
    if (!plaintext) return plaintext;
    const key = getKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });

    let encrypted = cipher.update(plaintext, 'utf8', 'binary');
    encrypted += cipher.final('binary');

    const authTag = cipher.getAuthTag();

    // Format: IV (12 bytes) + authTag (16 bytes) + ciphertext
    const combined = Buffer.concat([
        iv,
        authTag,
        Buffer.from(encrypted, 'binary'),
    ]);

    return combined.toString('base64');
}

/**
 * Decrypt an encrypted string.
 * Handles both encrypted (base64) and legacy plaintext passwords gracefully.
 * @param {string} encrypted - encrypted base64 string or plaintext
 * @returns {string} decrypted plaintext
 */
function decrypt(encrypted) {
    if (!encrypted) return encrypted;

    // Try to detect if this is an encrypted value (base64 with correct structure)
    try {
        const key = getKey();
        const combined = Buffer.from(encrypted, 'base64');

        // Minimum length: IV (12) + authTag (16) + at least 1 byte ciphertext
        if (combined.length < IV_LENGTH + TAG_LENGTH + 1) {
            return encrypted; // Too short — treat as plaintext (legacy)
        }

        const iv = combined.subarray(0, IV_LENGTH);
        const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
        const ciphertext = combined.subarray(IV_LENGTH + TAG_LENGTH);

        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
        decipher.setAuthTag(authTag);

        let decrypted = decipher.update(ciphertext, undefined, 'utf8');
        decrypted += decipher.final('utf8');

        return decrypted;
    } catch (err) {
        // Decryption failed — this is likely a legacy plaintext password
        // (e.g., passwords stored before encryption was enabled)
        return encrypted;
    }
}

/**
 * Check if a value appears to be encrypted (base64 with AES-GCM structure).
 * @param {string} value
 * @returns {boolean}
 */
function isEncrypted(value) {
    if (!value) return false;
    try {
        const combined = Buffer.from(value, 'base64');
        return combined.length >= IV_LENGTH + TAG_LENGTH + 1;
    } catch {
        return false;
    }
}

module.exports = { encrypt, decrypt, isEncrypted };