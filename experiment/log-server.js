// Tiny log receiver — run on your PC, view extension logs in real time.
// Usage:  node experiment/log-server.js
// Logs appear in this terminal as they arrive from the iPhone.

const http = require('http');
const os = require('os');

const PORT = 9090;

const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/log') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            const ts = new Date().toISOString().slice(11, 23);
            let pretty = body;
            try { pretty = JSON.stringify(JSON.parse(body), null, 2); } catch {}
            console.log(`[${ts}]\n${pretty}\n`);
            res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
            res.end('ok');
        });
    } else {
        res.writeHead(404);
        res.end();
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Log server listening on http://0.0.0.0:${PORT}/log`);
    for (const entries of Object.values(os.networkInterfaces())) {
        for (const net of entries ?? []) {
            if (net.family === 'IPv4' && !net.internal) {
                console.log(`LAN URL: http://${net.address}:${PORT}/log`);
            }
        }
    }
    console.log('Waiting for logs from Paperback extension...\n');
});
