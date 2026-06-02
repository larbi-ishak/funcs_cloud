const { InstancesClient, ZoneOperationsClient } = require('@google-cloud/compute');
const logger = require('../utils/logger');

// ── Region → Zone map ─────────────────────────────────────────────────────────
// Each logical region maps to a specific GCP zone that supports nested
// virtualisation (n2 machine family, Intel Cascade Lake or newer).
const REGION_ZONE_MAP = {
    'us'     : 'us-central1-a',
    'us-east': 'us-east4-a',
    'us-west': 'us-west2-a',
    'europe' : 'europe-west2-a',     // London
    'eu-west': 'europe-west4-a',     // Netherlands
    'asia'   : 'asia-east1-a',       // Taiwan
    'asia-se': 'asia-southeast1-a',  // Singapore
    'africa' : 'africa-south1-a',    // Johannesburg (preview)
    'me'     : 'me-central1-a',      // Middle East (Doha)
};

// Exported so the API can return the list to the frontend
const AVAILABLE_REGIONS = Object.entries(REGION_ZONE_MAP).map(([id, zone]) => ({
    id,
    zone,
    label: regionLabel(id),
}));

function regionLabel(id) {
    const labels = {
        'us'     : 'United States (Iowa)',
        'us-east': 'United States (Virginia)',
        'us-west': 'United States (Los Angeles)',
        'europe' : 'Europe (London)',
        'eu-west': 'Europe (Netherlands)',
        'asia'   : 'Asia (Taiwan)',
        'asia-se': 'Asia (Singapore)',
        'africa' : 'Africa (Johannesburg)',
        'me'     : 'Middle East (Doha)',
    };
    return labels[id] || id;
}

/**
 * Resolve a logical region id to a GCP zone string.
 * Also accepts a raw GCP zone directly (e.g. "us-central1-a").
 */
function resolveZone(region) {
    if (REGION_ZONE_MAP[region]) return REGION_ZONE_MAP[region];
    // Allow passing a raw zone string
    if (/^[a-z]+-[a-z0-9]+-[a-z]$/.test(region)) return region;
    throw new Error(
        `Unknown region "${region}". Available: ${Object.keys(REGION_ZONE_MAP).join(', ')}`
    );
}

