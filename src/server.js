require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');
const snmp = require('snmp-native');

const PORT = process.env.PORT || 4567;
const NODE_ENV = process.env.NODE_ENV || 'development';
const PING_TIMEOUT = parseInt(process.env.PING_TIMEOUT || '1500', 10);
const PORT_CHECK_TIMEOUT = parseInt(process.env.PORT_CHECK_TIMEOUT || '1500', 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const HOUR_TIMEOUT = parseInt(process.env.HOUR_TIMEOUT || '20', 10);
const MINUTE_TIMEOUT = parseInt(process.env.MINUTE_TIMEOUT || '00', 10);


// Store all SSE clients
const sseClients = new Set();
let lastTimeoutMinute = -1;

function shouldPlayTimeout() {
    const now = new Date();
    const thaiTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
    const hours = thaiTime.getHours();
    const minutes = thaiTime.getMinutes();

    // Check if it's 20:43 Thai time
    if (hours === HOUR_TIMEOUT && minutes === MINUTE_TIMEOUT) {
        // Only trigger once per minute
        if (lastTimeoutMinute !== minutes) {
            lastTimeoutMinute = minutes;
            console.log(`[Timeout Alert] 🔔 It's ${HOUR_TIMEOUT}:${MINUTE_TIMEOUT.toString().padStart(2, '0')}! Sending alert to ${sseClients.size} clients`);
            return true;
        }
    } else {
        lastTimeoutMinute = -1;
    }

    return false;
}

// Check every second and notify all SSE clients if it's timeout time
setInterval(() => {
    if (shouldPlayTimeout()) {
        sseClients.forEach(client => {
            try {
                client.write('data: {"shouldPlay":true}\n\n');
            } catch (e) {
                sseClients.delete(client);
            }
        });
    }
}, 1000);

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
                    try { child.kill('SIGKILL'); } catch { }
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
            try { socket.destroy(); } catch { }
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

// SNMP connection count check
function getConnectionCount(ip, community = 'netlink', timeout = 5000) {
    return new Promise((resolve) => {
        if (!ip) return resolve(0);

        let session;
        let settled = false;
        
        // Timeout handler
        const timeoutHandle = setTimeout(() => {
            if (!settled) {
                settled = true;
                if (session) {
                    try { session.close(); } catch (e) {}
                }
                console.error(`SNMP timeout for ${ip} after ${timeout}ms`);
                resolve(0);
            }
        }, timeout);

        try {
            session = new snmp.Session({ 
                host: ip, 
                community: community, 
                timeouts: [timeout - 500],  // Set SNMP timeout slightly less than our timeout
                port: 161
            });
            
            // Query TCP connection table (OID: 1.3.6.1.2.1.6.13)
            session.getSubtree({ oid: [1, 3, 6, 1, 2, 1, 6, 13] }, (error, varbinds) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutHandle);
                
                try { session.close(); } catch (e) {}
                
                if (error) {
                    console.error(`SNMP error for ${ip}:`, error.message);
                    return resolve(0);
                }

                if (!varbinds || varbinds.length === 0) {
                    return resolve(0);
                }

                // Filter for established connections on ports 22 (SSH) and 23 (Telnet)
                let count = 0;
                
                varbinds.forEach((vb) => {
                    const oid = vb.oid.join('.');
                    const value = vb.value;
                    
                    // OID format: 1.3.6.1.2.1.6.13.1.1.[local_ip].[local_port].[remote_ip].[remote_port]
                    // We need to check if local_port is 22 or 23, and value (state) is 5 (established)
                    const parts = oid.split('.');
                    
                    // Find the local port position (after the 4 octets of local IP)
                    // Format: 1.3.6.1.2.1.6.13.1.1 = indices 0-9
                    // Local IP = indices 10-13 (4 octets)
                    // Local Port = index 14
                    if (parts.length >= 15) {
                        const localPort = parseInt(parts[14], 10);
                        const state = value;
                        
                        // Check if port 22 (SSH) or 23 (Telnet) and state is established (5)
                        if ((localPort === 22 || localPort === 23) && state === 5) {
                            count++;
                        }
                    }
                });

                resolve(count);
            });
        } catch (error) {
            if (!settled) {
                settled = true;
                clearTimeout(timeoutHandle);
                console.error(`SNMP exception for ${ip}:`, error.message);
                resolve(0);
            }
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

const publicDir = path.join(__dirname, 'public');

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

    // SNMP connection count endpoint
    if (req.method === 'GET' && url.pathname === '/connection-count') {
        const ip = url.searchParams.get('ip') || '';
        const community = url.searchParams.get('community') || 'netlink';
        getConnectionCount(ip, community).then((count) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ip, count }));
        });
        return;
    }

    // SSE endpoint for timeout notifications
    if (req.method === 'GET' && url.pathname === '/timeout-events') {
        // Set timeout to 0 (infinite) for SSE
        req.setTimeout(0);
        res.setTimeout(0);
        
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no', // Disable nginx buffering
            'Access-Control-Allow-Origin': CORS_ORIGIN
        });

        // Add client to SSE clients set
        sseClients.add(res);
        console.log(`[SSE] Client connected. Total clients: ${sseClients.size}`);

        // Send initial connection message
        res.write('data: {"connected":true}\n\n');

        // Keep connection alive with heartbeat every 15 seconds (reduced from 30)
        const heartbeat = setInterval(() => {
            try {
                res.write(': heartbeat\n\n');
            } catch (e) {
                clearInterval(heartbeat);
                sseClients.delete(res);
                console.log(`[SSE] Heartbeat failed, client removed`);
            }
        }, 15000);

        // Handle errors
        res.on('error', (err) => {
            console.log(`[SSE] Response error:`, err.message);
            clearInterval(heartbeat);
            sseClients.delete(res);
        });

        // Clean up on client disconnect
        req.on('close', () => {
            clearInterval(heartbeat);
            sseClients.delete(res);
            console.log(`[SSE] Client disconnected. Total clients: ${sseClients.size}`);
        });

        return;
    }

    // Serve config files
    if (req.method === 'GET' && url.pathname.startsWith('/config/')) {
        const configFile = url.pathname.replace('/config/', '');
        const configPath = path.join(__dirname, '..', 'config', configFile);

        fs.readFile(configPath, 'utf8', (err, data) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Config file not found' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(data);
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

// Set server timeout to 0 (infinite) to support SSE
server.timeout = 0;
server.keepAliveTimeout = 0;
server.headersTimeout = 0;

server.listen(PORT, () => {
    console.log(`[${NODE_ENV}] Server is running on http://localhost:${PORT}`);
    if (NODE_ENV === 'development') {
        console.log(`CORS Origin: ${CORS_ORIGIN}`);
        console.log(`Ping Timeout: ${PING_TIMEOUT}ms`);
        console.log(`Port Check Timeout: ${PORT_CHECK_TIMEOUT}ms`);
        console.log(`SSE: Enabled with infinite timeout`);
        console.log(`Timeout Alert Time: ${HOUR_TIMEOUT}:${MINUTE_TIMEOUT.toString().padStart(2, '0')} Thai Time`);
    }
});
