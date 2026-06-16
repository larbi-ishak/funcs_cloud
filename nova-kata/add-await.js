const fs = require('fs');
const path = require('path');

const files = [
    'src/routes/containers.js',
    'src/routes/deploy.js',
    'src/services/containerService.js',
    'src/services/warmPoolService.js',
    'src/services/monitoringService.js',
    'src/services/workerService.js',
];

const dbObjs = 'functions|workers|containers|warmPool|events|apiKeys|invocations';
const regex = new RegExp('(?<!await )(' + dbObjs + ')\\.([a-zA-Z]+)\\(', 'g');

for (const f of files) {
    const fullPath = path.join(__dirname, f);
    let c = fs.readFileSync(fullPath, 'utf8');
    const orig = c;
    c = c.replace(regex, 'await $1.$2(');
    if (c !== orig) {
        fs.writeFileSync(fullPath, c);
        console.log('Updated: ' + f);
    } else {
        console.log('No changes: ' + f);
    }
}