import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
const port = Number(process.argv[3] || 8791);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://127.0.0.1');
        const rel = decodeURIComponent(url.pathname === '/' ? '/mock.html' : url.pathname);
        const file = path.resolve(root, '.' + rel);
        if (!file.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return; }
        const data = await fs.readFile(file);
        res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
    } catch {
        res.writeHead(404);
        res.end('not found');
    }
});

server.listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/mock.html`));
