document.addEventListener('alpine:init', () => {
    Alpine.data('netherlinkApp', () => ({
        // State
        page: 'main', // 'main', 'terminal', 'proxmox'
        splashText: 'CNI 2025/2!',
        devices: [],
        proxmoxHosts: [],
        hiddenTerminalIps: [],
        hiddenProxmoxIps: [],
        soundtrackTracks: [],
        trackQueue: [],
        trackHistory: [],
        currentTrack: null,
        currentTrackTitle: '',
        jukeboxLoading: true,
        pendingMusicStart: false,
        isMusicPaused: false,
        trackDuration: 0,
        trackPosition: 0,
        
        // Loading State
        loading: true,
        loadingMessage: 'Building Terrain',
        loadingProgress: 0,
        
        // Audio State
        soundVolume: 100,
        musicVolume: 100,
        musicStarted: false,
        
        // Snow State
        snowDensity: 50,
        snowImages: [],
        snowLayers: [], // { id, canvas, ctx, particles }
        mouseX: 0,
        mouseY: 0,
        animationFrameId: null,

        // UI State
        showOptions: false,
        showQuit: false,
        tipsOpen: false,
        activeTipIp: null,
        sshCmd: '',
        telnetCmd: '',
        portalActive: false,
        statusMessage: '',
        statusType: 'info',
        scanDots: 'O o O',
        
        // Audio Objects
        bgMusic: null,
        clickSound: null,
        timeoutSound: null,
        netherSound: null,
        dropSound: null,
        
        // Timers & SSE
        healthTimer: null,
        scanTimer: null,
        sseSource: null,
        timeoutPlayed: false,

        async init() {
            this.initAudio();
            this.initSnow();
            this.startScanDots();
            await this.loadSplash();
            await this.loadData();
            await this.loadSoundtracks();
            this.initSSE();
            
            // Watch for volume changes
            this.$watch('soundVolume', val => this.updateSoundVolume(val));
            this.$watch('musicVolume', val => this.updateMusicVolume(val));
            this.$watch('snowDensity', val => this.updateSnowDensity(val));
            
            // Global keyboard listener for Escape and drop hotkey
            window.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') this.closeTips();
                if (e.key === 'q' || e.key === 'Q') this.handleDropHotkey(e);
            });

            // Background video handling
            const bgVideo = document.getElementById('bgVideo');
            if (bgVideo) {
                bgVideo.addEventListener('ended', () => {
                    bgVideo.currentTime = 0;
                    bgVideo.play().catch(() => {});
                });
                document.addEventListener('visibilitychange', () => {
                    if (!document.hidden && bgVideo.paused) {
                        bgVideo.play().catch(() => {});
                    }
                });
            }
        },

        // --- Audio Logic ---
        initAudio() {
            this.bgMusic = document.getElementById('bgMusic');
            this.clickSound = new Audio('sfx/minecraft_click.mp3');
            this.timeoutSound = new Audio('sfx/timeout.mp3');
            this.timeoutSound.addEventListener('ended', () => {
                // Restore music volume when timeout sound ends
                this.updateMusicVolume(this.musicVolume);
            });
            this.netherSound = document.getElementById('netherSound');
            this.dropSound = new Audio('sfx/drop.mp3');

            if (this.bgMusic) {
                this.bgMusic.loop = false;
                this.bgMusic.addEventListener('ended', () => this.playNextTrack());
                this.bgMusic.addEventListener('timeupdate', () => this.syncTrackPosition());
                this.bgMusic.addEventListener('loadedmetadata', () => this.syncTrackDuration());
                this.bgMusic.addEventListener('durationchange', () => this.syncTrackDuration());
            }
            
            // Set initial volumes
            this.updateSoundVolume(this.soundVolume);
            this.updateMusicVolume(this.musicVolume);
            
            // Play music on first interaction
            const startMusic = () => {
                this.playFromJukebox(true);
            };
            document.addEventListener('click', startMusic, { once: true });
        },

        updateSoundVolume(val) {
            const vol = val / 100;
            if(this.clickSound) this.clickSound.volume = vol;
            if(this.timeoutSound) this.timeoutSound.volume = vol;
            if(this.netherSound) this.netherSound.volume = vol;
            if(this.dropSound) this.dropSound.volume = vol;
        },

        updateMusicVolume(val) {
            const vol = val / 100;
            if(this.bgMusic) this.bgMusic.volume = vol;
        },

        playClick() {
            if(this.clickSound) {
                this.clickSound.currentTime = 0;
                this.clickSound.play().catch(() => {});
            }
        },

        playDrop() {
            if(this.dropSound) {
                this.dropSound.currentTime = 0;
                this.dropSound.play().catch(() => {});
            }
        },

        async loadSoundtracks() {
            this.jukeboxLoading = true;
            try {
                const response = await fetch('/soundtracks');
                if (!response.ok) throw new Error('Failed to fetch soundtrack list');
                const payload = await response.json();
                const tracks = Array.isArray(payload.tracks) ? payload.tracks : [];
                this.soundtrackTracks = tracks.map((track) => ({
                    ...track,
                    url: track.url || track.file || ''
                })).filter(track => track.url);
            } catch (error) {
                console.error('Error loading soundtrack list', error);
                this.soundtrackTracks = [{
                    title: 'Main Menu Theme',
                    url: 'music/mainmenu_music.mp3',
                    file: 'mainmenu_music.mp3'
                }];
            } finally {
                this.jukeboxLoading = false;
                if (this.pendingMusicStart) {
                    this.playFromJukebox(true);
                }
            }
        },

        shuffleTracks(list) {
            const arr = [...list];
            for (let i = arr.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [arr[i], arr[j]] = [arr[j], arr[i]];
            }
            return arr;
        },

        playFromJukebox(force = false) {
            if (!this.bgMusic) return;
            if (!this.soundtrackTracks.length) {
                this.pendingMusicStart = true;
                return;
            }
            this.pendingMusicStart = false;
            if (!this.trackQueue.length) {
                this.trackQueue = this.shuffleTracks(this.soundtrackTracks);
            }
            if (!this.musicStarted || force) {
                this.playNextTrack(true);
            }
        },

        playNextTrack(force = false) {
            if (!this.bgMusic) return;
            if (!this.soundtrackTracks.length) return;
            if (!this.trackQueue.length) {
                this.trackQueue = this.shuffleTracks(this.soundtrackTracks);
            }
            const nextTrack = this.trackQueue.shift();
            if (!nextTrack) return;
            this.startTrack(nextTrack, { addToHistory: true, force });
        },

        startTrack(track, { addToHistory = true, force = false } = {}) {
            if (!track || !this.bgMusic) return;
            if (addToHistory && this.currentTrack) {
                this.trackHistory.push(this.currentTrack);
                if (this.trackHistory.length > 20) {
                    this.trackHistory.shift();
                }
            }
            this.currentTrack = track;
            this.currentTrackTitle = track.title || track.file;
            this.trackPosition = 0;
            this.trackDuration = Number.isFinite(track.duration) ? track.duration : 0;
            this.bgMusic.src = track.url || track.file;
            this.bgMusic.load();
            this.isMusicPaused = false;
            const playPromise = this.bgMusic.play();
            if (playPromise) {
                playPromise.then(() => {
                    this.musicStarted = true;
                }).catch((err) => {
                    if (force) {
                        console.warn('Unable to start jukebox playback', err);
                    }
                });
            }
        },

        playPreviousTrack() {
            this.playClick();
            if (!this.bgMusic) return;
            if (!this.trackHistory.length) return;
            if (this.currentTrack) {
                this.trackQueue.unshift(this.currentTrack);
            }
            const previous = this.trackHistory.pop();
            this.startTrack(previous, { addToHistory: false, force: true });
        },

        togglePause() {
            this.playClick();
            if (!this.bgMusic) return;
            if (!this.musicStarted) {
                this.playFromJukebox(true);
                return;
            }
            if (this.isMusicPaused) {
                const resumePromise = this.bgMusic.play();
                if (resumePromise) {
                    resumePromise.then(() => {
                        this.isMusicPaused = false;
                    }).catch(() => {});
                } else {
                    this.isMusicPaused = false;
                }
            } else {
                this.bgMusic.pause();
                this.isMusicPaused = true;
            }
        },

        skipTrack() {
            this.playClick();
            if (!this.musicStarted) return;
            this.playNextTrack(true);
        },

        syncTrackDuration() {
            if (!this.bgMusic) return;
            const duration = this.bgMusic.duration;
            this.trackDuration = Number.isFinite(duration) ? duration : 0;
        },

        syncTrackPosition() {
            if (!this.bgMusic) return;
            const position = this.bgMusic.currentTime;
            this.trackPosition = Number.isFinite(position) ? position : 0;
        },

        handleSeekInput(value) {
            if (!this.bgMusic || !this.musicStarted || !this.trackDuration) return;
            const newTime = parseFloat(value);
            if (!Number.isFinite(newTime)) return;
            const clamped = Math.min(Math.max(newTime, 0), this.trackDuration);
            this.bgMusic.currentTime = clamped;
            this.trackPosition = clamped;
        },

        formatTime(seconds) {
            if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
            const mins = Math.floor(seconds / 60);
            const secs = Math.floor(seconds % 60);
            return `${mins}:${secs.toString().padStart(2, '0')}`;
        },

        // --- Data Loading ---
        async loadSplash() {
            try {
                const res = await fetch('/config/splashtext.json');
                const texts = await res.json();
                if (texts.length > 0) {
                    this.splashText = texts[Math.floor(Math.random() * texts.length)];
                }
            } catch (e) {
                console.error('Failed to load splash text', e);
            }
        },

        async loadData() {
            this.loadingMessage = 'Checking devices...';
            try {
                const [devRes, proxRes] = await Promise.all([
                    fetch('/config/devices.json'),
                    fetch('/config/proxmox.json')
                ]);
                
                const rawDevices = await devRes.json();
                const rawProxmox = await proxRes.json();
                
                // Initialize with default properties
                this.devices = rawDevices.map(d => ({ ...d, online: false, latency: null, connCount: 0 }));
                this.proxmoxHosts = rawProxmox.map(h => ({ ...h, online: false, latency: null, connCount: 0 }));
                
                // No more initial checkAllHealth here. SSE 'full_state' will handle it.
                // But we might want to show something initially.
                // The initSSE() is called after loadData().
                
            } catch (e) {
                console.error('Error loading data', e);
                this.loadingMessage = 'Error loading data!';
            }
        },

        // Removed checkAllHealth and its polling logic.
        // Refresh now just re-initializes SSE or requests a full update if we had an endpoint for it.
        // For now, let's make refresh just reload the page or reconnect SSE.
        refresh() {
            this.playClick();
            this.resetDroppedServers();
            this.showStatusMsg('Refreshing connection...', 'info');
            this.initSSE();
            setTimeout(() => this.showStatusMsg('Refresh complete!', 'success'), 1000);
        },

        handleDropHotkey(event) {
            if (this.page === 'main' || this.showOptions || this.showQuit || this.tipsOpen) return;
            if (this.page !== 'terminal' && this.page !== 'proxmox') return;
            event.preventDefault();
            this.removeNextServer();
        },

        removeNextServer() {
            const list = this.page === 'terminal' ? this.devices : this.proxmoxHosts;
            const hidden = this.page === 'terminal' ? this.hiddenTerminalIps : this.hiddenProxmoxIps;
            const nextItem = list.find(item => !hidden.includes(item.ip));
            if (!nextItem) {
                this.showStatusMsg('No more servers to drop', 'info');
                return;
            }
            hidden.push(nextItem.ip);
            this.playDrop();
        },

        resetDroppedServers() {
            this.hiddenTerminalIps = [];
            this.hiddenProxmoxIps = [];
        },

        // --- Navigation & UI ---
        navigate(target) {
            this.playClick();
            if (target === 'main') {
                this.resetDroppedServers();
            }
            this.page = target;
            this.showOptions = false;
            this.showQuit = false;
        },

        openOptions() {
            this.playClick();
            this.showOptions = true;
        },

        closeOptions() {
            this.playClick();
            this.showOptions = false;
        },

        openQuit() {
            this.playClick();
            this.showQuit = true;
        },

        closeQuit() {
            this.playClick();
            this.showQuit = false;
        },

        // --- Actions ---
        openSSH(ip) {
            this.playClick();
            
            // Check if device is Telnet-only
            const device = this.devices.find(d => d.ip === ip);
            if (device && device.protocol === 'telnet') {
                this.openTips(ip);
                this.showStatusMsg('This device requires Telnet', 'info');
                return;
            }

            this.portalActive = true;
            if(this.netherSound) {
                this.netherSound.currentTime = 0;
                this.netherSound.play().catch(() => {});
            }
            
            setTimeout(() => {
                try {
                    window.location.href = `ssh://cisco@${ip}`;
                } catch (e) {
                    this.showStatusMsg('SSH handler not available', 'error');
                }
                setTimeout(() => { this.portalActive = false; }, 500);
            }, 1000);
        },

        openProxmox(ip) {
            this.playClick();
            this.portalActive = true;
            if(this.netherSound) {
                this.netherSound.currentTime = 0;
                this.netherSound.play().catch(() => {});
            }

            setTimeout(() => {
                window.open(`https://${ip}:8006/`, '_blank', 'noopener');
                setTimeout(() => { this.portalActive = false; }, 500);
            }, 1000);
        },

        openTips(ip) {
            this.playClick();
            this.activeTipIp = ip;
            this.sshCmd = `ssh cisco@${ip} -o KexAlgorithms=+diffie-hellman-group1-sha1 -o HostKeyAlgorithms=+ssh-rsa -c aes128-cbc`;
            this.telnetCmd = `telnet ${ip}`;
            this.tipsOpen = true;
        },

        closeTips() {
            if (this.tipsOpen) {
                this.playClick();
                this.tipsOpen = false;
                this.activeTipIp = null;
            }
        },

        async copyToClipboard(text, type) {
            this.playClick();
            try {
                await navigator.clipboard.writeText(text);
                this.showStatusMsg(`${type} command copied`, 'success');
            } catch {
                this.showStatusMsg('Copy failed', 'error');
            }
        },

        showStatusMsg(msg, type) {
            this.statusMessage = msg;
            this.statusType = type;
            setTimeout(() => {
                this.statusMessage = '';
            }, 3000);
        },

        visibleDevices() {
            return this.devices.filter(device => !this.hiddenTerminalIps.includes(device.ip));
        },

        visibleProxmox() {
            return this.proxmoxHosts.filter(host => !this.hiddenProxmoxIps.includes(host.ip));
        },

        // --- Helpers ---
        getPingImage(latency) {
            if (latency === null || latency === undefined) return 'img/ping/ping-5.png';
            let idx = 1;
            if (latency >= 200) idx = 5;
            else if (latency >= 150) idx = 4;
            else if (latency >= 100) idx = 3;
            else if (latency >= 50) idx = 2;
            return `img/ping/ping-${idx}.png`;
        },
        
        startScanDots() {
            const states = ['O o O', 'o O o'];
            let idx = 0;
            this.scanTimer = setInterval(() => {
                idx = (idx + 1) % states.length;
                this.scanDots = states[idx];
            }, 500);
        },

        // --- SSE ---
        initSSE() {
            if (this.sseSource) this.sseSource.close();
            
            try {
                this.sseSource = new EventSource('/events');
                
                this.sseSource.onopen = () => {
                    console.log('✅ SSE Connected');
                };
                
                this.sseSource.onmessage = (event) => {
                    try {
                        const msg = JSON.parse(event.data);
                        
                        // Handle different message types
                        if (msg.type === 'full_state') {
                            // Initial load or full refresh
                            this.updateDevices(msg.data.devices);
                            this.updateProxmox(msg.data.proxmox);
                            this.loading = false;
                            this.loadingMessage = 'System Online';
                        } else if (msg.type === 'device_update') {
                            // Single device update
                            const device = this.devices.find(d => d.ip === msg.data.ip);
                            if (device) {
                                Object.assign(device, msg.data);
                            }
                        } else if (msg.type === 'proxmox_update') {
                            // Single proxmox host update
                            const host = this.proxmoxHosts.find(h => h.ip === msg.data.ip);
                            if (host) {
                                Object.assign(host, msg.data);
                            }
                        } else if (msg.type === 'timeout') {
                            // Timeout Alert
                            if (msg.data.shouldPlay && !this.timeoutPlayed) {
                                console.log('🔔 Timeout Alert!');
                                if(this.timeoutSound) {
                                    // Mute background music while timeout sound plays
                                    if (this.bgMusic) {
                                        this.bgMusic.volume = 0;
                                    }
                                    this.timeoutSound.currentTime = 0;
                                    this.timeoutSound.play().catch(e => console.error(e));
                                }
                                this.timeoutPlayed = true;
                                setTimeout(() => { this.timeoutPlayed = false; }, 120000);
                            }
                        }
                    } catch (e) {
                        console.error('Error parsing SSE message:', e);
                    }
                };
                
                this.sseSource.onerror = () => {
                    this.sseSource.close();
                    setTimeout(() => this.initSSE(), 3000);
                };
            } catch (e) {
                setTimeout(() => this.initSSE(), 3000);
            }
        },

        updateDevices(newDevices) {
            // Merge or replace. Since we want to keep the array reference for Alpine, we update in place or push.
            // But 'devices' is initialized from config.json. The SSE sends full state objects.
            // We should match by IP.
            newDevices.forEach(newState => {
                const device = this.devices.find(d => d.ip === newState.ip);
                if (device) {
                    Object.assign(device, newState);
                }
            });
        },

        updateProxmox(newHosts) {
            newHosts.forEach(newState => {
                const host = this.proxmoxHosts.find(h => h.ip === newState.ip);
                if (host) {
                    Object.assign(host, newState);
                }
            });
        },

        async initSnow() {
            const now = new Date();
            if (now.getMonth() === 11) {
                let textureNames = ['snow-1.png', 'snow-2.png'];
                try {
                    const res = await fetch('/snow-textures');
                    const list = await res.json();
                    if (list && list.length > 0) {
                        textureNames = list;
                    }
                } catch (e) {
                    console.error('Failed to load snow textures', e);
                }

                // Preload images
                this.snowImages = await Promise.all(textureNames.map(name => {
                    return new Promise((resolve) => {
                        const img = new Image();
                        img.src = `img/snow/${name}`;
                        img.onload = () => resolve(img);
                        img.onerror = () => resolve(null); // Skip broken images
                    });
                })).then(imgs => imgs.filter(img => img !== null));

                // Mouse tracking
                window.addEventListener('mousemove', (e) => {
                    this.mouseX = e.clientX;
                    this.mouseY = e.clientY;
                });

                // Resize listener
                window.addEventListener('resize', () => {
                    this.snowLayers.forEach(layer => {
                        layer.canvas.width = window.innerWidth;
                        layer.canvas.height = window.innerHeight;
                    });
                });

                this.updateSnowDensity(this.snowDensity);
                this.startSnowAnimation();
            }
        },

        startSnowAnimation() {
            const animate = () => {
                this.updateParticles();
                this.animationFrameId = requestAnimationFrame(animate);
            };
            this.animationFrameId = requestAnimationFrame(animate);
        },

        updateParticles() {
            const width = window.innerWidth;
            const height = window.innerHeight;
            
            this.snowLayers.forEach(layer => {
                const ctx = layer.ctx;
                ctx.clearRect(0, 0, width, height);

                layer.particles.forEach(p => {
                    // Gravity
                    p.y += p.speed;
                    
                    // Sway
                    p.swayOffset += p.swaySpeed;
                    let dx = Math.sin(p.swayOffset) * 1.2; // Increased sway amplitude for floating effect
                    
                    // Mouse Interaction
                    const distX = p.x - this.mouseX;
                    const distY = p.y - this.mouseY;
                    const dist = Math.sqrt(distX * distX + distY * distY);
                    const minDist = 150; 
                    
                    if (dist < minDist) {
                        const force = (minDist - dist) / minDist;
                        const angle = Math.atan2(distY, distX);
                        const pushX = Math.cos(angle) * force * 5;
                        const pushY = Math.sin(angle) * force * 5;
                        
                        p.x += pushX;
                        p.y += pushY;
                    }

                    p.x += dx;

                    // Wrap around
                    if (p.y > height + 20) {
                        p.y = -20;
                        p.x = Math.random() * width;
                    }
                    if (p.x > width + 20) p.x = -20;
                    if (p.x < -20) p.x = width + 20;

                    // Draw
                    if (p.img) {
                        ctx.drawImage(p.img, p.x, p.y, p.size, p.size);
                    }
                });
            });
        },

        updateSnowDensity(density) {
            const now = new Date();
            if (now.getMonth() !== 11) return;

            this.snowLayers = []; // Reset layers
            this.createSnowLayer('snowContainerBack', density);
            this.createSnowLayer('snowContainerFront', density);
        },

        createSnowLayer(containerId, count) {
            const container = document.getElementById(containerId);
            if (!container) return;
            
            container.style.display = 'block';
            container.innerHTML = ''; // Clear previous

            const canvas = document.createElement('canvas');
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            canvas.style.display = 'block';
            container.appendChild(canvas);

            const ctx = canvas.getContext('2d');
            const particles = [];

            for (let i = 0; i < count; i++) {
                particles.push({
                    x: Math.random() * window.innerWidth,
                    y: Math.random() * window.innerHeight,
                    speed: Math.random() * 0.15 + 0.05, // Very slow speed (0.05 - 0.2)
                    swayOffset: Math.random() * Math.PI * 2,
                    swaySpeed: 0.001 + Math.random() * 0.004, // Very gentle sway
                    size: Math.random() * 12 + 8,
                    img: this.snowImages[Math.floor(Math.random() * this.snowImages.length)]
                });
            }

            this.snowLayers.push({
                id: containerId,
                canvas: canvas,
                ctx: ctx,
                particles: particles
            });
        }
    }));
});
