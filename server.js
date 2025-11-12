require('dotenv').config();
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');

const PORT = process.env.PORT || 4567;
const NODE_ENV = process.env.NODE_ENV || 'development';
const PING_TIMEOUT = parseInt(process.env.PING_TIMEOUT || '1500', 10);
const PORT_CHECK_TIMEOUT = parseInt(process.env.PORT_CHECK_TIMEOUT || '1500', 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

function pingHost(ip) {
    return new Promise((resolve) => {
        if (!ip) return resolve(false);
        const platform = os.platform();
        let args;

        if (platform.startsWith('win')) {
            // Windows: -n 1 = 1 echo, -w 500 = 500ms timeout (ลดจาก 800ms)
            args = ['-n', '1', '-w', '500', ip];
        } else if (platform === 'darwin') {
            // macOS: -c 1 and we'll enforce timeout via timer
            args = ['-c', '1', ip];
        } else {
            // Linux: -c 1 = 1 echo, -W 1 = 1 second timeout
            args = ['-c', '1', '-W', '1', ip];
        }

        try {
            const child = spawn('ping', args);
            let done = false;

            const timer = setTimeout(() => {
                if (!done) {
                    done = true;
                    try { child.kill('SIGKILL'); } catch {}
                    resolve(false);
                }
            }, 800); // ลดจาก 1500ms เป็น 800ms

            child.on('close', (code) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve(code === 0);
            });

            child.on('error', () => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve(false);
            });
        } catch {
            resolve(false);
        }
    });
}

function checkPort(ip, port, timeout = 800) { // ลดจาก 1500ms เป็น 800ms
    return new Promise((resolve) => {
        if (!ip || !port) return resolve(false);
        const socket = new net.Socket();
        let settled = false;

        const cleanup = () => {
            try { socket.destroy(); } catch {}
        };

        socket.setTimeout(timeout);
        socket.once('connect', () => {
            if (settled) return; settled = true; cleanup(); resolve(true);
        });
        socket.once('timeout', () => {
            if (settled) return; settled = true; cleanup(); resolve(false);
        });
        socket.once('error', () => {
            if (settled) return; settled = true; cleanup(); resolve(false);
        });

        try {
            socket.connect(port, ip);
        } catch {
            if (!settled) { settled = true; cleanup(); resolve(false); }
        }
    });
}

const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttc': 'font/collection'
};

const publicDir = __dirname;

function serveStatic(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let filePath = url.pathname;

    if (filePath === '/' || filePath === '') {
        filePath = '/index.html';
    }

    const normalized = path.normalize(filePath).replace(/^([\.\\/]+)/, '');
    const fullPath = path.join(publicDir, normalized);

    if (!fullPath.startsWith(publicDir)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
    }

    fs.stat(fullPath, (err, stats) => {
        if (err || !stats.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not found');
            return;
        }

        const ext = path.extname(fullPath).toLowerCase();
        const mime = mimeTypes[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime });

        if (req.method === 'HEAD') {
            res.end();
            return;
        }

        const stream = fs.createReadStream(fullPath);
        stream.on('error', () => {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal server error');
        });
        stream.pipe(res);
    });
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Set CORS headers for all requests (static + API)
    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // Health endpoint must be checked BEFORE static serving
    if (req.method === 'GET' && url.pathname === '/health') {
        const ip = url.searchParams.get('ip') || '';
        pingHost(ip).then((up) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ip, up }));
        });
        return;
    }

    // Proxmox health: TCP check to 8006 (HTTPS UI)
    if (req.method === 'GET' && url.pathname === '/proxmox-health') {
        const ip = url.searchParams.get('ip') || '';
        checkPort(ip, 8006).then((up) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ip, up }));
        });
        return;
    }

    // Serve static for other GET/HEAD requests
    if (req.method === 'GET' || req.method === 'HEAD') {
        serveStatic(req, res);
        return;
    }

    // No other methods supported
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
    console.log(`[${NODE_ENV}] Server is running on http://localhost:${PORT}`);
    if (NODE_ENV === 'development') {
        console.log(`CORS Origin: ${CORS_ORIGIN}`);
        console.log(`Ping Timeout: ${PING_TIMEOUT}ms`);
        console.log(`Port Check Timeout: ${PORT_CHECK_TIMEOUT}ms`);
    }
});
