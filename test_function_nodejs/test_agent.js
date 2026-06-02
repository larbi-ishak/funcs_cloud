const http = require('http');
const url  = require('url');

const entry = process.env.NOVA_ENTRY || './handler.js';
const mod   = require(entry);
const handlerFn = mod.handler || mod.default || (typeof mod === 'function' ? mod : null);
console.log('Nova agent ready — loaded', entry);

const server = http.createServer(async (req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
        try {
            const raw    = Buffer.concat(chunks);
            const parsed = url.parse(req.url, true);
            let jsonBody = null;
            try { if (raw.length) jsonBody = JSON.parse(raw); } catch (_) {}

            const event = {
                method:  req.method,
                path:    parsed.pathname,
                query:   parsed.query,
                headers: req.headers,
                body:    raw.length ? raw.toString() : null,
                json:    jsonBody,
            };

            if (!handlerFn) throw new Error('No handler() export found in: ' + entry);
            const result = await handlerFn(event);

            let status = 200, out;
            if (result && typeof result === 'object' && 'statusCode' in result) {
                status = result.statusCode;
                out    = JSON.stringify(result.body !== undefined ? result.body : result);
            } else {
                out = JSON.stringify(result);
            }
            res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(out) });
            res.end(out);
        } catch (e) {
            const out = JSON.stringify({ error: e.message, stack: e.stack });
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(out);
        }
    });
});

const port = parseInt(process.env.NOVA_PORT || '8080');
server.listen(port, () => console.log('Nova HTTP agent listening on :' + port));
