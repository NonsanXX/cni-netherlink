document.addEventListener('alpine:init', () => {
    Alpine.data('netherlinkApp', () => ({
        // State
        page: 'main', // 'main', 'terminal', 'proxmox'
        splashText: 'CNI 2025/2!',
        devices: [],
        proxmoxHosts: [],
        
        // Loading State
        loading: true,
        loadingMessage: 'Building Terrain',
        loadingProgress: 0,
        
        // Audio State
        soundVolume: 100,
        musicVolume: 100,
        musicStarted: false,
        
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
        
        // Timers & SSE
        healthTimer: null,
        scanTimer: null,
        sseSource: null,
        timeoutPlayed: false,

        async init() {
            this.initAudio();
            this.startScanDots();
            await this.loadSplash();
            await this.loadData();
            this.initSSE();
            
            // Watch for volume changes
            this.$watch('soundVolume', val => this.updateSoundVolume(val));
            this.$watch('musicVolume', val => this.updateMusicVolume(val));
            
            // Global keyboard listener for Escape
            window.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') this.closeTips();
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
            this.netherSound = document.getElementById('netherSound');
            
            // Set initial volumes
            this.updateSoundVolume(this.soundVolume);
            this.updateMusicVolume(this.musicVolume);
            
            // Play music on first interaction
            const startMusic = () => {
                if (!this.musicStarted) {
                    this.bgMusic.play().catch(() => {});
                    this.musicStarted = true;
                }
            };
            document.addEventListener('click', startMusic, { once: true });
        },

        updateSoundVolume(val) {
            const vol = val / 100;
            if(this.clickSound) this.clickSound.volume = vol;
            if(this.timeoutSound) this.timeoutSound.volume = vol;
            if(this.netherSound) this.netherSound.volume = vol;
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
            this.showStatusMsg('Refreshing connection...', 'info');
            this.initSSE();
            setTimeout(() => this.showStatusMsg('Refresh complete!', 'success'), 1000);
        },

        // --- Navigation & UI ---
        navigate(target) {
            this.playClick();
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
        }
    }));
});
