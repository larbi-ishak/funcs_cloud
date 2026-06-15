/**
 * Load test — fire N concurrent requests to a function endpoint.
 * Usage: node load-test.js [url] [concurrency]
 *   node load-test.js http://localhost:8081/fn/asdfaew 50
 */
const http = require('http');

const url = process.argv[2] || 'http://localhost:8081/fn/asdfaew';
const concurrency = parseInt(process.argv[3]) || 50;

const parsed = new URL(url);

console.log(`\n🚀 Firing ${concurrency} concurrent requests to ${url}\n`);

const start = performance.now();

const requests = Array.from({ length: concurrency }, (_, i) => {
    const t0 = performance.now();
    return new Promise((resolve) => {
        const req = http.request({
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname + parsed.search,
            method: 'GET',
            timeout: 30000,
        }, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                const elapsed = +(performance.now() - t0).toFixed(1);
                resolve({
                    index: i + 1,
                    status: res.statusCode,
                    elapsed,
                    bodyLength: body.length,
                    error: null,
                });
            });
        });

        req.on('error', (err) => {
            const elapsed = +(performance.now() - t0).toFixed(1);
            resolve({
                index: i + 1,
                status: 0,
                elapsed,
                bodyLength: 0,
                error: err.message,
            });
        });

        req.on('timeout', () => {
            const elapsed = +(performance.now() - t0).toFixed(1);
            req.destroy();
            resolve({
                index: i + 1,
                status: 0,
                elapsed,
                bodyLength: 0,
                error: 'TIMEOUT',
            });
        });

        req.end();
    });
});

Promise.allSettled(requests).then((results) => {
    const totalElapsed = +(performance.now() - start).toFixed(1);
    const responses = results.map(r => r.value);

    // Sort by response time
    responses.sort((a, b) => a.elapsed - b.elapsed);

    const successes = responses.filter(r => r.status >= 200 && r.status < 400);
    const failures = responses.filter(r => r.status === 0 || r.status >= 400);
    const statusCodes = {};
    for (const r of responses) {
        const key = r.error ? `ERR:${r.error}` : `${r.status}`;
        statusCodes[key] = (statusCodes[key] || 0) + 1;
    }

    const avgElapsed = responses.reduce((sum, r) => sum + r.elapsed, 0) / responses.length;
    const p50 = responses[Math.floor(responses.length * 0.5)].elapsed;
    const p90 = responses[Math.floor(responses.length * 0.9)].elapsed;
    const p99 = responses[Math.floor(responses.length * 0.99)].elapsed;
    const minElapsed = responses[0].elapsed;
    const maxElapsed = responses[responses.length - 1].elapsed;

    console.log('═'.repeat(60));
    console.log(`  RESULTS: ${concurrency} requests in ${totalElapsed}ms`);
    console.log('═'.repeat(60));
    console.log(`  Success:  ${successes.length}/${concurrency} (${(successes.length/concurrency*100).toFixed(1)}%)`);
    console.log(`  Failures: ${failures.length}/${concurrency} (${(failures.length/concurrency*100).toFixed(1)}%)`);
    console.log('');
    console.log('  Status codes:');
    for (const [code, count] of Object.entries(statusCodes)) {
        console.log(`    ${code}: ${count}`);
    }
    console.log('');
    console.log('  Latency:');
    console.log(`    Min:  ${minElapsed}ms`);
    console.log(`    Avg:  ${avgElapsed.toFixed(1)}ms`);
    console.log(`    P50:  ${p50}ms`);
    console.log(`    P90:  ${p90}ms`);
    console.log(`    P99:  ${p99}ms`);
    console.log(`    Max:  ${maxElapsed}ms`);
    console.log('═'.repeat(60));

    // Show first 10 responses for detail
    console.log('\n  First 10 responses:');
    for (const r of responses.slice(0, 10)) {
        const status = r.error ? `ERR:${r.error}` : r.status;
        console.log(`    #${r.index} → ${status} in ${r.elapsed}ms`);
    }

    if (failures.length > 0 && failures.length <= 10) {
        console.log('\n  Failed responses:');
        for (const r of failures) {
            console.log(`    #${r.index} → ${r.error || r.status} in ${r.elapsed}ms`);
        }
    }
    console.log('');
});