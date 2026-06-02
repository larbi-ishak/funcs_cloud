const { createSSHClient } = require('./src/utils/ssh.js');
createSSHClient({ip: '35.232.167.59', username: 'root', password: 'Larbiishak', port: 22}).then(async ssh => {
  const result = await ssh.exec('cat /etc/nginx/conf.d/*.conf | grep -B 2 -A 5 9004');
  console.log(result.stdout);
  process.exit(0);
}).catch(console.error);
