const { initDb, containers } = require('./src/db/database.js');
const { createSSHClient } = require('./src/utils/ssh.js');

async function run() {
    await initDb();
    const active = containers.findAll().filter(c => c.status !== 'stopped' && c.status !== 'failed');
    const validNames = active.map(c => `nova-${c.container_name}.conf`);
    
    console.log(`Found ${validNames.length} valid container configs.`);

    const ssh = await createSSHClient({
        ip: '35.232.167.59',
        username: 'root',
        password: 'Larbiishak',
        port: 22
    });

    const result = await ssh.exec('ls -1 /etc/nginx/conf.d/');
    const files = result.stdout.split('\n').map(x => x.trim()).filter(x => x.endsWith('.conf'));
    
    let removed = 0;
    for (const file of files) {
        if (!validNames.includes(file)) {
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