// ── Startup script injected into the VM on first boot ────────────────────────
// This runs as root automatically. It:
//   1. Removes drop-in sshd_config.d/ snippets that GCP puts there
//   2. Sets PermitRootLogin + PasswordAuthentication in sshd_config
//   3. Sets a predictable root password (from env var ROOT_PASSWORD)
//   4. Restarts sshd so the changes take effect
function buildStartupScript(rootPassword) {
    // Escape single-quotes in the password so it's safe inside the heredoc
    const safePassword = rootPassword.replace(/'/g, "'\\''");
    return `#!/bin/bash
set -e

# ── 1. Remove GCP drop-in config files that block root/password login ─────────
rm -f /etc/ssh/sshd_config.d/*.conf

# ── 2. Patch /etc/ssh/sshd_config ─────────────────────────────────────────────
sed -i 's/^#\\?PermitRootLogin.*/PermitRootLogin yes/'          /etc/ssh/sshd_config
sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config

# Append if not present at all
grep -q '^PermitRootLogin'         /etc/ssh/sshd_config || echo 'PermitRootLogin yes'         >> /etc/ssh/sshd_config
grep -q '^PasswordAuthentication'  /etc/ssh/sshd_config || echo 'PasswordAuthentication yes'  >> /etc/ssh/sshd_config

# ── 3. Set root password ───────────────────────────────────────────────────────
echo 'root:${safePassword}' | chpasswd

# ── 4. Restart sshd ───────────────────────────────────────────────────────────
systemctl restart sshd || systemctl restart ssh

echo "Nova startup script complete" >> /var/log/nova-startup.log
`;
}

// ── GCP client factory ────────────────────────────────────────────────────────
function getClients() {
    const projectId   = process.env.GCP_PROJECT_ID;
    const keyFilename = process.env.GCP_KEY_FILE;   // path to service-account JSON

    if (!projectId) throw new Error('GCP_PROJECT_ID is not set in environment');

    const opts = { projectId };
    if (keyFilename) opts.keyFilename = keyFilename;
    // If no key file, falls back to Application Default Credentials (ADC)

    return {
        instancesClient      : new InstancesClient(opts),
        zoneOperationsClient : new ZoneOperationsClient(opts),
        projectId,
    };
}

// ── Create a VM instance ──────────────────────────────────────────────────────
/**
 * Creates an n2-standard-2 VM with nested virtualisation enabled on GCP.
 *
 * @param {object} params
 * @param {string} params.region        - Logical region id (e.g. 'europe') or raw GCP zone
 * @param {string} params.instanceName  - Unique name for the VM
 * @param {string} params.rootPassword  - Root password to set via startup script
 * @param {string} [params.machineType] - Override machine type (default: n2-standard-2)
 * @param {number} [params.diskSizeGb]  - Boot disk size in GB (default: 100)
 * @returns {Promise<{ ip: string, instanceName: string, zone: string }>}
 */
async function createInstance({
    region,
    instanceName,
    rootPassword,
    machineType = process.env.GCP_MACHINE_TYPE || 'n2-standard-2',
    diskSizeGb  = parseInt(process.env.GCP_DISK_SIZE_GB) || 100,
}) {
    if (!rootPassword) throw new Error('rootPassword is required to configure SSH access');

    const zone = resolveZone(region);
    const { instancesClient, zoneOperationsClient, projectId } = getClients();

    logger.info(`[GCP] Creating instance "${instanceName}" in zone ${zone} (${machineType}, ${diskSizeGb}GB)...`);

    const startupScript = buildStartupScript(rootPassword);

    const instanceResource = {
        name       : instanceName,
        machineType: `zones/${zone}/machineTypes/${machineType}`,

        // ── Nested virtualisation ─────────────────────────────────────────────
        advancedMachineFeatures: {
            enableNestedVirtualization: true,
        },

        // ── CPU platform (Cascade Lake supports nested virt) ──────────────────
        minCpuPlatform: 'Intel Cascade Lake',

        // ── Boot disk ─────────────────────────────────────────────────────────
        disks: [
            {
                boot             : true,
                autoDelete       : true,
                initializeParams : {
                    sourceImage: 'projects/ubuntu-os-cloud/global/images/family/ubuntu-2204-lts',
                    diskSizeGb : String(diskSizeGb),
                    diskType   : `projects/${projectId}/zones/${zone}/diskTypes/pd-standard`,
                },
            },
        ],

        // ── Network (default VPC, ephemeral public IP) ────────────────────────
        networkInterfaces: [
            {
                network      : 'global/networks/default',
                accessConfigs: [{ type: 'ONE_TO_ONE_NAT', name: 'External NAT' }],
            },
        ],

        // ── Metadata (startup script) ─────────────────────────────────────────
        metadata: {
            items: [
                { key: 'startup-script', value: startupScript },
            ],
        },

        // ── Service account (use default compute SA) ──────────────────────────
        serviceAccounts: [
            {
                email : 'default',
                scopes: ['https://www.googleapis.com/auth/cloud-platform'],
            },
        ],

        tags: { items: ['nova-worker'] },
    };

    // ── Insert instance and wait for the zone operation to complete ───────────
    const [operation] = await instancesClient.insert({
        project         : projectId,
        zone,
        instanceResource,
    });

    logger.info(`[GCP] Insert operation started: ${operation.name}`);

    // Poll until the operation finishes
    await waitForOperation({ zoneOperationsClient, projectId, zone, operationName: operation.name });

    // ── Fetch the created instance to get its external IP ────────────────────
    const [instance] = await instancesClient.get({ project: projectId, zone, instance: instanceName });

    const ip = instance.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP;
    if (!ip) throw new Error(`Instance "${instanceName}" has no external IP after creation`);

    logger.info(`[GCP] Instance "${instanceName}" created. External IP: ${ip}`);
    return { ip, instanceName, zone };
}

// ── Delete a VM instance ──────────────────────────────────────────────────────
/**
 * Permanently deletes a GCP VM instance.
 *
 * @param {object} params
 * @param {string} params.instanceName
 * @param {string} params.zone - Raw GCP zone string (e.g. 'europe-west2-a')
 */
async function deleteInstance({ instanceName, zone }) {
    const { instancesClient, zoneOperationsClient, projectId } = getClients();

    logger.info(`[GCP] Deleting instance "${instanceName}" in zone ${zone}...`);

    const [operation] = await instancesClient.delete({
        project : projectId,
        zone,
        instance: instanceName,
    });

    await waitForOperation({ zoneOperationsClient, projectId, zone, operationName: operation.name });
    logger.info(`[GCP] Instance "${instanceName}" deleted`);
}

// ── Poll a zone operation until done ─────────────────────────────────────────
async function waitForOperation({ zoneOperationsClient, projectId, zone, operationName, pollIntervalMs = 5000, timeoutMs = 10 * 60 * 1000 }) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const [op] = await zoneOperationsClient.get({ project: projectId, zone, operation: operationName });

        if (op.status === 'DONE') {
            if (op.error) {
                const msg = op.error.errors?.map(e => e.message).join(', ') || 'Unknown GCP error';
                throw new Error(`GCP operation failed: ${msg}`);
            }
            return;
        }

        logger.debug(`[GCP] Operation ${operationName}: ${op.status} — waiting ${pollIntervalMs / 1000}s...`);
        await sleep(pollIntervalMs);
    }

    throw new Error(`GCP operation "${operationName}" timed out after ${timeoutMs / 1000}s`);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
    createInstance,
    deleteInstance,
    AVAILABLE_REGIONS,
    resolveZone,
};
