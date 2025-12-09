require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { serve } = require('@hono/node-server');
const { serveStatic } = require('@hono/node-server/serve-static');
const { Hono } = require('hono');
const { cors } = require('hono/cors');
const { streamSSE } = require('hono/streaming');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const snmp = require('snmp-native');

const PORT = process.env.PORT || 4567;
const NODE_ENV = process.env.NODE_ENV || 'development';
const PING_TIMEOUT = parseInt(process.env.PING_TIMEOUT || '1500', 10);
const PORT_CHECK_TIMEOUT = parseInt(process.env.PORT_CHECK_TIMEOUT || '1500', 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const HOUR_TIMEOUT = parseInt(process.env.HOUR_TIMEOUT || '20', 10);
const MINUTE_TIMEOUT = parseInt(process.env.MINUTE_TIMEOUT || '00', 10);
const SOUNDTRACK_DIR = path.join(__dirname, 'public', 'music', 'soundtrack');

const app = new Hono();

// Middleware
app.use('*', cors({
    origin: CORS_ORIGIN,
    allowMethods: ['GET', 'HEAD', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
}));

// --- Helper Functions ---

function pingHost(ip) {
    return new Promise((resolve) => {
        if (!ip) return resolve({ up: false, latency: null });
        const platform = os.platform();
        let args;

        if (platform.startsWith('win')) {
            args = ['-n', '1', '-w', '500', ip];
        } else if (platform === 'darwin') {
            args = ['-c', '1', ip];
        } else {
            args = ['-c', '1', '-W', '1', ip];
        }

        try {
            const child = spawn('ping', args);
            let done = false;
            let output = '';

            const timer = setTimeout(() => {
                if (!done) {
                    done = true;
                    try { child.kill('SIGKILL'); } catch { }
                    resolve({ up: false, latency: null });
                }
            }, 800);

            child.stdout.on('data', (data) => {
                output += data.toString();
            });

            child.on('close', (code) => {
                if (done) return;
                done = true;
                clearTimeout(timer);

                if (code !== 0) {
                    return resolve({ up: false, latency: null });
                }

                let latency = null;
                if (platform.startsWith('win')) {
                    const match = output.match(/time[=<](\d+)ms/i);
                    if (match) latency = parseInt(match[1], 10);
                } else {
                    const match = output.match(/time=(\d+\.?\d*)\s*ms/i);
                    if (match) latency = Math.round(parseFloat(match[1]));
                }

                resolve({ up: true, latency });
            });

            child.on('error', () => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve({ up: false, latency: null });
            });
        } catch {
            resolve({ up: false, latency: null });
        }
    });
}

function checkPort(ip, port, timeout = 800) {
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

function getConnectionCount(ip, community = 'netlink', timeout = 5000) {
    return new Promise((resolve) => {
        if (!ip) return resolve(0);

        let session;
        let settled = false;

        const timeoutHandle = setTimeout(() => {
            if (!settled) {
                settled = true;
                if (session) {
                    try { session.close(); } catch (e) { }
                }
                console.error(`SNMP timeout for ${ip} after ${timeout}ms`);
                resolve(0);
            }
        }, timeout);

        try {
            session = new snmp.Session({
                host: ip,
                community: community,
                timeouts: [timeout - 500],
                port: 161
            });

            session.getSubtree({ oid: [1, 3, 6, 1, 2, 1, 6, 13] }, (error, varbinds) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutHandle);

                try { session.close(); } catch (e) { }

                if (error) {
                    console.error(`SNMP error for ${ip}:`, error.message);
                    return resolve(0);
                }

                if (!varbinds || varbinds.length === 0) {
                    return resolve(0);
                }

                let count = 0;
                varbinds.forEach((vb) => {
                    const oid = vb.oid.join('.');
                    const value = vb.value;
                    const parts = oid.split('.');

                    if (parts.length >= 15) {
                        const localPort = parseInt(parts[14], 10);
                        const state = value;
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

function fetchProxmoxConnectionCount(ip) {
    return new Promise((resolve) => {
        const targetHost = (typeof ip === 'string' && ip.trim().length > 0) ? ip.trim() : '10.30.6.119';
        const options = {
            hostname: targetHost,
            port: 8080,
            path: '/api/connection_count',
            method: 'GET',
            timeout: 2000
        };

        const req = http.request(options, (resp) => {
            let data = '';
            resp.on('data', chunk => data += chunk);
            resp.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve(parsed);
                } catch (e) {
                    console.error(`Failed to parse proxmox connection count for ${targetHost}:`, e.message);
                    resolve({ established_connections: 0, port: 8006 });
                }
            });
        });

        req.on('timeout', () => {
            req.destroy();
            resolve({ established_connections: 0, port: 8006 });
        });

        req.on('error', (err) => {
            console.error(`Error fetching proxmox connection count for ${targetHost}:`, err.message);
            resolve({ established_connections: 0, port: 8006 });
        });

        req.end();
    });
}

function prettifyTrackName(fileName) {
    if (!fileName || typeof fileName !== 'string') return 'Unknown Track';
    const withoutExt = fileName.replace(/\.[^.]+$/, '');
    const noDiscIndex = withoutExt.replace(/^\d+-\d+\.\s*/, '');
    const noSimpleIndex = noDiscIndex.replace(/^\d+\.\s*/, '');
    const cleaned = noSimpleIndex.replace(/_/g, ' ').trim();
    return cleaned.length ? cleaned : 'Unknown Track';
}

async function getSoundtrackList() {
    try {
        if (!fs.existsSync(SOUNDTRACK_DIR)) return [];
        const files = await fs.promises.readdir(SOUNDTRACK_DIR);
        return files
            .filter((file) => /\.(mp3|wav|ogg)$/i.test(file))
            .map((file) => ({
                file,
                title: prettifyTrackName(file),
                url: `/music/soundtrack/${encodeURIComponent(file)}`
            }));
    } catch (error) {
        console.error('[Soundtrack] Failed to list soundtrack files:', error.message);
        return [];
    }
}

// --- SSE Logic ---
let lastTimeoutMinute = -1;
const sseControllers = new Set();

// State
let devices = [];
let proxmoxHosts = [];
let deviceStates = {}; // { ip: { online: bool, latency: int, connCount: int } }
let proxmoxStates = {}; // { ip: { online: bool, latency: int, connCount: int } }

// Load configs
async function loadConfigs() {
    try {
        const devicesPath = path.join(__dirname, '..', 'config', 'devices.json');
        const proxmoxPath = path.join(__dirname, '..', 'config', 'proxmox.json');
        
        if (fs.existsSync(devicesPath)) {
            devices = JSON.parse(await fs.promises.readFile(devicesPath, 'utf8'));
        }
        if (fs.existsSync(proxmoxPath)) {
            proxmoxHosts = JSON.parse(await fs.promises.readFile(proxmoxPath, 'utf8'));
        }
        console.log(`[Config] Loaded ${devices.length} devices and ${proxmoxHosts.length} Proxmox hosts`);
    } catch (e) {
        console.error('[Config] Error loading configs:', e);
    }
}

loadConfigs();

// Watch for config changes
const configDir = path.join(__dirname, '..', 'config');
if (fs.existsSync(configDir)) {
    let fsWait = false;
    fs.watch(configDir, (event, filename) => {
        if (filename && (filename === 'devices.json' || filename === 'proxmox.json')) {
            if (fsWait) return;
            fsWait = setTimeout(() => {
                fsWait = false;
            }, 100);
            console.log(`[Config] Detected change in ${filename}, reloading...`);
            loadConfigs();
        }
    });
}

function broadcast(type, data) {
    const message = `data: ${JSON.stringify({ type, data })}\n\n`;
    sseControllers.forEach(controller => {
        try {
            controller.write(message);
        } catch (e) {
            sseControllers.delete(controller);
        }
    });
}

function shouldPlayTimeout() {
    const now = new Date();
    const thaiTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
    const hours = thaiTime.getHours();
    const minutes = thaiTime.getMinutes();

    if (hours === HOUR_TIMEOUT && minutes === MINUTE_TIMEOUT) {
        if (lastTimeoutMinute !== minutes) {
            lastTimeoutMinute = minutes;
            console.log(`[Timeout Alert] 🔔 It's ${HOUR_TIMEOUT}:${MINUTE_TIMEOUT.toString().padStart(2, '0')}! Sending alert to ${sseControllers.size} clients`);
            return true;
        }
    } else {
        lastTimeoutMinute = -1;
    }
    return false;
}

// Centralized Polling
async function pollDevices() {
    try {
        // Poll Terminal Servers
        for (const device of devices) {
            const ip = device.ip;
            const protocol = device.protocol || 'ssh';
            const targetPort = protocol === 'telnet' ? 23 : 22;
            
            // Check Health (Port + Ping)
            const [portUp, pingRes] = await Promise.all([
                checkPort(ip, targetPort),
                pingHost(ip)
            ]);
            
            // Check Connection Count (SNMP)
            let connCount = 0;
            if (portUp || pingRes.up) {
                connCount = await getConnectionCount(ip);
            }

            const newState = {
                ip,
                online: portUp, // Status depends on the service port
                latency: pingRes.latency,
                connCount
            };

            deviceStates[ip] = newState;
            broadcast('device_update', newState);
        }

        // Poll Proxmox Hosts
        for (const host of proxmoxHosts) {
            const ip = host.ip;
            
            // Check Health (Port 8006 + Ping)
            const [up, pingRes] = await Promise.all([
                checkPort(ip, 8006),
                pingHost(ip)
            ]);

            // Check Connection Count (API)
            let connCount = 0;
            if (up) {
                const proxData = await fetchProxmoxConnectionCount(ip);
                connCount = proxData.established_connections || 0;
            }

            const newState = {
                ip,
                online: up,
                latency: pingRes.latency,
                connCount
            };

            proxmoxStates[ip] = newState;
            broadcast('proxmox_update', newState);
        }
    } catch (error) {
        console.error('[Polling] Error in polling loop:', error);
    } finally {
        // Schedule next run
        setTimeout(pollDevices, 5000);
    }
}

// Start Polling Loop
pollDevices();

// Timeout Check Loop (every 1 second)
setInterval(() => {
    if (shouldPlayTimeout()) {
        broadcast('timeout', { shouldPlay: true });
    }
}, 1000);


// --- Routes ---

app.get('/health', async (c) => {
    const ip = c.req.query('ip') || '';
    const result = await pingHost(ip);
    return c.json({ ip, up: result.up, latency: result.latency });
});

app.get('/proxmox-health', async (c) => {
    const ip = c.req.query('ip') || '';
    try {
        const [up, pingResult] = await Promise.all([
            checkPort(ip, 8006),
            pingHost(ip)
        ]);
        return c.json({ ip, up, latency: pingResult.latency, pingUp: pingResult.up });
    } catch {
        return c.json({ ip, up: false, latency: null, pingUp: false });
    }
});

app.get('/proxmox-connection-count', async (c) => {
    const ip = c.req.query('ip');
    if (!ip) {
        return c.json({ error: 'Missing ip parameter' }, 400);
    }
    try {
        const data = await fetchProxmoxConnectionCount(ip);
        return c.json({ ip, ...data });
    } catch {
        return c.json({ ip, established_connections: 0, port: 8006 });
    }
});

app.get('/connection-count', async (c) => {
    const ip = c.req.query('ip') || '';
    const community = c.req.query('community') || 'netlink';
    const count = await getConnectionCount(ip, community);
    return c.json({ ip, count });
});

app.get('/soundtracks', async (c) => {
    const tracks = await getSoundtrackList();
    return c.json({ tracks });
});

app.get('/snow-textures', async (c) => {
    try {
        const snowDir = path.join(__dirname, 'public', 'img', 'snow');
        if (!fs.existsSync(snowDir)) return c.json([]);
        const files = await fs.promises.readdir(snowDir);
        const textures = files.filter(f => /\.(png|jpg|jpeg|gif)$/i.test(f));
        return c.json(textures);
    } catch (e) {
        console.error('Error listing snow textures:', e);
        return c.json([]);
    }
});

// SSE Endpoint
app.get('/events', (c) => {
    return streamSSE(c, async (stream) => {
        sseControllers.add(stream);
        console.log(`[SSE] Client connected. Total clients: ${sseControllers.size}`);
        
        await stream.write('data: {"type":"connected", "data":true}\n\n');

        // Send current state immediately
        const fullState = {
            devices: Object.values(deviceStates),
            proxmox: Object.values(proxmoxStates)
        };
        await stream.write(`data: ${JSON.stringify({ type: 'full_state', data: fullState })}\n\n`);

        const heartbeat = setInterval(async () => {
            try {
                await stream.write(': heartbeat\n\n');
            } catch (e) {
                clearInterval(heartbeat);
                sseControllers.delete(stream);
            }
        }, 15000);

        stream.onAbort(() => {
            clearInterval(heartbeat);
            sseControllers.delete(stream);
            console.log(`[SSE] Client disconnected. Total clients: ${sseControllers.size}`);
        });
        
        // Keep connection open
        while (true) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    });
});

// Config files
app.get('/config/:file', async (c) => {
    const fileName = c.req.param('file');
    const configPath = path.join(__dirname, '..', 'config', fileName);
    
    try {
        if (!fs.existsSync(configPath)) {
            return c.json({ error: 'Config file not found' }, 404);
        }
        const content = await fs.promises.readFile(configPath, 'utf8');
        return c.json(JSON.parse(content));
    } catch (e) {
        return c.json({ error: 'Error reading config file' }, 500);
    }
});

// Static files
app.use('/*', serveStatic({ root: './src/public' }));

// Start server
console.log(`[${NODE_ENV}] Server is running on http://localhost:${PORT}`);
if (NODE_ENV === 'development') {
    console.log(`CORS Origin: ${CORS_ORIGIN}`);
    console.log(`Ping Timeout: ${PING_TIMEOUT}ms`);
    console.log(`Port Check Timeout: ${PORT_CHECK_TIMEOUT}ms`);
    console.log(`SSE: Enabled`);
    console.log(`Timeout Alert Time: ${HOUR_TIMEOUT}:${MINUTE_TIMEOUT.toString().padStart(2, '0')} Thai Time`);
}

serve({
    fetch: app.fetch,
    port: PORT
});
