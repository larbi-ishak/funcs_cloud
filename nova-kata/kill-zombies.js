const { initDb, containers, workers } = require('./src/db/database.js');
const { createSSHClient } = require('./src/utils/ssh.js');

async function run() {
    await initDb();
    
    // Get the correct worker ID for 35.232.167.59
    const worker = workers.findAll().find(w => w.ip === '35.232.167.59');
    if (!worker) throw new Error("Worker not found");
    
    // Get all valid containers that belong to THIS worker according to DB
    const active = containers.findByWorker(worker.id);
    const validContainerNames = active.map(c => c.container_name);
    
    console.log(`Found ${validContainerNames.length} valid active containers for this worker in DB.`);

    const ssh = await createSSHClient({
        ip: '35.232.167.59',
        username: 'root',
        password: 'Larbiishak',
        port: 22
    });

    // 1. Get all actual containers on worker
    const psResult = await ssh.exec("nerdctl ps -a --format '{{.Names}}'");
    const actualContainers = psResult.stdout.split('\n').map(x => x.trim()).filter(Boolean);
    
    let killed = 0;
    for (const name of actualContainers) {
        if (!validContainerNames.includes(name) && name.startsWith('nova-')) {
            console.log(`Killing zombie container: ${name}`);
            await ssh.exec(`nerdctl stop ${name} 2>/dev/null`);
            await ssh.exec(`nerdctl rm -f ${name} 2>/dev/null`);
            
            console.log(`Removing zombie nginx config: nova-${name}.conf`);
            await ssh.exec(`rm -f /etc/nginx/conf.d/nova-${name}.conf`);
            killed++;
        }
    }
    
    if (killed > 0) {
        await ssh.exec('nginx -s reload');
        console.log(`Nginx reloaded. Killed ${killed} zombie containers.`);
    } else {
        console.log("No zombies found.");
    }
    process.exit(0);
}
run().catch(console.error);
