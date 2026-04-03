// Tiny log receiver — run on your PC, view extension logs in real time.
// Usage:  node experiment/log-server.js
// Logs appear in this terminal as they arrive from the iPhone.

const http = require('http');

const PORT = 9090;

const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/log') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            const ts = new Date().toISOString().slice(11, 23);
            console.log(`[${ts}] ${body}`);
            res.writeHead(200);
            res.end('ok');
        });
    } else {
        res.writeHead(404);
        res.end();
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Log server listening on http://0.0.0.0:${PORT}/log`);
    console.log('Waiting for logs from Paperback extension...\n');
});
