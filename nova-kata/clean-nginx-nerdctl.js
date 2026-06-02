const { createSSHClient } = require('./src/utils/ssh.js');

async function run() {
    const ssh = await createSSHClient({
        ip: '35.232.167.59',
        username: 'root',
        password: 'Larbiishak',
        port: 22
    });

    console.log("Fetching actual nerdctl containers...");
    const psResult = await ssh.exec("nerdctl ps -a --format '{{.Names}}'");
    const actualContainers = psResult.stdout.split('\n').map(x => x.trim()).filter(Boolean);
    
    // The conf files are named nova-${containerName}.conf
    const validConfNames = actualContainers.map(name => `nova-${name}.conf`);
    
    console.log(`Found ${validConfNames.length} actual containers on the worker.`);

    const lsResult = await ssh.exec('ls -1 /etc/nginx/conf.d/');
    const confFiles = lsResult.stdout.split('\n').map(x => x.trim()).filter(x => x.endsWith('.conf'));
    
    let removed = 0;
    for (const file of confFiles) {
        if (!validConfNames.includes(file)) {
            console.log(`Removing stale config: ${file}`);
            await ssh.exec(`rm -f /etc/nginx/conf.d/${file}`);
            removed++;
        }
    }
    
    console.log(`Removed ${removed} stale configs.`);
    await ssh.exec('nginx -s reload');
    console.log('Nginx reloaded.');
    process.exit(0);
}
run().catch(console.error);
