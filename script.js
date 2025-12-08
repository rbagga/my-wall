// App state and configuration
// CONFIG is loaded from config.js

class WallApp {
    constructor() {
        this.entries = [];
        this.isAuthenticated = false;
        this.dom = {};
        this.currentWall = 'rishu'; // view context: 'rishu', 'friend', 'tech', 'songs', 'ideas', or 'drafts'
        this.walls = [];
        this.selectedWall = null; // { id, slug, name }
        this.entriesCache = { rishu: null, friend: null, tech: null, songs: null, ideas: null, drafts: null };
        this.series = [];
        this.seriesLoaded = false;
        this.seriesItemsCache = new Map(); // key: seriesId -> items array
        this.spotifyCache = new Map();
        this.spotifyEmbedCache = new Map();
        this.videoMetaCache = new Map(); // url -> { title, thumbnail_url }
        this._dragImg = null; // legacy HTML5 DnD ghost suppressor (no longer used)
        this._mouseDrag = { active: false, el: null };
        this._dragIntent = null; // pending drag start info (click-vs-drag threshold)
        this._suppressClickUntil = 0; // timestamp to ignore click right after a drag
        this._modalContext = null; // tracks which modal is open (e.g., 'new-entry')
        this._activeForm = null; // reference to the active modal form, if any
        this.isHome = false;

        this.init();
    }

    isVideoWall() {
        const slug = (this.selectedWall && this.selectedWall.slug) ? String(this.selectedWall.slug).toLowerCase() : '';
        const name = (this.selectedWall && this.selectedWall.name) ? String(this.selectedWall.name).toLowerCase() : '';
        if (!slug && !name) return false;
        // Enable for a specific wall or any wall containing "video" in name
        return slug === 'enlightening-videos' || name.includes('video');
    }

    extractFirstUrl(text) {
        if (!text) return null;
        const re = /https?:\/\/[^\s<]+/i;
        const m = String(text).match(re);
        return m ? m[0] : null;
    }

    async fetchVideoMeta(url) {
        try {
            const u = String(url || '').trim();
            if (!u) return null;
            if (this.videoMetaCache.has(u)) return this.videoMetaCache.get(u);
            let endpoint = null;
            const lower = u.toLowerCase();
            if (lower.includes('youtube.com') || lower.includes('youtu.be')) {
                endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(u)}&format=json`;
            } else if (lower.includes('vimeo.com')) {
                endpoint = `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(u)}`;
            } else if (lower.includes('dailymotion.com') || lower.includes('dai.ly')) {
                endpoint = `https://www.dailymotion.com/services/oembed?url=${encodeURIComponent(u)}`;
            }
            let meta = null;
            if (endpoint) {
                try {
                    const resp = await fetch(endpoint);
                    const data = await resp.json().catch(() => ({}));
                    meta = { title: data.title || '', thumbnail_url: data.thumbnail_url || data.thumbnail_url_with_play_button || '' };
                } catch (_) {
                    meta = null;
                }
            }
            // Fallback: derive title from URL
            if (!meta) {
                const t = u.replace(/^https?:\/\/([^/]+).*/, '$1');
                meta = { title: t, thumbnail_url: '' };
            }
            this.videoMetaCache.set(u, meta);
            return meta;
        } catch (_) {
            return null;
        }
    }

    extractVideoInfo(url) {
        try {
            const u = new URL(url);
            const host = u.hostname.toLowerCase();
            // YouTube
            if (host.includes('youtube.com')) {
                // Handle watch?v=ID
                let id = u.searchParams.get('v');
                // Handle /embed/ID
                if (!id && /\/embed\//.test(u.pathname)) {
                    id = u.pathname.split('/').filter(Boolean).pop();
                }
                if (id) return { provider: 'youtube', id };
            } else if (host === 'youtu.be') {
                const id = u.pathname.replace(/^\//, '');
                if (id) return { provider: 'youtube', id };
            }
            // Vimeo
            if (host.includes('vimeo.com')) {
                const parts = u.pathname.split('/').filter(Boolean);
                const id = parts[0];
                if (id && /^\d+$/.test(id)) return { provider: 'vimeo', id };
            }
            // Dailymotion
            if (host.includes('dailymotion.com')) {
                const parts = u.pathname.split('/').filter(Boolean);
                const i = parts.indexOf('video');
                if (i !== -1 && parts[i+1]) return { provider: 'dailymotion', id: parts[i+1] };
            }
            if (host === 'dai.ly') {
                const id = u.pathname.replace(/^\//, '');
                if (id) return { provider: 'dailymotion', id };
            }
        } catch (_) {}
        return { provider: null, id: null };
    }

    getVideoEmbedSrc(url) {
        const info = this.extractVideoInfo(url);
        if (info.provider === 'youtube' && info.id) return `https://www.youtube.com/embed/${encodeURIComponent(info.id)}`;
        if (info.provider === 'vimeo' && info.id) return `https://player.vimeo.com/video/${encodeURIComponent(info.id)}`;
        if (info.provider === 'dailymotion' && info.id) return `https://www.dailymotion.com/embed/video/${encodeURIComponent(info.id)}`;
        return null;
    }

    showVideoModal(entry) {
        // Defensive: ensure home overlay is not visible
        this.hideHome();
        const url = this.extractFirstUrl(entry && entry.text ? entry.text : '');
        if (!url) { this.showEntry(entry); return; }
        const wrap = document.createElement('div');
        wrap.className = 'entry-form';
        const titleText = (entry && entry.title && entry.title.trim()) ? entry.title.trim() : 'Video';
        const embedSrc = this.getVideoEmbedSrc(url);
        const openA = `<a href="${this.escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open on provider</a>`;
        wrap.innerHTML = `
            <h3>${this.escapeHtml(titleText)}</h3>
            <div class="video-frame">${embedSrc ? `<iframe src="${this.escapeHtml(embedSrc)}" allowfullscreen loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>` : ''}</div>
            <div class="video-meta">${openA}</div>
            <div class="modal-actions"><div></div><div class="actions-center"></div><div class="actions-right"></div></div>
        `;
        this.dom.modalBody.innerHTML = '';
        this.dom.modalBody.appendChild(wrap);
        this._modalContext = 'video-view';
        this._activeForm = null;
        this.openModal();
        // Add share button (center)
        const actionsCenter = this.dom.modalBody.querySelector('.modal-actions .actions-center');
        if (actionsCenter && entry && entry.id) {
            const shareBtn = document.createElement('button');
            shareBtn.type = 'button';
            shareBtn.className = 'icon-btn btn-liquid clear';
            shareBtn.title = 'Share link';
            shareBtn.setAttribute('aria-label', 'Share link');
            shareBtn.innerHTML = `
                <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                  <path d="M12 13V6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
                  <path d="M9 9l3-3 3 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
                  <rect x="5" y="14" width="14" height="5" rx="2.5" ry="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/>
                </svg>`;
            shareBtn.addEventListener('click', async () => {
                this.showShareLoading();
                try {
                    // rishu wall entries use entryId shortener; videos live on rishu wall
                    const { shortUrl } = await this.createShortLink(entry.id, 'rishu');
                    this.showShareModal(shortUrl);
                } catch (e) {
                    const msg = String(e && e.message) || '';
                    if (/Short links require DB migration/i.test(msg)) this.showShareError('Short links require DB migration. Please run supabase db push.');
                    else if (/External shortener failed/i.test(msg)) this.showShareError('Short-link service unavailable. Please try again.');
                    else this.showShareError('Failed to create link. Please try again.');
                }
            });
            actionsCenter.appendChild(shareBtn);
        }
        // If title missing, try to update it after oEmbed
        if (!entry.title || !entry.title.trim()) {
            this.fetchVideoMeta(url).then(meta => {
                if (meta && meta.title) {
                    const h3 = this.dom.modalBody.querySelector('h3');
                    if (h3) h3.textContent = meta.title;
                }
            }).catch(()=>{});
        }
    }

    init() {
        // Cache DOM elements
        this.dom.wall = document.getElementById('wall');
        this.dom.modal = document.getElementById('modal');
        this.dom.modalBody = document.getElementById('modalBody');
        this.dom.addButton = document.getElementById('addButton');
        this.dom.closeBtn = document.getElementById('closeBtn');
        this.dom.darkModeToggle = document.getElementById('darkModeToggle');
        this.dom.toggleWallButton = document.getElementById('toggleWallButton');
        this.dom.wallsNav = document.getElementById('wallsNav');
        this.dom.addWallButton = document.getElementById('addWallButton');
        this.dom.wallTitle = document.getElementById('wallTitle');
        this.dom.homeButton = document.getElementById('homeButton');
        this.dom.homeView = document.getElementById('homeView');
        this.dom.bubbles = document.getElementById('bubbles');
        this.dom.loginButton = document.getElementById('loginButton');
        this.dom.header = document.querySelector('.header');
        this.dom.draftsButton = document.getElementById('draftsButton');
        this.dom.techButton = document.getElementById('techButton');
        this.dom.songsButton = document.getElementById('songsButton');
        this.dom.ideasButton = document.getElementById('ideasButton');
        // no organize button in UI

        // Load data
        this.loadAuthState();
        this.loadSelectedWallState();
        this.updateAuthUI();

        // Set up event listeners
        this.setupEventListeners();

        // Setup routing and render based on current hash
        this.setupRouting();
        if (!location.hash || location.hash === '#home') {
            this.showHome();
        } else {
            this.applyWallFromHash();
        }

        // Apply dark mode if enabled
        this.applyDarkMode();

        // Prepare transparent drag image (kept for compatibility but not used now)
        this._dragImg = this.createTransparentDragImage();

        // Load walls list (non-blocking)
        this.fetchWalls().then(() => {
            if (!this.selectedWall) this.selectInitialWall();
            this.updateWallTitle();
            this.renderWallButtons();
            // Do not auto-load entries while showing home
            if (!this.isHome && this.currentWall === 'rishu') { this.entriesCache.rishu = null; this.loadEntries(); }
        }).catch(() => {
            this.updateWallTitle();
            this.renderWallButtons();
        });
    }

    showLoading() {
        this.dom.wall.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    }

    showEmptyState() {
        const msg = (
            this.currentWall === 'friend' ? "No friend entries yet." :
            this.currentWall === 'tech' ? "No tech notes yet." :
            this.currentWall === 'songs' ? "No song quotes yet." :
            this.currentWall === 'ideas' ? "No project ideas yet." :
            this.currentWall === 'drafts' ? "No drafts yet." :
            "No notes yet."
        );
        this.dom.wall.innerHTML = `<div class="empty-state">${this.escapeHtml(msg)}</div>`;
    }

    loadAuthState() {
        const auth = localStorage.getItem(CONFIG.STORAGE_KEYS.AUTH);
        const pwd = localStorage.getItem(CONFIG.STORAGE_KEYS.PASSWORD);
        this.isAuthenticated = auth === 'true' && !!pwd;
        this.tempPassword = this.isAuthenticated ? pwd : null;
    }

    loadSelectedWallState() {
        const id = localStorage.getItem(CONFIG.STORAGE_KEYS.SELECTED_WALL_ID);
        const slug = localStorage.getItem(CONFIG.STORAGE_KEYS.SELECTED_WALL_SLUG);
        const name = localStorage.getItem(CONFIG.STORAGE_KEYS.SELECTED_WALL_NAME);
        if (id && name) this.selectedWall = { id, slug: slug || null, name };
    }

    saveSelectedWallState() {
        if (this.selectedWall) {
            localStorage.setItem(CONFIG.STORAGE_KEYS.SELECTED_WALL_ID, String(this.selectedWall.id));
            localStorage.setItem(CONFIG.STORAGE_KEYS.SELECTED_WALL_SLUG, this.selectedWall.slug || '');
            localStorage.setItem(CONFIG.STORAGE_KEYS.SELECTED_WALL_NAME, this.selectedWall.name || '');
        } else {
            localStorage.removeItem(CONFIG.STORAGE_KEYS.SELECTED_WALL_ID);
            localStorage.removeItem(CONFIG.STORAGE_KEYS.SELECTED_WALL_SLUG);
            localStorage.removeItem(CONFIG.STORAGE_KEYS.SELECTED_WALL_NAME);
        }
    }

    updateAuthUI() {
        if (this.dom && this.dom.draftsButton) {
            const onDrafts = this.currentWall === 'drafts';
            // Only show on home? Per new UX, hide wall-switch buttons on wall views
            const allowed = this.isHome;
            this.dom.draftsButton.style.display = (this.isAuthenticated && !onDrafts && allowed) ? 'inline-block' : 'none';
        }
        if (this.dom && this.dom.ideasButton) {
            const onIdeas = this.currentWall === 'ideas';
            const allowed = this.isHome;
            this.dom.ideasButton.style.display = (this.isAuthenticated && !onIdeas && allowed) ? 'inline-block' : 'none';
        }
        if (this.dom && this.dom.addWallButton) {
            // Only on home
            this.dom.addWallButton.style.display = (this.isHome && this.isAuthenticated) ? 'inline-block' : 'none';
        }
        if (this.dom && this.dom.loginButton) {
            this.dom.loginButton.textContent = this.isAuthenticated ? 'logout' : 'login';
        }
        // Hide switching controls on wall views
        if (!this.isHome) {
            if (this.dom && this.dom.wallsNav) this.dom.wallsNav.style.display = 'none';
            if (this.dom && this.dom.toggleWallButton) this.dom.toggleWallButton.style.display = 'none';
            if (this.dom && this.dom.techButton) this.dom.techButton.style.display = 'none';
            if (this.dom && this.dom.songsButton) this.dom.songsButton.style.display = 'none';
            if (this.dom && this.dom.ideasButton) this.dom.ideasButton.style.display = 'none';
            if (this.dom && this.dom.draftsButton) this.dom.draftsButton.style.display = 'none';
            if (this.dom && this.dom.addWallButton) this.dom.addWallButton.style.display = 'none';
            if (this.dom && this.dom.loginButton) this.dom.loginButton.style.display = 'none';
        }
    }

    saveAuthState() {
        localStorage.setItem(CONFIG.STORAGE_KEYS.AUTH, this.isAuthenticated ? 'true' : 'false');
        if (this.isAuthenticated && this.tempPassword) {
            localStorage.setItem(CONFIG.STORAGE_KEYS.PASSWORD, this.tempPassword);
        } else {
            localStorage.removeItem(CONFIG.STORAGE_KEYS.PASSWORD);
        }
    }

    async loadEntries() {
        const wallKey = this.currentWall;

        // If we have cached entries, render them immediately; otherwise show loader
        const cached = this.entriesCache[wallKey];
        if (Array.isArray(cached)) {
            this.entries = cached;
            this.renderEntries();
        } else {
            this.showLoading();
        }

        try {
            if (wallKey === 'drafts') {
                // Auth-only drafts list
                const response = await fetch('/api/drafts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: this.tempPassword, wall_id: (this.selectedWall && this.selectedWall.id) ? this.selectedWall.id : undefined })
                });
                const result = await response.json().catch(() => ({}));
                if (!response.ok) {
                    if (response.status === 401) {
                        // Prompt for password then retry
                        await this.promptForPassword().catch(() => {});
                        // If still not authenticated, stop here
                        if (!this.isAuthenticated) return;
                        // retry once
                        this.entriesCache.drafts = null;
                        return this.loadEntries();
                    }
                    throw new Error(result.error || 'Failed to load drafts');
                }
                const fresh = result.data || [];
                this.entriesCache.drafts = fresh;
                this.entries = fresh;
                this.renderEntries();
                if (this._pendingEntryId) this.openPendingEntry();
                return;
            }

            // Auth-only ideas list (not public)
            if (wallKey === 'ideas') {
                const response = await fetch('/api/project-ideas', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: this.tempPassword })
                });
                const result = await response.json().catch(() => ({}));
                if (!response.ok) {
                    if (response.status === 401) {
                        await this.promptForPassword().catch(() => {});
                        if (!this.isAuthenticated) return;
                        this.entriesCache.ideas = null;
                        return this.loadEntries();
                    }
                    throw new Error(result.error || 'Failed to load ideas');
                }
                const fresh = result.data || [];
                this.entriesCache.ideas = fresh;
                this.entries = fresh;
                this.renderEntries();
                if (this._pendingEntryId) this.openPendingEntry();
                return;
            }

            let endpoint = '/api/entries';
            if (wallKey === 'friend') endpoint = '/api/friend-entries';
            else if (wallKey === 'tech') endpoint = '/api/tech-notes';
            else if (wallKey === 'songs') endpoint = '/api/song-quotes';
            const url = new URL(endpoint, location.origin);
            if (wallKey === 'rishu' && this.selectedWall && this.selectedWall.id) {
                url.searchParams.set('wall_id', String(this.selectedWall.id));
                // Supply password for private walls
                if (!this.selectedWall.is_public && this.tempPassword) {
                    url.searchParams.set('password', this.tempPassword);
                }
            }
            const response = await fetch(url.toString());
            const result = await response.json();

            if (!response.ok) throw new Error(result.error);

            const fresh = result.data || [];
            this.entriesCache[wallKey] = fresh;
            this.entries = fresh;
            this.renderEntries();
            // Prefetch series items to enable duplicate filtering, then re-render
            if (this.currentWall === wallKey) {
                this.prefetchSeriesItemsForCurrentWall().then(() => {
                    // Only re-render if still on same wall
                    if (this.currentWall === wallKey) this.renderEntries();
                }).catch(() => {});
            }
            if (this._pendingEntryId) this.openPendingEntry();
        } catch (error) {
            console.error('Error loading entries:', error);
            // If we have no cache, don't keep spinner forever; show empty state
            if (!Array.isArray(this.entriesCache[this.currentWall])) {
                this.showEmptyState();
            }
        }
    }

    async saveEntry(text, password, visibility = 'public', title = null) {
        try {
            const response = await fetch('/api/entries', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    text: text,
                    password: password,
                    visibility,
                    title: (typeof title === 'string' && title.trim() && title.trim() !== '(optional)') ? title.trim() : undefined,
                    wall_id: (this.selectedWall && this.selectedWall.id) ? this.selectedWall.id : undefined
                })
            });

            const result = await response.json();

            if (!response.ok) throw new Error(result.error);

            return result.data;
        } catch (error) {
            console.error('Error saving entry:', error);
            throw error;
        }
    }

    setupEventListeners() {
        // Add button click
        this.dom.addButton.addEventListener('click', () => this.handleAddButtonClick());

        // Close button click (explicit close: do NOT autosave)
        this.dom.closeBtn.addEventListener('click', () => this.closeModal());

        // Click outside modal (backdrop) — may autosave depending on context
        this.dom.modal.addEventListener('click', (e) => {
            if (e.target === this.dom.modal) {
                this.handleModalBackdropClick();
            }
        });

        // Dark mode toggle
        this.dom.darkModeToggle.addEventListener('change', () => this.toggleDarkMode());

        // Toggle wall button
        this.dom.toggleWallButton.addEventListener('click', () => this.toggleWall());

        // Add wall button
        if (this.dom.addWallButton) {
            this.dom.addWallButton.addEventListener('click', () => this.handleAddWallClick());
        }
        if (this.dom.homeButton) {
            this.dom.homeButton.addEventListener('click', () => {
                location.hash = '#home';
            });
        }
        if (this.dom.loginButton) {
            this.dom.loginButton.addEventListener('click', () => this.handleLoginClick());
        }

        // Drafts button (shown only when authenticated)
        if (this.dom.draftsButton) {
            this.dom.draftsButton.addEventListener('click', () => {
                if (!this.isAuthenticated) {
                    this.showPasswordForm();
                    return;
                }
                location.hash = '#drafts';
            });
        }

        // Tech notes button (always visible)
        if (this.dom.techButton) {
            this.dom.techButton.addEventListener('click', () => {
                location.hash = '#tech';
            });
        }

        // Song quotes button (always visible)
        if (this.dom.songsButton) {
            this.dom.songsButton.addEventListener('click', () => {
                location.hash = '#songs';
            });
        }

        // Project ideas button (auth-only)
        if (this.dom.ideasButton) {
            this.dom.ideasButton.addEventListener('click', () => {
                if (!this.isAuthenticated) {
                    this.showPasswordForm();
                    return;
                }
                location.hash = '#ideas';
            });
        }

        // Drag-and-drop listeners (auth-gated in handlers)
        this.dom.wall.addEventListener('dragover', (e) => this.onDragOver(e));
        this.dom.wall.addEventListener('drop', (e) => this.onDrop(e));

        // Global click to dismiss custom context menu
        document.addEventListener('click', (e) => {
            const menu = document.getElementById('entryContextMenu');
            if (menu && !menu.contains(e.target)) menu.remove();
        });

        // Title context menu for wall actions (right-click)
        this.dom.wallTitle.addEventListener('contextmenu', (e) => {
            try { e.preventDefault(); } catch(_) {}
            try { e.stopPropagation(); } catch(_) {}
            const canDelete = !!(this.isAuthenticated && this.currentWall === 'rishu' && this.selectedWall && (String((this.selectedWall.slug || '')).toLowerCase() !== 'rishu'));
            this.showWallTitleContextMenu(e.clientX, e.clientY, canDelete);
        }, { capture: true });
    }

    updateWallTitle() {
        if (this.currentWall !== 'rishu') return;
        const sel = this.selectedWall;
        if (!sel) {
            this.dom.wallTitle.textContent = "rishu's wall";
            this.dom.wallTitle.style.cursor = '';
            this.dom.wallTitle.removeAttribute('title');
            return;
        }
        const slug = (sel.slug || '').toLowerCase();
        const name = (sel.name || '').trim();
        if (slug === 'rishu' || name.toLowerCase() === 'rishu') {
            this.dom.wallTitle.textContent = "rishu's wall";
            this.dom.wallTitle.style.cursor = '';
            this.dom.wallTitle.removeAttribute('title');
        } else {
            this.dom.wallTitle.textContent = name || "rishu's wall";
            // Keep default cursor; deletion is via right-click context menu only
            this.dom.wallTitle.style.cursor = '';
            this.dom.wallTitle.removeAttribute('title');
        }
    }

    selectInitialWall() {
        if (this.walls && this.walls.length) {
            const def = this.walls.find(w => (String(w.slug || '')).toLowerCase() === 'rishu') || this.walls[0];
            this.selectedWall = { id: def.id, slug: def.slug, name: def.name, is_public: !!def.is_public };
            this.saveSelectedWallState();
        }
    }

    async fetchWalls() {
        try {
            const url = new URL('/api/walls', location.origin);
            if (this.isAuthenticated && this.tempPassword) url.searchParams.set('password', this.tempPassword);
            const resp = await fetch(url.toString());
            const result = await resp.json().catch(() => ({}));
            if (resp.ok) {
                this.walls = Array.isArray(result.data) ? result.data : [];
                if (this.selectedWall && this.walls.length) {
                    const found = this.walls.find(w => String(w.id) === String(this.selectedWall.id));
                    if (found) this.selectedWall = { id: found.id, slug: found.slug, name: found.name, is_public: !!found.is_public };
                    this.saveSelectedWallState();
                }
            } else {
                this.walls = [];
            }
        } catch (_) {
            this.walls = [];
        }
    }

    renderWallButtons() {
        if (!this.dom.wallsNav) return;
        const wrap = this.dom.wallsNav;
        wrap.innerHTML = '';
        const list = (Array.isArray(this.walls) ? this.walls : []).filter(w => w && (w.is_public || this.isAuthenticated));
        list.forEach(w => {
            const btn = document.createElement('button');
            btn.className = 'toggle-wall-button btn-liquid clear';
            btn.type = 'button';
            const isRishu = String((w.slug || '').toLowerCase()) === 'rishu' || String((w.name || '').toLowerCase()) === 'rishu';
            btn.textContent = isRishu ? "rishu's wall" : w.name;
            if (this.selectedWall && String(this.selectedWall.id) === String(w.id)) {
                btn.classList.add('active');
            }
            btn.addEventListener('click', () => {
                if (!w.is_public && !this.isAuthenticated) { this.showPasswordForm(); return; }
                this.selectedWall = { id: w.id, slug: w.slug, name: w.name, is_public: w.is_public };
                this.saveSelectedWallState();
                this.updateWallTitle();
                this.entriesCache.rishu = null;
                this.entriesCache.drafts = null;
                this.renderWallButtons();
                if (this.currentWall !== 'rishu') {
                    location.hash = '#';
                } else {
                    this.loadEntries();
                }
            });
            wrap.appendChild(btn);
        });
    }

    async handleAddWallClick() {
        if (!this.isAuthenticated) { this.showPasswordForm(); return; }
        this.showCreateWallModal();
    }

    showCreateWallModal() {
        const form = document.createElement('form');
        form.className = 'entry-form';
        form.innerHTML = `
            <h3>Create Wall</h3>
            <input type="text" id="wallName" placeholder="Wall name" required>
            <label style="display:flex; align-items:center; gap:8px; margin:6px 0;">
                <input type="checkbox" id="wallPublic" checked>
                <span>Public (visible to everyone)</span>
            </label>
            <div style="display:flex; gap:8px; align-items:center;">
                <button type="submit" class="btn-liquid clear">Create</button>
            </div>
        `;
        this.dom.modalBody.innerHTML = '';
        this.dom.modalBody.appendChild(form);
        this._modalContext = 'create-wall';
        this._activeForm = form;

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (form.classList.contains('is-submitting')) return;
            const nameEl = form.querySelector('#wallName');
            const pubEl = form.querySelector('#wallPublic');
            const name = (nameEl.value || '').trim();
            const is_public = !!pubEl.checked;
            if (!name) { nameEl.focus(); return; }
            form.classList.add('is-submitting');
            try {
                const resp = await fetch('/api/walls', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, is_public, password: this.tempPassword })
                });
                const result = await resp.json().catch(() => ({}));
                if (!resp.ok) {
                    alert(result && result.error ? String(result.error) : 'Failed to create wall');
                    form.classList.remove('is-submitting');
                    return;
                }
                const created = result.data;
                await this.fetchWalls();
                const w = this.walls.find(x => String(x.id) === String(created.id));
                if (w) {
                    this.selectedWall = { id: w.id, slug: w.slug, name: w.name, is_public: w.is_public };
                    this.saveSelectedWallState();
                    this.renderWallButtons();
                    this.closeModal();
                    if (this.isHome) {
                        // Stay on home and refresh bubbles only
                        this.renderBubbles();
                        this.renderUtilityBubbles();
                    } else {
                        // On wall views, refresh rishu entries if applicable
                        this.updateWallTitle();
                        this.entriesCache.rishu = null;
                        this.entriesCache.drafts = null;
                        if (this.currentWall !== 'rishu') location.hash = '#';
                        else this.loadEntries();
                    }
                }
            } catch (_) {
                alert('Failed to create wall.');
            } finally {
                form.classList.remove('is-submitting');
            }
        });

        this.openModal();
        setTimeout(() => form.querySelector('#wallName')?.focus(), 50);
    }

    handleLoginClick() {
        if (this.isAuthenticated) {
            // Logout
            this.isAuthenticated = false;
            this.tempPassword = null;
            this.saveAuthState();
            this.updateAuthUI();
            // Refresh bubbles visibility (add wall button)
            if (this.isHome) this.showHome();
            return;
        }
        // Login modal (does not auto-open entry forms)
        const form = document.createElement('form');
        form.className = 'password-form';
        form.innerHTML = `
            <h3>Login</h3>
            <input type="password" id="loginPassword" placeholder="Password" required autocomplete="current-password">
            <div id="loginError" class="error"></div>
            <button type="submit" class="btn-liquid clear">Submit</button>
        `;
        this.dom.modalBody.innerHTML = '';
        this.dom.modalBody.appendChild(form);
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (form.classList.contains('is-submitting')) return;
            const input = form.querySelector('#loginPassword');
            const err = form.querySelector('#loginError');
            const pwd = (input.value || '').trim();
            if (!pwd) { input.focus(); return; }
            form.classList.add('is-submitting');
            try {
                const resp = await fetch('/api/verify-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pwd }) });
                const data = await resp.json().catch(() => ({}));
                if (!resp.ok) throw new Error(data.error || 'Invalid password');
                this.tempPassword = pwd;
                this.isAuthenticated = true;
                this.saveAuthState();
                await this.fetchWalls();
                this.updateAuthUI();
                this.closeModal();
                // Update current lists if necessary
                if (this.isHome) this.showHome(); else this.loadEntries();
            } catch (_) {
                err.textContent = 'Invalid password. Please try again.';
                input.value = '';
                input.focus();
            } finally {
                form.classList.remove('is-submitting');
            }
        });
        this.openModal();
        setTimeout(() => form.querySelector('#loginPassword')?.focus(), 50);
    }

    showVideoEntryForm() {
        const form = document.createElement('form');
        form.className = 'entry-form';
        form.innerHTML = `
            <h3>Add Video</h3>
            <input type="url" id="videoUrl" placeholder="Paste video URL (YouTube, Vimeo…)" required>
            <div style="display:flex; gap:8px; align-items:center;">
                <button type="submit" class="btn-liquid clear">Add</button>
            </div>
        `;
        this.dom.modalBody.innerHTML = '';
        this.dom.modalBody.appendChild(form);
        this._modalContext = 'video-entry';
        this._activeForm = form;

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (form.classList.contains('is-submitting')) return;
            const urlEl = form.querySelector('#videoUrl');
            const url = (urlEl.value || '').trim();
            if (!url) { urlEl.focus(); return; }
            form.classList.add('is-submitting');
            try {
                let title = null;
                try { const meta = await this.fetchVideoMeta(url); title = meta && meta.title ? meta.title : null; } catch(_) {}
                const created = await this.saveEntry(url, this.tempPassword, 'public', title);
                // Optimistically add to cache
                const cur = Array.isArray(this.entriesCache.rishu) ? this.entriesCache.rishu : [];
                this.entriesCache.rishu = [created, ...cur];
                if (this.currentWall === 'rishu') { this.entries = this.entriesCache.rishu; this.renderEntries(); }
                this.closeModal();
            } catch (err) {
                const msg = String(err && err.message) || '';
                if (msg === 'Invalid password') { this.tempPassword = null; alert('Invalid password. Please try again.'); this.closeModal(); }
                else alert('Error adding video.');
            } finally {
                form.classList.remove('is-submitting');
            }
        });

        this.openModal();
        setTimeout(() => form.querySelector('#videoUrl')?.focus(), 50);
    }

    showWallsModal() {
        const container = document.createElement('div');
        container.className = 'entry-modal';
        const list = (this.walls || []);
        const currentId = this.selectedWall ? String(this.selectedWall.id) : '';
        const items = list.map(w => {
            const sel = String(w.id) === currentId ? ' (current)' : '';
            return `<li data-id="${String(w.id)}" class="wall-item">${this.escapeHtml(w.name)}${sel}</li>`;
        }).join('');
        container.innerHTML = `
            <div class="entry">
              <div class="entry-title">Switch wall</div>
              <ul class="walls-list" style="list-style:none; padding-left:0; margin:8px 0;">
                ${items || '<li class="wall-item" data-empty="1">No walls yet</li>'}
              </ul>
              <div style="display:flex; gap:8px;">
                <input type="text" id="newWallName" placeholder="New wall name" style="flex:1;" />
                <button type="button" id="createWallBtn" class="btn-liquid clear">Create</button>
              </div>
            </div>
        `;
        this.dom.modalBody.innerHTML = '';
        this.dom.modalBody.appendChild(container);
        this._modalContext = 'walls-list';
        this._activeForm = null;

        container.querySelectorAll('.wall-item').forEach(el => {
            if (el.getAttribute('data-empty') === '1') return;
            el.style.cursor = 'pointer';
            el.addEventListener('click', () => {
                const id = el.getAttribute('data-id');
                const w = this.walls.find(x => String(x.id) === String(id));
                if (w) {
                    this.selectedWall = { id: w.id, slug: w.slug, name: w.name };
                    this.saveSelectedWallState();
                    this.updateWallTitle();
                    this.entriesCache.rishu = null;
                    this.entriesCache.drafts = null;
                    this.closeModal();
                    this.loadEntries();
                }
            });
        });

        const btn = container.querySelector('#createWallBtn');
        const input = container.querySelector('#newWallName');
        btn.addEventListener('click', async () => {
            const name = (input.value || '').trim();
            if (!name) { input.focus(); return; }
            if (!this.isAuthenticated) { this.showPasswordForm(); return; }
            try {
                const resp = await fetch('/api/walls', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, password: this.tempPassword })
                });
                const result = await resp.json().catch(() => ({}));
                if (!resp.ok) {
                    const msg = result && result.error ? String(result.error) : 'Failed to create wall';
                    alert(msg);
                    return;
                }
                const created = result.data;
                await this.fetchWalls();
                const w = this.walls.find(x => String(x.id) === String(created.id));
                if (w) {
                    this.selectedWall = { id: w.id, slug: w.slug, name: w.name };
                    this.saveSelectedWallState();
                    this.updateWallTitle();
                    this.entriesCache.rishu = null;
                    this.entriesCache.drafts = null;
                    this.closeModal();
                    this.loadEntries();
                }
            } catch (e) {
                alert('Failed to create wall.');
            }
        });

        this.openModal();
        setTimeout(() => input?.focus(), 50);
    }

    showDeleteWallConfirm() {
        const menu = document.getElementById('entryContextMenu');
        if (menu) menu.remove();

        const form = document.createElement('form');
        form.className = 'entry-form';
        const name = this.selectedWall?.name || 'this wall';
        form.innerHTML = `
            <h3>Delete Wall</h3>
            <div class="entry-text">Type \"delete me\" to confirm deleting ${this.escapeHtml(name)} and all its notes.</div>
            <div class="delete-confirm">
              <small>Confirmation</small>
              <div class="confirm-row">
                <input type="text" class="confirm-input" placeholder="delete me" />
                <button type="button" class="btn-liquid danger clear confirm-btn" disabled>Delete</button>
              </div>
            </div>
        `;
        this.dom.modalBody.innerHTML = '';
        this.dom.modalBody.appendChild(form);
        this._modalContext = 'delete-wall';
        this._activeForm = form;

        const input = form.querySelector('.confirm-input');
        const btn = form.querySelector('.confirm-btn');
        input.addEventListener('input', () => {
            btn.disabled = !(String(input.value || '').trim().toLowerCase() === 'delete me');
        });
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
                const id = this.selectedWall?.id;
                if (!id) return;
                const resp = await fetch(`/api/walls?id=${encodeURIComponent(id)}`, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: this.tempPassword })
                });
                const result = await resp.json().catch(() => ({}));
                if (!resp.ok) {
                    alert(result && result.error ? String(result.error) : 'Failed to delete wall');
                    btn.disabled = false;
                    return;
                }
                await this.fetchWalls();
                this.selectInitialWall();
                this.saveSelectedWallState();
                this.updateWallTitle();
                this.entriesCache.rishu = null;
                this.entriesCache.drafts = null;
                this.renderWallButtons();
                this.closeModal();
                if (this.currentWall !== 'rishu') location.hash = '#';
                else this.loadEntries();
            } catch (_) {
                alert('Failed to delete wall.');
                btn.disabled = false;
            }
        });

        this.openModal();
        setTimeout(() => input?.focus(), 50);
    }

    showWallTitleContextMenu(x, y, canDelete) {
        // Remove any existing context menu
        const old = document.getElementById('entryContextMenu');
        if (old) old.remove();
        const wrap = document.createElement('div');
        wrap.id = 'entryContextMenu';
        wrap.className = 'context-menu';
        wrap.style.left = x + 'px';
        wrap.style.top = y + 'px';

        if (canDelete) {
            const rename = document.createElement('div');
            rename.className = 'context-item';
            rename.textContent = 'Rename wall…';
            rename.addEventListener('click', (ev) => {
                ev.stopPropagation();
                wrap.remove();
                this.showRenameWallModal();
            });
            wrap.appendChild(rename);

            // Toggle visibility
            const isPublic = !!(this.selectedWall && this.selectedWall.is_public);
            const vis = document.createElement('div');
            vis.className = 'context-item';
            vis.textContent = isPublic ? 'Make private…' : 'Make public…';
            vis.addEventListener('click', (ev) => {
                ev.stopPropagation();
                wrap.remove();
                this.showWallVisibilityModal();
            });
            wrap.appendChild(vis);

            const del = document.createElement('div');
            del.className = 'context-item';
            del.textContent = 'Delete wall…';
            del.addEventListener('click', (ev) => {
                ev.stopPropagation();
                wrap.remove();
                this.showDeleteWallConfirm();
            });
            wrap.appendChild(del);
        } else {
            const no = document.createElement('div');
            no.className = 'context-item disabled';
            no.textContent = 'No actions available';
            wrap.appendChild(no);
        }
        document.body.appendChild(wrap);
    }

    showRenameWallModal() {
        const form = document.createElement('form');
        form.className = 'entry-form';
        const current = (this.selectedWall && this.selectedWall.name) ? this.selectedWall.name : '';
        form.innerHTML = `
            <h3>Rename Wall</h3>
            <input type="text" id="renameWallName" required value="${this.escapeHtml(current)}" />
            <div style="display:flex; gap:8px; align-items:center;">
                <button type="submit" class="btn-liquid clear">Save</button>
            </div>
        `;
        this.dom.modalBody.innerHTML = '';
        this.dom.modalBody.appendChild(form);
        this._modalContext = 'rename-wall';
        this._activeForm = form;

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (form.classList.contains('is-submitting')) return;
            const nameEl = form.querySelector('#renameWallName');
            const name = (nameEl.value || '').trim();
            if (!name) { nameEl.focus(); return; }
            form.classList.add('is-submitting');
            try {
                const id = this.selectedWall && this.selectedWall.id;
                if (!id) throw new Error('Missing wall id');
                const resp = await fetch('/api/walls', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id, name, password: this.tempPassword })
                });
                const result = await resp.json().catch(() => ({}));
                if (!resp.ok) {
                    alert(result && result.error ? String(result.error) : 'Failed to rename wall');
                    form.classList.remove('is-submitting');
                    return;
                }
                await this.fetchWalls();
                // Refresh selected wall from the updated list
                const w = this.walls.find(x => String(x.id) === String(id));
                if (w) {
                    this.selectedWall = { id: w.id, slug: w.slug, name: w.name, is_public: !!w.is_public };
                    this.saveSelectedWallState();
                }
                this.updateWallTitle();
                this.renderWallButtons();
                this.closeModal();
                if (this.currentWall === 'rishu') this.loadEntries();
            } catch (_) {
                alert('Failed to rename wall.');
            } finally {
                form.classList.remove('is-submitting');
            }
        });

        this.openModal();
        setTimeout(() => form.querySelector('#renameWallName')?.focus(), 50);
    }

    showWallVisibilityModal() {
        const form = document.createElement('form');
        form.className = 'entry-form';
        const isPublic = !!(this.selectedWall && this.selectedWall.is_public);
        form.innerHTML = `
            <h3>Wall Visibility</h3>
            <label style="display:flex; align-items:center; gap:8px;">
                <input type="checkbox" id="visPublic" ${isPublic ? 'checked' : ''}>
                <span>Public (visible to everyone)</span>
            </label>
            <div style="display:flex; gap:8px; align-items:center; margin-top:8px;">
                <button type="submit" class="btn-liquid clear">Save</button>
            </div>
        `;
        this.dom.modalBody.innerHTML = '';
        this.dom.modalBody.appendChild(form);
        this._modalContext = 'wall-visibility';
        this._activeForm = form;

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (form.classList.contains('is-submitting')) return;
            form.classList.add('is-submitting');
            try {
                const id = this.selectedWall && this.selectedWall.id;
                if (!id) throw new Error('Missing wall id');
                const is_public = !!form.querySelector('#visPublic').checked;
                const resp = await fetch('/api/walls', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id, is_public, password: this.tempPassword })
                });
                const result = await resp.json().catch(() => ({}));
                if (!resp.ok) {
                    alert(result && result.error ? String(result.error) : 'Failed to update visibility');
                    form.classList.remove('is-submitting');
                    return;
                }
                await this.fetchWalls();
                const w = this.walls.find(x => String(x.id) === String(id));
                if (w) {
                    this.selectedWall = { id: w.id, slug: w.slug, name: w.name, is_public: !!w.is_public };
                    this.saveSelectedWallState();
                }
                this.updateWallTitle();
                this.renderWallButtons();
                this.closeModal();
                if (this.currentWall === 'rishu') this.loadEntries();
            } catch (_) {
                alert('Failed to update visibility.');
            } finally {
                form.classList.remove('is-submitting');
            }
        });

        this.openModal();
    }

    setupRouting() {
        window.addEventListener('hashchange', () => {
            if (location.hash === '#home' || !location.hash) {
                this.showHome();
            } else {
                this.hideHome();
                this.applyWallFromHash();
            }
        });
    }

    parseHashParams() {
        const raw = (location.hash || '').replace(/^#/, '');
        const parts = raw.split('&');
        const params = {};
        for (const p of parts) {
            if (!p) continue;
            const [k, v] = p.split('=');
            if (!k) continue;
            params[k.toLowerCase()] = v ? decodeURIComponent(v) : '';
        }
        return params;
    }

    applyWallFromHash() {
        const hash = (location.hash || '').toLowerCase();
        if (hash === '#home' || hash === '') { this.showHome(); return; }
        // Ensure home overlay is hidden when navigating to any wall
        this.hideHome();
        const params = this.parseHashParams();
        let nextWall;
        if (hash.includes('tech')) nextWall = 'tech';
        else if (hash.includes('songs')) nextWall = 'songs';
        else if (hash.includes('ideas')) nextWall = 'ideas';
        else if (hash.includes('friend')) nextWall = 'friend';
        else if (hash.includes('draft')) nextWall = 'drafts';
        else nextWall = 'rishu';

        this.currentWall = nextWall;

        if (this.currentWall === 'friend') {
            this.dom.wallTitle.textContent = "friends' wall";
            this.dom.toggleWallButton.textContent = "rishu's wall";
        } else if (this.currentWall === 'tech') {
            this.dom.wallTitle.textContent = 'random tech notes';
            this.dom.toggleWallButton.textContent = "rishu's wall";
        } else if (this.currentWall === 'songs') {
            this.dom.wallTitle.textContent = 'song quotes';
            this.dom.toggleWallButton.textContent = "rishu's wall";
        } else if (this.currentWall === 'ideas') {
            this.dom.wallTitle.textContent = 'project ideas';
            this.dom.toggleWallButton.textContent = "rishu's wall";
        } else if (this.currentWall === 'rishu') {
            this.updateWallTitle();
            this.dom.toggleWallButton.textContent = "friends' wall";
        } else if (this.currentWall === 'drafts') {
            this.dom.wallTitle.textContent = 'drafts';
            this.dom.toggleWallButton.textContent = 'back to wall';
        }
        this.updateAuthUI();

        // Capture pending entry id if present
        this._pendingEntryId = params.entry ? String(params.entry) : null;

        // Render cached entries instantly if present, otherwise show loader
        const cached = this.entriesCache[this.currentWall];
        if (Array.isArray(cached)) {
            this.entries = cached;
            this.renderEntries();
            if (this._pendingEntryId) this.openPendingEntry();
        } else {
            this.showLoading();
        }
        this.loadEntries();

        // Preload series info for any wall
        this.loadSeries().catch(() => {});
    }

    showHome() {
        this.isHome = true;
        // Lock body scroll to prevent white overscroll
        try { document.body.style.overflow = 'hidden'; } catch(_){}
        // Prevent iOS rubber-band on overlay
        this._blockTouchMove = (e) => { try { e.preventDefault(); } catch(_){} };
        // Hide wall content area
        this.dom.wall.innerHTML = '';
        if (this.dom.homeView) {
            this.dom.homeView.style.display = 'block';
            try { this.dom.homeView.addEventListener('touchmove', this._blockTouchMove, { passive: false }); } catch(_){}
            requestAnimationFrame(() => this.dom.homeView.classList.add('show'));
        }
        // Hide entire header on home
        if (this.dom.header) this.dom.header.style.display = 'none';
        if (!this.walls || !this.walls.length) {
            this.fetchWalls().then(() => { this.renderBubbles(); this.renderUtilityBubbles(); }).catch(() => { this.renderBubbles(); this.renderUtilityBubbles(); });
        } else {
            this.renderBubbles();
            this.renderUtilityBubbles();
        }
        this.initBubbleLighting();
    }

    hideHome() {
        if (!this.isHome) return;
        this.isHome = false;
        this.stopBubblesPhysics();
        this.stopBubbleLighting();
        try { document.body.style.overflow = ''; } catch(_){}
        if (this.dom.homeView) {
            this.dom.homeView.classList.remove('show');
            if (this._blockTouchMove) {
                try { this.dom.homeView.removeEventListener('touchmove', this._blockTouchMove, { passive: false }); } catch(_){}
                this._blockTouchMove = null;
            }
            setTimeout(() => { if (!this.isHome) this.dom.homeView.style.display = 'none'; }, 300);
        }
        if (this.dom.bubbles) this.dom.bubbles.innerHTML = '';
        // Restore header
        if (this.dom.header) this.dom.header.style.display = '';
        // Only show allowed controls: add entry, home, theme
        if (this.dom.addButton) this.dom.addButton.style.display = '';
        if (this.dom.homeButton) this.dom.homeButton.style.display = '';
        if (this.dom.darkModeToggle) this.dom.darkModeToggle.parentElement.style.display = '';
        // Hide switching controls on wall view
        if (this.dom.wallsNav) this.dom.wallsNav.style.display = 'none';
        if (this.dom.toggleWallButton) this.dom.toggleWallButton.style.display = 'none';
        if (this.dom.techButton) this.dom.techButton.style.display = 'none';
        if (this.dom.songsButton) this.dom.songsButton.style.display = 'none';
        if (this.dom.ideasButton) this.dom.ideasButton.style.display = 'none';
        if (this.dom.draftsButton) this.dom.draftsButton.style.display = 'none';
        if (this.dom.addWallButton) this.dom.addWallButton.style.display = 'none';
        if (this.dom.loginButton) this.dom.loginButton.style.display = 'none';
        // Show title again for wall
        if (this.dom.wallTitle) this.dom.wallTitle.style.display = '';
        this.updateWallTitle();
    }

    renderBubbles() {
        if (!this.dom.bubbles) return;
        const root = this.dom.bubbles;
        root.innerHTML = '';
        // Combine DB walls with virtual walls (friends/tech/songs/ideas)
        const wallsRaw = Array.isArray(this.walls) ? this.walls.slice() : [];
        const walls = wallsRaw.filter(w => (this.isAuthenticated ? true : !!w.is_public));
        const virtuals = this.getVirtualWalls();
        const virtualsFiltered = virtuals.filter(v => {
            if (v.slug === 'ideas' || v.slug === 'drafts') return this.isAuthenticated;
            return true;
        });
        const all = [...walls, ...virtualsFiltered];
        if (!all.length) return;
        // Center bubble: rishu
        const center = all.find(w => (String((w.slug||'')).toLowerCase() === 'rishu' && !w._virtual)) || all[0];
        const others = all.filter(w => w !== center);

        const centerEl = this.createBubble(center, true);
        // Initial center position
        const vw = window.innerWidth; const vh = window.innerHeight;
        const cx = Math.max(20, vw/2 - 80);
        const cy = Math.max(60, vh/2 - 80);
        centerEl.style.left = cx + 'px';
        centerEl.style.top = cy + 'px';
        root.appendChild(centerEl);

        // Place others initially around a ring so they don't stack
        const ringFactor = (vw <= 480 ? 0.30 : (vw <= 768 ? 0.26 : 0.22));
        const R0 = Math.min(vw, vh) * ringFactor;
        const N = others.length || 1;
        for (let i = 0; i < others.length; i++) {
            const w = others[i];
            const el = this.createBubble(w, false);
            const ang = (i / N) * Math.PI * 2;
            const px = Math.max(20, vw/2 + R0 * Math.cos(ang) - 60);
            const py = Math.max(80, vh/2 + R0 * Math.sin(ang) - 60);
            el.style.left = px + 'px';
            el.style.top = py + 'px';
            root.appendChild(el);
        }
        // Start/update physics layout
        this.initBubblesPhysics();
    }

    createBubble(wall, isCenter = false) {
        const el = document.createElement('div');
        el.className = 'bubble' + (isCenter ? ' center' : '');
        const slugLower = String((wall.slug||'')).toLowerCase();
        let label = (slugLower === 'rishu') ? "rishu's wall" : (wall.name || 'wall');
        if (wall._virtual && wall.slug === 'friend') label = "friends' wall";
        if (wall._virtual && wall.slug === 'tech') label = 'tech notes';
        if (wall._virtual && wall.slug === 'songs') label = 'song quotes';
        if (wall._virtual && wall.slug === 'ideas') label = 'project ideas';
        if (wall._virtual && wall.slug === 'drafts') label = 'drafts';
        el.innerHTML = `<span>${this.escapeHtml(label)}</span>`;
        // Subtle per-bubble visual variance
        if (!isCenter) {
            const r = (min, max) => (min + Math.random() * (max - min));
            el.style.setProperty('--g1x', `${r(24, 36).toFixed(1)}%`);
            el.style.setProperty('--g1y', `${r(24, 36).toFixed(1)}%`);
            el.style.setProperty('--g1a', `${r(0.10, 0.20).toFixed(3)}`);
            el.style.setProperty('--g2x', `${r(62, 78).toFixed(1)}%`);
            el.style.setProperty('--g2y', `${r(62, 78).toFixed(1)}%`);
            el.style.setProperty('--g2a', `${r(0.03, 0.09).toFixed(3)}`);
            el.style.setProperty('--spec1a', `${r(0.28, 0.46).toFixed(3)}`);
            el.style.setProperty('--spec2a', `${r(0.10, 0.18).toFixed(3)}`);
            el.style.setProperty('--hl1t', `${r(12, 20).toFixed(1)}%`);
            el.style.setProperty('--hl1l', `${r(16, 24).toFixed(1)}%`);
            el.style.setProperty('--hl2b', `${r(14, 22).toFixed(1)}%`);
            el.style.setProperty('--hl2r', `${r(12, 20).toFixed(1)}%`);
            el.style.setProperty('--rot', `${r(-4, 4).toFixed(1)}deg`);
            // Size variance with mobile-friendly bounds
            const vw = window.innerWidth || 1024;
            let minS = 110, maxS = 130;
            if (vw <= 480) { minS = 78; maxS = 92; }
            else if (vw <= 768) { minS = 96; maxS = 110; }
            const s = Math.round(r(minS, maxS));
            el.style.width = `${s}px`; el.style.height = `${s}px`;
        } else {
            // Center bubble: scale down on small screens
            const vw = window.innerWidth || 1024;
            let c = 160;
            if (vw <= 480) c = 120; else if (vw <= 768) c = 140;
            el.style.width = `${c}px`; el.style.height = `${c}px`;
        }
        el.addEventListener('click', () => {
            // Prevent overlapping navigations
            if (this._bubbleNavTimer) { clearTimeout(this._bubbleNavTimer); this._bubbleNavTimer = null; }
            // trigger pop animation explicitly
            el.classList.add('pop');
            el.style.animation = 'pop 300ms ease forwards';
        if (wall._virtual) {
            // Navigate immediately; hashchange will handle hiding home
            if (wall.slug === 'rishu') location.hash = '#rishu';
            else if (wall.slug === 'friend') location.hash = '#friend';
            else if (wall.slug === 'tech') location.hash = '#tech';
            else if (wall.slug === 'songs') location.hash = '#songs';
            else if (wall.slug === 'ideas') location.hash = '#ideas';
            else if (wall.slug === 'drafts') location.hash = '#drafts';
            else location.hash = '#';
        } else {
                this.selectedWall = { id: wall.id, slug: wall.slug, name: wall.name, is_public: !!wall.is_public };
                this.saveSelectedWallState();
                // Route explicitly to #rishu for clarity
                location.hash = '#rishu';
                // Proactively hide home and load entries to avoid any lag
                this.hideHome();
                this.currentWall = 'rishu';
                this.updateWallTitle();
                this.entriesCache.rishu = null;
                this.loadEntries();
            }
            // Clear pop class after animation duration
            this._bubbleNavTimer = setTimeout(() => { el.classList.remove('pop'); el.style.animation = ''; this._bubbleNavTimer = null; }, 320);
        });
        return el;
    }

    getVirtualWalls() {
        // Always include the non-DB special views as bubbles
        const v = [];
        // Add a virtual rishu bubble if DB hasn't returned one
        const hasRishu = Array.isArray(this.walls) && this.walls.some(w => String((w.slug||'')).toLowerCase() === 'rishu');
        if (!hasRishu) v.push({ _virtual: true, slug: 'rishu', name: "rishu's wall" });
        v.push({ _virtual: true, slug: 'friend', name: "friends' wall" });
        v.push({ _virtual: true, slug: 'tech', name: 'tech notes' });
        v.push({ _virtual: true, slug: 'songs', name: 'song quotes' });
        v.push({ _virtual: true, slug: 'ideas', name: 'project ideas' });
        // Drafts is auth-only; include here and filter based on isAuthenticated in renderBubbles
        v.push({ _virtual: true, slug: 'drafts', name: 'drafts' });
        return v;
    }

    initBubblesPhysics() {
        // Stop any existing loop
        this.stopBubblesPhysics();
        if (!this.dom.bubbles) return;
        const nodes = [];
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const cx = vw / 2;
        const cy = vh / 2 + 10; // bias down slightly
        const els = Array.from(this.dom.bubbles.querySelectorAll('.bubble'))
            .filter(el => !el.classList.contains('util'));
        // Determine anchors around a ring for non-center bubbles
        const ringFactor = (vw <= 480 ? 0.30 : (vw <= 768 ? 0.26 : 0.22));
        const ringR = Math.min(vw, vh) * ringFactor;
        let anchorIndex = 0;
        els.forEach((el) => {
            // Allow CSS animations; physics controls left/top
            const rect = el.getBoundingClientRect();
            const r = (rect.width || (el.classList.contains('center') ? 160 : 120)) / 2;
            const isCenter = el.classList.contains('center');
            let anchorX = cx, anchorY = cy, angle = 0;
            if (!isCenter) {
                const t = anchorIndex / Math.max(1, (els.length - 1));
                angle = t * Math.PI * 2;
                anchorX = cx + ringR * Math.cos(angle);
                anchorY = cy + ringR * Math.sin(angle);
                anchorIndex++;
            }
            // Initial position: near anchor with tiny random offset
            const x = anchorX + (Math.random() - 0.5) * 12;
            const y = anchorY + (Math.random() - 0.5) * 12;
            const vx = (Math.random() - 0.5) * 0.15;
            const vy = (Math.random() - 0.5) * 0.15;
            nodes.push({ el, x, y, vx, vy, r, m: r * r, fixed: isCenter, anchorX, anchorY, angle });
        });
        this._bubbleSim = { nodes, raf: null, last: performance.now() };
        const onResize = () => { if (this.isHome) this.resetBubblesPositions(); };
        window.addEventListener('resize', onResize);
        this._bubbleSim.onResize = onResize;
        const step = (t) => {
            if (!this._bubbleSim) return;
            this.stepBubblesPhysics(t);
            this._bubbleSim.raf = requestAnimationFrame(step);
        };
        this._bubbleSim.raf = requestAnimationFrame(step);
    }

    stopBubblesPhysics() {
        if (this._bubbleSim && this._bubbleSim.raf) cancelAnimationFrame(this._bubbleSim.raf);
        if (this._bubbleSim && this._bubbleSim.onResize) window.removeEventListener('resize', this._bubbleSim.onResize);
        this._bubbleSim = null;
    }

    resetBubblesPositions() {
        if (!this._bubbleSim) return;
        const vw = window.innerWidth; const vh = window.innerHeight;
        const cx = vw/2; const cy = vh/2 + 10;
        const ringR = Math.min(vw, vh) * 0.22;
        // Recompute anchors
        const nonCenter = this._bubbleSim.nodes.filter(n => !n.fixed);
        nonCenter.forEach((n, i) => {
            const t = i / Math.max(1, (nonCenter.length));
            const angle = t * Math.PI * 2;
            n.anchorX = cx + ringR * Math.cos(angle);
            n.anchorY = cy + ringR * Math.sin(angle);
        });
        this._bubbleSim.nodes.forEach(n => {
            if (n.fixed) {
                n.x = cx; n.y = cy; n.vx = 0; n.vy = 0; return;
            }
            n.x = n.anchorX + (Math.random()-0.5)*12;
            n.y = n.anchorY + (Math.random()-0.5)*12;
            n.vx = (Math.random()-0.5)*0.15; n.vy = (Math.random()-0.5)*0.15;
        });
    }

    stepBubblesPhysics(time) {
        const sim = this._bubbleSim; if (!sim) return;
        const dt = Math.min(0.04, (time - (sim.last || time)) / 1000) || 0.016;
        sim.last = time;
        const nodes = sim.nodes;
        const vw = window.innerWidth; const vh = window.innerHeight;
        const cx = vw/2; const cy = vh/2 + 10;
        const anchorStrength = 2.0; // attraction to anchor
        const centerStrength = 0.1; // light global cohesion
        const friction = 0.93;
        const jitter = 0.01; // smaller jiggle

        // Attraction to per-node anchor (keeps relative positions), movement
        for (let i = 0; i < nodes.length; i++) {
            const n = nodes[i];
            if (n.fixed) { n.x = cx; n.y = cy; n.vx = 0; n.vy = 0; continue; }
            const dxA = (n.anchorX) - n.x; const dyA = (n.anchorY) - n.y;
            n.vx += dxA * anchorStrength * dt;
            n.vy += dyA * anchorStrength * dt;
            // mild global cohesion to center
            const dxC = cx - n.x; const dyC = cy - n.y;
            n.vx += dxC * centerStrength * dt;
            n.vy += dyC * centerStrength * dt;
            // tiny jitter
            n.vx += (Math.random() - 0.5) * jitter;
            n.vy += (Math.random() - 0.5) * jitter;
            // integrate
            n.vx *= friction; n.vy *= friction;
            n.x += n.vx; n.y += n.vy;
        }
        // Collision resolution (simple repulsion)
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i+1; j < nodes.length; j++) {
                const a = nodes[i], b = nodes[j];
                if (a.fixed && b.fixed) continue;
                const dx = b.x - a.x; const dy = b.y - a.y;
                const distSq = dx*dx + dy*dy;
                const minDist = a.r + b.r - 4; // slight overlap tolerance
                if (distSq > 0) {
                    const dist = Math.sqrt(distSq);
                    if (dist < minDist) {
                        const overlap = (minDist - dist) * 0.5;
                        const nx = dx / dist; const ny = dy / dist;
                        // separate
                        if (!a.fixed) { a.x -= nx * overlap; a.y -= ny * overlap; }
                        if (!b.fixed) { b.x += nx * overlap; b.y += ny * overlap; }
                        // simple velocity exchange along normal
                        const av = a.vx*nx + a.vy*ny;
                        const bv = b.vx*nx + b.vy*ny;
                        const swap = bv - av;
                        if (!a.fixed) { a.vx += nx * swap; a.vy += ny * swap; }
                        if (!b.fixed) { b.vx -= nx * swap; b.vy -= ny * swap; }
                    }
                }
            }
        }
        // Write positions
        for (let i = 0; i < nodes.length; i++) {
            const n = nodes[i];
            n.el.style.left = (n.x - n.r) + 'px';
            n.el.style.top = (n.y - n.r) + 'px';
        }
    }

    renderUtilityBubbles() {
        if (!this.dom.bubbles) return;
        // Remove any previous utility bubbles
        const prev = this.dom.bubbles.querySelectorAll('.bubble.util');
        prev.forEach(n => n.remove());
        const vw = window.innerWidth; const top = 20;
        // Add wall (top-left) — only if authenticated
        if (this.isAuthenticated) {
            const add = document.createElement('div');
            add.className = 'bubble small util';
            add.style.left = '20px';
            add.style.top = `${top}px`;
            add.innerHTML = '<span>add wall</span>';
            add.addEventListener('click', () => this.showCreateWallModal());
            this.dom.bubbles.appendChild(add);
        }
        // Login / Logout (top middle)
        const auth = document.createElement('div');
        auth.className = 'bubble small util';
        auth.style.left = `${Math.max(20, vw/2 - 45)}px`;
        auth.style.top = `${top}px`;
        auth.innerHTML = `<span>${this.isAuthenticated ? 'logout' : 'login'}</span>`;
        auth.addEventListener('click', () => this.handleLoginClick());
        this.dom.bubbles.appendChild(auth);
        // Theme toggle (top right)
        const theme = document.createElement('div');
        theme.className = 'bubble small util';
        theme.style.left = `${Math.max(20, vw - 110)}px`;
        theme.style.top = `${top}px`;
        theme.innerHTML = '<span>theme</span>';
        theme.addEventListener('click', () => {
            this.dom.darkModeToggle.checked = !this.dom.darkModeToggle.checked;
            this.toggleDarkMode();
        });
        this.dom.bubbles.appendChild(theme);
    }

    // Subtle dynamic lighting based on pointer and slow drift
    initBubbleLighting() {
        this.stopBubbleLighting();
        const state = { mx: 0.5, my: 0.5, lastMove: performance.now(), raf: null };
        const root = this.dom.bubbles;
        if (!root) return;
        const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
        if (isTouch) { this._bubbleLight = null; return; }
        const apply = () => {
            const els = Array.from(root.querySelectorAll('.bubble')).filter(el => !el.classList.contains('util'));
            const angle = Math.atan2(state.my - 0.5, state.mx - 0.5) * 180 / Math.PI;
            els.forEach((el, idx) => {
                // vary per bubble a touch
                const k = 0.06 + (idx % 5) * 0.004;
                const offX = (state.mx - 0.5) * 10 * k; // percent
                const offY = (state.my - 0.5) * 10 * k;
                const hl1l = parseFloat((el.style.getPropertyValue('--hl1l') || '20%')); // may be set with %
                const hl1t = parseFloat((el.style.getPropertyValue('--hl1t') || '16%'));
                const hl2r = parseFloat((el.style.getPropertyValue('--hl2r') || '16%'));
                const hl2b = parseFloat((el.style.getPropertyValue('--hl2b') || '18%'));
                // update highlights relative to pointer
                el.style.setProperty('--hl1l', `${Math.max(10, Math.min(30, hl1l + offX))}%`);
                el.style.setProperty('--hl1t', `${Math.max(10, Math.min(30, hl1t + offY))}%`);
                el.style.setProperty('--hl2r', `${Math.max(10, Math.min(30, hl2r - offX))}%`);
                el.style.setProperty('--hl2b', `${Math.max(10, Math.min(30, hl2b - offY))}%`);
                el.style.setProperty('--envAngle', `${25 + angle * 0.15}deg`);
            });
        };
        const onMove = (e) => {
            const x = (e.touches && e.touches.length) ? e.touches[0].clientX : e.clientX;
            const y = (e.touches && e.touches.length) ? e.touches[0].clientY : e.clientY;
            state.mx = Math.max(0, Math.min(1, x / window.innerWidth));
            state.my = Math.max(0, Math.min(1, y / window.innerHeight));
            state.lastMove = performance.now();
            apply();
        };
        window.addEventListener('mousemove', onMove);
        // gentle drift when idle
        const drift = (t) => {
            const now = performance.now();
            if (now - state.lastMove > 1500) {
                const t2 = now * 0.00015;
                state.mx = 0.5 + Math.cos(t2) * 0.05;
                state.my = 0.5 + Math.sin(t2 * 1.2) * 0.05;
                apply();
            }
            state.raf = requestAnimationFrame(drift);
        };
        state.raf = requestAnimationFrame(drift);
        this._bubbleLight = { state, onMove };
        // initial
        apply();
    }

    stopBubbleLighting() {
        if (this._bubbleLight) {
            window.removeEventListener('mousemove', this._bubbleLight.onMove);
            window.removeEventListener('touchmove', this._bubbleLight.onMove);
            if (this._bubbleLight.state.raf) cancelAnimationFrame(this._bubbleLight.state.raf);
        }
        this._bubbleLight = null;
    }

    handleAddButtonClick() {
        if (this.currentWall === 'friend') {
            this.showFriendEntryForm();
        } else if (this.currentWall === 'tech') {
            if (this.isAuthenticated) {
                this.showTechEntryForm();
            } else {
                this.showPasswordForm();
            }
        } else if (this.currentWall === 'songs') {
            if (this.isAuthenticated) {
                this.showSongsEntryForm();
            } else {
                this.showPasswordForm();
            }
        } else if (this.currentWall === 'ideas') {
            if (this.isAuthenticated) {
                this.showIdeasEntryForm();
            } else {
                this.showPasswordForm();
            }
        } else {
            if (this.isAuthenticated && this.isVideoWall()) {
                this.showVideoEntryForm();
                return;
            }
            if (this.isAuthenticated) {
                this.showEntryForm();
            } else {
                this.showPasswordForm();
            }
        }
    }

    renderEntries() {
        // Do not render entries when on the home bubbles view
        if (this.isHome) return;
        this.dom.wall.innerHTML = '';
        // Sort: pinned first by pin_order asc, then others by timestamp desc
        let entries = [...this.entries];
        const hasSeries = Array.isArray(this.series) && this.series.length > 0;
        const hasEntries = entries.length > 0;

        // Render series cards first (if any), even if there are no entries
        if (hasSeries) {
            this.series.forEach((s) => {
                const card = this.renderSeriesCard(s);
                this.dom.wall.appendChild(card);
            });
        }

        if (!hasEntries && !hasSeries) {
            this.showEmptyState();
            return;
        }

        // Filter out entries that are members of any series on this wall, unless the entry is pinned
        const hiddenIds = this.getSeriesMemberIdsForCurrentWall();
        if (hiddenIds && hiddenIds.size) {
            entries = entries.filter(e => e.is_pinned || !hiddenIds.has(String(e.id)));
        }
        const hasPinInfo = entries.some(e => typeof e.is_pinned !== 'undefined' || typeof e.pin_order !== 'undefined');
        let sorted = entries;
        if (hasPinInfo) {
            sorted = entries.sort((a, b) => {
                const ap = a.is_pinned ? 1 : 0;
                const bp = b.is_pinned ? 1 : 0;
                if (ap !== bp) return bp - ap; // pinned first
                if (ap === 1 && bp === 1) {
                    const ao = (a.pin_order ?? Number.MAX_SAFE_INTEGER);
                    const bo = (b.pin_order ?? Number.MAX_SAFE_INTEGER);
                    if (ao !== bo) return ao - bo;
                }
                // fallback by timestamp desc
                const at = a.timestamp || '';
                const bt = b.timestamp || '';
                return (bt > at) ? 1 : (bt < at ? -1 : 0);
            });
        }

        sorted.forEach((entry) => {
            const entryText = entry.text;
            const timestamp = entry.timestamp;
            const name = entry.name;

            const entryDiv = document.createElement('div');
            entryDiv.className = 'entry';
            entryDiv.dataset.id = entry.id;
            if (entry.is_pinned) entryDiv.classList.add('pinned');

            // Auth-only: allow DnD to add to series on all walls.
            // Avoid conflict with pinned reorder on rishu by skipping draggable for pinned rows.
            if (this.isAuthenticated && (!entry.is_pinned || this.currentWall !== 'rishu')) {
                entryDiv.setAttribute('draggable', 'true');
                entryDiv.addEventListener('dragstart', (ev) => {
                    const payload = { id: entry.id, type: this.currentWall };
                    try { ev.dataTransfer.setData('application/json', JSON.stringify(payload)); } catch(_) {}
                    try { ev.dataTransfer.setData('text/plain', `${this.currentWall}:${entry.id}`); } catch(_) {}
                    ev.dataTransfer.effectAllowed = 'move';
                });
                entryDiv.addEventListener('dragend', () => {
                    const h = document.querySelector('.series-card.drag-over');
                    if (h) h.classList.remove('drag-over');
                });
                // Right-click context menu: add to series / create series / delete
                entryDiv.addEventListener('contextmenu', (ev) => {
                    if (!this.isAuthenticated) return;
                    ev.preventDefault();
                    this.showEntryContextMenu(ev.clientX, ev.clientY, entry);
                });
            }
            // Ensure pinned rows on rishu also get context menu (no DnD)
            if (this.isAuthenticated && entry.is_pinned && this.currentWall === 'rishu') {
                entryDiv.addEventListener('contextmenu', (ev) => {
                    ev.preventDefault();
                    this.showEntryContextMenu(ev.clientX, ev.clientY, entry);
                });
            }

            const timestampSpan = document.createElement('span');
            timestampSpan.className = 'entry-timestamp';
            timestampSpan.textContent = timestamp ? this.formatTimestamp(timestamp) : '';

            if (name && this.currentWall === 'friend') {
                const nameSpan = document.createElement('span');
                nameSpan.className = 'entry-name';
                nameSpan.textContent = name;
                entryDiv.appendChild(timestampSpan);
                entryDiv.appendChild(nameSpan);
            } else {
                entryDiv.appendChild(timestampSpan);
            }

            // Spotify thumbnail for songs wall (after timestamp)
            if (this.currentWall === 'songs' && entry.spotify_url) {
                const thumb = document.createElement('img');
                thumb.alt = 'Album art';
                thumb.className = 'spotify-thumb';
                this.fetchSpotifyArt(entry.spotify_url).then((url) => { if (url) thumb.src = url; });
                entryDiv.appendChild(thumb);
            }

            // Video thumbnail for video walls (based on selected wall slug/name)
            if (this.currentWall === 'rishu' && this.isVideoWall()) {
                const url = this.extractFirstUrl(entryText);
                if (url) {
                    const vthumb = document.createElement('img');
                    vthumb.alt = 'Video thumbnail';
                    vthumb.className = 'video-thumb';
                    this.fetchVideoMeta(url).then(meta => { if (meta && meta.thumbnail_url) vthumb.src = meta.thumbnail_url; }).catch(()=>{});
                    entryDiv.appendChild(vthumb);
                }
            }

            // Title + divider + body text
            const hasTitle = typeof entry.title === 'string' && entry.title.trim().length > 0;
            if (hasTitle) {
                const titleSpan = document.createElement('span');
                titleSpan.className = 'entry-title';
                titleSpan.textContent = entry.title.trim();
                entryDiv.appendChild(titleSpan);

                const vdiv = document.createElement('span');
                vdiv.className = 'vdiv';
                entryDiv.appendChild(vdiv);
            }

            const textSpan = document.createElement('span');
            textSpan.className = 'entry-text';
            if (this.currentWall === 'rishu' && this.isVideoWall()) {
                const url = this.extractFirstUrl(entryText);
                if (url) {
                    // Prefer showing the video title as link text when available
                    const base = document.createElement('a');
                    base.href = url;
                    base.target = '_blank';
                    base.rel = 'noopener noreferrer';
                    base.textContent = entry.title && entry.title.trim() ? entry.title.trim() : url;
                    textSpan.innerHTML = '';
                    textSpan.appendChild(base);
                    // If no title, fetch meta to update text content lazily
                    if (!entry.title || !entry.title.trim()) {
                        this.fetchVideoMeta(url).then(meta => {
                            if (meta && meta.title) { base.textContent = meta.title; }
                        }).catch(()=>{});
                    }
                } else {
                    textSpan.innerHTML = this.linkify(entryText);
                }
            } else {
                textSpan.innerHTML = this.linkify(entryText);
            }

            entryDiv.appendChild(textSpan);

            // (thumb moved earlier)

            // Entry click: view on public/friends, edit on drafts (auth only)
            entryDiv.addEventListener('click', (ev) => {
                // Allow clicking links without opening modal
                if (ev.target && ev.target.closest && ev.target.closest('a')) {
                    ev.stopPropagation();
                    return;
                }
                if (Date.now() < (this._suppressClickUntil || 0)) {
                    // ignore click generated by finishing a drag
                    return;
                }
        if (this.currentWall === 'drafts' && this.isAuthenticated) {
            this.showEditForm(entry);
        } else if (this.currentWall === 'rishu' && this.isVideoWall()) {
            const url = this.extractFirstUrl(entry.text || '');
            if (url) {
                this.showVideoModal(entry);
                return;
            }
            this.showEntry(entry);
        } else {
            this.showEntry(entry);
        }
    });

            // Pin/unpin + drag controls on rishu wall
            if (this.currentWall === 'rishu') {
                const pinBtn = document.createElement('button');
                pinBtn.className = 'pin-btn';
                pinBtn.type = 'button';
                pinBtn.title = entry.is_pinned ? 'Unpin' : 'Pin';
                pinBtn.setAttribute('aria-label', entry.is_pinned ? 'Unpin entry' : 'Pin entry');
                pinBtn.innerHTML = `
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M8 3 H16 L14 8 V11 L17 14 V15 H7 V14 L10 11 V8 Z"/>
                      <path d="M12 15 V21"/>
                    </svg>
                `;
                // Prevent row-drag from starting when interacting with the pin button
                pinBtn.addEventListener('mousedown', (ev) => { ev.stopPropagation(); });
                pinBtn.addEventListener('touchstart', (ev) => { ev.stopPropagation(); }, { passive: true });
                pinBtn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    this.togglePin(entry);
                });
                entryDiv.appendChild(pinBtn);

                // Enable custom mouse-based dragging only for pinned entries
                if (entry.is_pinned) {
                    entryDiv.classList.add('draggable');
                    entryDiv.addEventListener('mousedown', (e) => this.onMouseDownDrag(e, entryDiv));
                    // touch support (basic)
                    entryDiv.addEventListener('touchstart', (e) => this.onTouchStartDrag(e, entryDiv), { passive: false });
                }
            }

            // No inline edit button on rows
            this.dom.wall.appendChild(entryDiv);
        });

        // dragover/drop listeners added once in setup
    }

    // Series: data and UI
    async loadSeries() {
        try {
            const wall = this.currentWall;
            const resp = await fetch(`/api/series?wall=${encodeURIComponent(wall)}`);
            const result = await resp.json().catch(() => ({}));
            if (!resp.ok) throw new Error(result.error || 'Failed to load series');
            this.series = result.data || [];
            this.seriesLoaded = true;
            // re-render to show series cards for current wall
            const cached = this.entriesCache[this.currentWall];
            if (Array.isArray(cached)) {
                this.entries = cached;
            }
            this.renderEntries();
        } catch (e) {
            // If table missing or other error, just leave empty
            this.series = [];
            this.seriesLoaded = true;
        }
    }

    renderSeriesCard(series) {
        const card = document.createElement('div');
        card.className = 'entry series-card';
        card.dataset.seriesId = String(series.id);
        // timestamp placeholder (hidden via CSS for series-card)
        const ts = document.createElement('span');
        ts.className = 'entry-timestamp';
        ts.textContent = '';
        card.appendChild(ts);

        const titleSpan = document.createElement('span');
        titleSpan.className = 'entry-title series-title';
        titleSpan.textContent = String(series.title || '').trim() || 'Untitled Series';
        card.appendChild(titleSpan);

        // Centering spacer
        const spacer = document.createElement('span');
        spacer.className = 'series-spacer';
        card.appendChild(spacer);

        // Toggle button
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'series-toggle';
        toggle.setAttribute('aria-label', 'Toggle series');
        toggle.innerHTML = `
            <svg class="chev" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 8 L12 16 L18 8 Z" />
            </svg>
        `;
        card.appendChild(toggle);

        // Right-click context menu on series card (auth only)
        if (this.isAuthenticated) {
            card.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.showSeriesContextMenu(e.clientX, e.clientY, series);
            });
        }

        const itemsWrap = document.createElement('div');
        itemsWrap.className = 'series-items hidden';

        const ensureLoaded = async () => {
            const sid = series.id;
            if (!this.seriesItemsCache.has(String(sid))) {
                const resp = await fetch(`/api/series-items?series_id=${encodeURIComponent(sid)}`);
                const result = await resp.json().catch(() => ({}));
                const data = resp.ok ? (result.data || []) : [];
                this.seriesItemsCache.set(String(sid), data);
            }
            const items = this.seriesItemsCache.get(String(sid)) || [];
            itemsWrap.innerHTML = '';
            if (!items.length) {
                const empty = document.createElement('div');
                empty.className = 'series-empty';
                empty.textContent = 'No notes in this series yet.';
                itemsWrap.appendChild(empty);
                return;
            }
            items.forEach(en => {
                const row = this.buildSeriesEntryRow(en);
                itemsWrap.appendChild(row);
            });
        };

        const toggleOpen = async () => {
            if (itemsWrap.classList.contains('hidden')) {
                // Attach group after the card on first open
                if (!itemsWrap.parentNode && card.parentNode) {
                    if (card.nextSibling) card.parentNode.insertBefore(itemsWrap, card.nextSibling);
                    else card.parentNode.appendChild(itemsWrap);
                }
                await ensureLoaded();
                itemsWrap.classList.remove('hidden');
                card.classList.add('expanded');
            } else {
                itemsWrap.classList.add('hidden');
                card.classList.remove('expanded');
            }
        };

        toggle.addEventListener('click', (e) => { e.stopPropagation(); toggleOpen(); });
        card.addEventListener('click', () => toggleOpen());

        // Accept drops to add entries to series (auth only)
        if (this.isAuthenticated) {
            card.addEventListener('dragover', (ev) => {
                try { ev.preventDefault(); } catch(_){}
                card.classList.add('drag-over');
            });
            card.addEventListener('dragleave', () => { card.classList.remove('drag-over'); });
            card.addEventListener('drop', async (ev) => {
                try { ev.preventDefault(); } catch(_){}
                card.classList.remove('drag-over');
                let id = null; let type = null;
                try {
                    const json = ev.dataTransfer.getData('application/json');
                    if (json) { const o = JSON.parse(json); id = o.id; type = o.type; }
                } catch(_) {}
                if (!id) {
                    try {
                        const txt = ev.dataTransfer.getData('text/plain');
                        if (txt && txt.includes(':')) { const [t, i] = txt.split(':'); type = t; id = i; }
                        else if (txt) { id = txt; type = this.currentWall; }
                    } catch(_) {}
                }
                if (!id) return;
                try {
                    await this.addToSeries(series.id, id, type || this.currentWall);
                    // refresh items cache and view if expanded
                    this.seriesItemsCache.delete(String(series.id));
                    if (card.classList.contains('expanded')) await ensureLoaded();
                } catch (e) {
                    const msg = String(e && e.message || 'Failed to add to series');
                    alert(msg);
                }
            });
        }

        return card;
    }

    async createSeries(title) {
        const resp = await fetch('/api/series', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, password: this.tempPassword, wall: this.currentWall })
        });
        const result = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(result.error || 'Error creating series');
        return result.data;
    }

    async addToSeries(seriesId, entryId, type) {
        const resp = await fetch('/api/series-items', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ series_id: seriesId, source_type: type, source_id: entryId, password: this.tempPassword })
        });
        const result = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(result.error || 'Failed to add to series');
        return true;
    }

    async removeFromSeries(seriesId, entryId, type) {
        const resp = await fetch('/api/series-items', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ series_id: seriesId, source_type: type, source_id: entryId, password: this.tempPassword })
        });
        const result = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(result.error || 'Failed to remove from series');
        return true;
    }

    async deleteSeries(seriesId) {
        const resp = await fetch(`/api/series?id=${encodeURIComponent(seriesId)}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: this.tempPassword })
        });
        const result = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(result.error || 'Failed to delete series');
        return true;
    }

    showSeriesContextMenu(x, y, series) {
        // Remove existing menu if present
        const old = document.getElementById('entryContextMenu');
        if (old) old.remove();
        const wrap = document.createElement('div');
        wrap.id = 'entryContextMenu';
        wrap.className = 'context-menu';
        wrap.style.left = x + 'px';
        wrap.style.top = y + 'px';

        const del = document.createElement('div');
        del.className = 'context-item';
        del.textContent = 'Delete series…';
        del.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            wrap.remove();
            const ok = confirm('Delete this series? Items will remain on their walls.');
            if (!ok) return;
            try {
                await this.deleteSeries(series.id);
                this.series = (this.series || []).filter(s => String(s.id) !== String(series.id));
                this.seriesItemsCache.delete(String(series.id));
                this.renderEntries();
            } catch (e) {
                alert('Failed to delete series');
            }
        });
        wrap.appendChild(del);

        document.body.appendChild(wrap);
    }

    showEntryContextMenu(x, y, entry) {
        // Remove any existing
        const old = document.getElementById('entryContextMenu');
        if (old) old.remove();
        const wrap = document.createElement('div');
        wrap.id = 'entryContextMenu';
        wrap.className = 'context-menu';
        wrap.style.left = x + 'px';
        wrap.style.top = y + 'px';

        const add = document.createElement('div');
        add.className = 'context-item';
        add.textContent = 'Add to series…';
        wrap.appendChild(add);

        const sub = document.createElement('div');
        sub.className = 'context-submenu hidden';
        wrap.appendChild(sub);

        add.addEventListener('mouseenter', () => {
            const populate = () => {
                sub.innerHTML = '';
                const list = (this.series && this.series.length) ? this.series : [];
                if (!list.length) {
                    const it = document.createElement('div');
                    it.className = 'context-item disabled';
                    it.textContent = 'No series yet';
                    sub.appendChild(it);
                } else {
                    list.forEach(s => {
                        const it = document.createElement('div');
                        it.className = 'context-item';
                        it.textContent = s.title || 'Untitled series';
                        it.addEventListener('click', async (ev) => {
                            ev.stopPropagation();
                            wrap.remove();
                            try { await this.addToSeries(s.id, entry.id, this.currentWall); } catch (e) { alert(String(e && e.message || 'Failed')); }
                        });
                        sub.appendChild(it);
                    });
                }
                sub.classList.remove('hidden');
            };
            if (!this.seriesLoaded) {
                this.loadSeries().then(populate).catch(populate);
            } else {
                populate();
            }
        });
        add.addEventListener('mouseleave', () => { setTimeout(() => sub.classList.add('hidden'), 200); });

        const create = document.createElement('div');
        create.className = 'context-item';
        create.textContent = 'Create new series…';
        create.addEventListener('click', async () => {
            const name = prompt('Series title');
            if (!name) return;
            try {
                const s = await this.createSeries(name);
                this.series = [s, ...(this.series || [])];
                await this.addToSeries(s.id, entry.id, this.currentWall);
                // show the new series card immediately on any wall
                this.renderEntries();
            } catch (e) {
                alert(String(e && e.message || 'Failed to create series'));
            } finally {
                wrap.remove();
            }
        });
        wrap.appendChild(create);

        // Divider isn't styled; we just append another action.
        const del = document.createElement('div');
        del.className = 'context-item';
        del.textContent = 'Delete entry…';
        del.addEventListener('click', (ev) => {
            ev.stopPropagation();
            wrap.remove();
            this.showDeleteEntryConfirm(entry);
        });
        wrap.appendChild(del);

        document.body.appendChild(wrap);
    }

    showDeleteEntryConfirm(entry) {
        const cm = document.getElementById('entryContextMenu');
        if (cm) cm.remove();
        const form = document.createElement('form');
        form.className = 'entry-form';
        form.innerHTML = `
            <h3>Delete Entry</h3>
            <div class="entry-text">Type \"delete me\" to confirm deletion.</div>
            <div class="delete-confirm">
              <small>Confirmation</small>
              <div class="confirm-row">
                <input type="text" class="confirm-input" placeholder="delete me" />
                <button type="button" class="btn-liquid danger clear confirm-btn" disabled>Delete</button>
              </div>
            </div>
        `;
        this.dom.modalBody.innerHTML = '';
        this.dom.modalBody.appendChild(form);
        this._modalContext = 'delete-entry';
        this._activeForm = form;

        const input = form.querySelector('.confirm-input');
        const btn = form.querySelector('.confirm-btn');
        input.addEventListener('input', () => {
            btn.disabled = !(String(input.value || '').trim().toLowerCase() === 'delete me');
        });

        btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
                const id = entry && entry.id;
                if (!id) return;
                const w = this.currentWall;
                if (w === 'friend') await this.removeFriendEntry(id);
                else if (w === 'tech') await this.removeTechNote(id);
                else if (w === 'songs') await this.removeSongQuote(id);
                else if (w === 'ideas') await this.removeProjectIdea(id);
                else await this.removeEntry(id);

                // Update local caches
                const key = (['friend','tech','songs','ideas','drafts'].includes(w)) ? w : 'rishu';
                if (Array.isArray(this.entriesCache[key])) {
                    this.entriesCache[key] = this.entriesCache[key].filter(e => e.id !== id);
                    if (this.currentWall === key || (key === 'rishu' && this.currentWall === 'rishu')) {
                        this.entries = this.entriesCache[key];
                        this.renderEntries();
                    }
                } else {
                    // Fallback: reload
                    await this.loadEntries();
                }
                this.closeModal();
            } catch (_) {
                alert('Failed to delete entry.');
                btn.disabled = false;
            }
        });

        this.openModal();
        setTimeout(() => input?.focus(), 50);
    }

    stripHtml(s = '') { const d = document.createElement('div'); d.innerHTML = String(s || ''); return (d.textContent || '').trim(); }

    buildSeriesEntryRow(en) {
        const type = en._type || this.currentWall || 'rishu';
        const row = document.createElement('div');
        row.className = 'entry series-item';
        row.dataset.id = en.id;

        // timestamp
        const timestampSpan = document.createElement('span');
        timestampSpan.className = 'entry-timestamp';
        timestampSpan.textContent = en.timestamp ? this.formatTimestamp(en.timestamp) : '';
        row.appendChild(timestampSpan);

        // friend name
        if (type === 'friend' && en.name) {
            const nameSpan = document.createElement('span');
            nameSpan.className = 'entry-name';
            nameSpan.textContent = en.name;
            row.appendChild(nameSpan);
        }

        // songs thumbnail
        if (type === 'songs' && en.spotify_url) {
            const thumb = document.createElement('img');
            thumb.alt = 'Album art';
            thumb.className = 'spotify-thumb';
            this.fetchSpotifyArt(en.spotify_url).then((url) => { if (url) thumb.src = url; });
            row.appendChild(thumb);
        }

        // title + divider
        const hasTitle = typeof en.title === 'string' && en.title.trim().length > 0;
        if (hasTitle) {
            const titleSpan = document.createElement('span');
            titleSpan.className = 'entry-title';
            titleSpan.textContent = en.title.trim();
            row.appendChild(titleSpan);
            const vdiv = document.createElement('span');
            vdiv.className = 'vdiv';
            row.appendChild(vdiv);
        }

        // body text
        const textSpan = document.createElement('span');
        textSpan.className = 'entry-text';
        textSpan.innerHTML = this.linkify(en.text || '');
        row.appendChild(textSpan);

        // click to open on appropriate wall
        row.addEventListener('click', (ev) => {
            if (ev.target && ev.target.closest && ev.target.closest('a')) {
                ev.stopPropagation();
                return;
            }
            const id = en.id;
            const h = type === 'rishu' ? `#rishu&entry=${id}`
                     : type === 'friend' ? `#friend&entry=${id}`
                     : type === 'tech' ? `#tech&entry=${id}`
                     : type === 'songs' ? `#songs&entry=${id}`
                     : type === 'ideas' ? `#ideas&entry=${id}`
                     : `#rishu&entry=${id}`;
            location.hash = h;
        });

        return row;
    }

    // Series helpers
    async prefetchSeriesItemsForCurrentWall() {
        if (!Array.isArray(this.series) || !this.series.length) return;
        const toLoad = this.series.filter(s => !this.seriesItemsCache.has(String(s.id)));
        if (!toLoad.length) return;
        await Promise.all(toLoad.map(async (s) => {
            try {
                const resp = await fetch(`/api/series-items?series_id=${encodeURIComponent(s.id)}`);
                const result = await resp.json().catch(() => ({}));
                const data = resp.ok ? (result.data || []) : [];
                this.seriesItemsCache.set(String(s.id), data);
            } catch (_) { /* ignore */ }
        }));
    }

    getSeriesMemberIdsForCurrentWall() {
        if (!Array.isArray(this.series) || !this.series.length) return new Set();
        const wall = this.currentWall;
        const ids = new Set();
        for (const s of this.series) {
            const arr = this.seriesItemsCache.get(String(s.id));
            if (!Array.isArray(arr)) continue;
            for (const item of arr) {
                const t = item && (item._type || wall);
                if (t === wall && item && item.id != null) ids.add(String(item.id));
            }
        }
        return ids;
    }


    formatTimestamp(isoString) {
        const date = new Date(isoString);

        // Convert to PST (UTC-8) / PDT (UTC-7)
        const pstTime = new Date(date.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));

        const month = String(pstTime.getMonth() + 1).padStart(2, '0');
        const day = String(pstTime.getDate()).padStart(2, '0');
        const year = pstTime.getFullYear();
        const hours = String(pstTime.getHours()).padStart(2, '0');
        const minutes = String(pstTime.getMinutes()).padStart(2, '0');
        const seconds = String(pstTime.getSeconds()).padStart(2, '0');

        return `${month}/${day}/${year} ${hours}:${minutes}:${seconds}`;
    }

    showEntry(entry) {
        const isObj = entry && typeof entry === 'object';
        const text = isObj ? entry.text : String(entry || '');
        const container = document.createElement('div');
        // Optional title heading (skip in songs modal when spotify shows metadata)
        if (isObj && entry.title && String(entry.title).trim() && !(this.currentWall === 'songs' && entry && entry.spotify_url)) {
            const h = document.createElement('h3');
            h.className = 'full-entry-title';
            h.textContent = String(entry.title).trim();
            container.appendChild(h);
        }
        const content = document.createElement('div');
        content.className = 'full-entry';
        content.innerHTML = this.linkify(text);

        // Songs modal: show Spotify embed only (no extra art/title)
        if (this.currentWall === 'songs' && entry && entry.spotify_url) {
            const embedWrap = document.createElement('div');
            embedWrap.className = 'spotify-embed';
            container.appendChild(embedWrap);
            this.fetchSpotifyOEmbed(entry.spotify_url)
                .then((data) => {
                    if (data && data.html) embedWrap.innerHTML = data.html;
                })
                .catch(() => {});
        }

        container.appendChild(content);

        // Actions at bottom for any wall
        if (isObj) {
            const actions = document.createElement('div');
            actions.className = 'modal-actions';

            const left = document.createElement('div');
            const center = document.createElement('div');
            const right = document.createElement('div');
            center.className = 'actions-center';
            right.className = 'actions-right';
            actions.appendChild(left);
            actions.appendChild(center);
            actions.appendChild(right);

            // Delete (auth only)
            let delBtn = null;
            if (this.isAuthenticated) {
                delBtn = document.createElement('button');
                delBtn.type = 'button';
                delBtn.className = 'btn-liquid clear';
                delBtn.textContent = 'Delete';
                left.appendChild(delBtn);
            }

            // Edit (auth only) for known editable walls
            if (this.isAuthenticated && (this.currentWall === 'rishu' || this.currentWall === 'tech' || this.currentWall === 'songs' || this.currentWall === 'ideas')) {
                const editBtn = document.createElement('button');
                editBtn.type = 'button';
                editBtn.className = 'action-edit-btn btn-liquid clear';
                editBtn.innerHTML = `
                    <svg viewBox=\"0 0 24 24\" aria-hidden=\"true\" style=\"width:16px;height:16px;vertical-align:middle;margin-right:6px;\">
                      <path d=\"M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>
                      <path d=\"M14.06 6.19l1.83-1.83 3.75 3.75-1.83 1.83-3.75-3.75z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>
                    </svg>
                    Edit`;
                editBtn.addEventListener('click', () => {
                    if (this.currentWall === 'tech') this.showTechEditForm(entry);
                    else if (this.currentWall === 'songs') this.showSongsEditForm(entry);
                    else if (this.currentWall === 'ideas') this.showIdeasEditForm(entry);
                    else this.showEditForm(entry);
                });
                right.appendChild(editBtn);
            }

            // Share icon button (all walls, default behavior for future walls)
            {
                const shareBtn = document.createElement('button');
                shareBtn.type = 'button';
                shareBtn.className = 'icon-btn btn-liquid clear';
                shareBtn.title = 'Share link';
                shareBtn.setAttribute('aria-label', 'Share link');
                shareBtn.innerHTML = `
                    <svg viewBox=\"0 0 24 24\" width=\"22\" height=\"22\" aria-hidden=\"true\">
                      <path d=\"M12 13V6\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\"/>
                      <path d=\"M9 9l3-3 3 3\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>
                      <rect x=\"5\" y=\"14\" width=\"14\" height=\"5\" rx=\"2.5\" ry=\"2.5\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\"/>
                    </svg>`;
                shareBtn.addEventListener('click', async () => {
                    this.showShareLoading();
                    try {
                        const wall = String(this.currentWall || '').toLowerCase();
                        if (wall === 'rishu' || wall === 'friend') {
                            const { shortUrl } = await this.createShortLink(entry.id, wall === 'friend' ? 'friend' : 'rishu');
                            this.showShareModal(shortUrl);
                        } else {
                            // Default: share a hash link for any other wall types (future-proof)
                            const base = location.origin || '';
                            const longUrl = `${base}/#${encodeURIComponent(wall)}&entry=${encodeURIComponent(entry.id)}`;
                            const { shortUrl } = await this.createShortLink(null, null, longUrl);
                            this.showShareModal(shortUrl || longUrl);
                        }
                    } catch (e) {
                        const msg = String(e && e.message) || '';
                        if (/Short links require DB migration/i.test(msg)) {
                            this.showShareError('Short links require DB migration. Please run supabase db push.');
                        } else if (/External shortener failed/i.test(msg)) {
                            this.showShareError('Short-link service unavailable. Please try again.');
                        } else {
                            this.showShareError('Failed to create link. Please try again.');
                        }
                    }
                });
                center.appendChild(shareBtn);
            }

            // Delete confirm UI (hidden until clicked)
            if (delBtn) {
                const confirmWrap = document.createElement('div');
                confirmWrap.className = 'delete-confirm';
                confirmWrap.style.display = 'none';
                confirmWrap.innerHTML = `
                    <small>Type "delete me" to confirm</small>
                    <div class="confirm-row">
                      <input type="text" class="confirm-input" placeholder="delete me" />
                      <button type="button" class="btn-liquid clear confirm-btn" disabled>Confirm</button>
                    </div>
                `;

                delBtn.addEventListener('click', () => {
                    confirmWrap.style.display = confirmWrap.style.display === 'none' ? 'flex' : 'none';
                });

                const input = confirmWrap.querySelector('.confirm-input');
                const confirmBtn = confirmWrap.querySelector('.confirm-btn');
                input.addEventListener('input', () => {
                    confirmBtn.disabled = !(input.value.trim().toLowerCase() === 'delete me');
                });
                confirmBtn.addEventListener('click', async () => {
                    confirmBtn.disabled = true;
                    try {
                        if (this.currentWall === 'friend') {
                            await this.removeFriendEntry(entry.id);
                            // Optimistic local removal
                            if (Array.isArray(this.entriesCache.friend)) {
                                this.entriesCache.friend = this.entriesCache.friend.filter(e => e.id !== entry.id);
                                if (this.currentWall === 'friend') {
                                    this.entries = this.entriesCache.friend;
                                    this.renderEntries();
                                }
                            }
                        } else if (this.currentWall === 'tech') {
                            await this.removeTechNote(entry.id);
                            if (Array.isArray(this.entriesCache.tech)) {
                                this.entriesCache.tech = this.entriesCache.tech.filter(e => e.id !== entry.id);
                                if (this.currentWall === 'tech') {
                                    this.entries = this.entriesCache.tech;
                                    this.renderEntries();
                                }
                            }
                        } else if (this.currentWall === 'songs') {
                            await this.removeSongQuote(entry.id);
                            if (Array.isArray(this.entriesCache.songs)) {
                                this.entriesCache.songs = this.entriesCache.songs.filter(e => e.id !== entry.id);
                                if (this.currentWall === 'songs') {
                                    this.entries = this.entriesCache.songs;
                                    this.renderEntries();
                                }
                            }
                        } else if (this.currentWall === 'ideas') {
                            await this.removeProjectIdea(entry.id);
                            if (Array.isArray(this.entriesCache.ideas)) {
                                this.entriesCache.ideas = this.entriesCache.ideas.filter(e => e.id !== entry.id);
                                if (this.currentWall === 'ideas') {
                                    this.entries = this.entriesCache.ideas;
                                    this.renderEntries();
                                }
                            }
                        } else {
                            await this.removeEntry(entry.id);
                            if (Array.isArray(this.entriesCache.rishu)) {
                                this.entriesCache.rishu = this.entriesCache.rishu.filter(e => e.id !== entry.id);
                                if (this.currentWall === 'rishu') {
                                    this.entries = this.entriesCache.rishu;
                                    this.renderEntries();
                                }
                            }
                            if (Array.isArray(this.entriesCache.drafts)) {
                                this.entriesCache.drafts = this.entriesCache.drafts.filter(e => e.id !== entry.id);
                                if (this.currentWall === 'drafts') {
                                    this.entries = this.entriesCache.drafts;
                                    this.renderEntries();
                                }
                            }
                        }
                        this.closeModal();
                    } catch (e) {
                        alert('Failed to delete entry.');
                        confirmBtn.disabled = false;
                    }
                });

                container.appendChild(actions);
                container.appendChild(confirmWrap);
            } else {
                container.appendChild(actions);
            }
        }

        this.dom.modalBody.innerHTML = '';
        this.dom.modalBody.appendChild(container);
        this.openModal();
    }

    showIdeasEntryForm() {
        const form = document.createElement('form');
        form.className = 'entry-form';
        form.innerHTML = `
            <h3>New Project Idea</h3>
            <input type="text" id="entryTitle" placeholder="Title (optional)">
            <textarea id="entryText" placeholder="Describe your idea..." required></textarea>
            <div style="display:flex; gap:8px; align-items:center;">
                <button type="button" id="saveIdeaBtn" class="btn-liquid clear">Publish</button>
            </div>
        `;
        this.dom.modalBody.innerHTML = '';
        this.dom.modalBody.appendChild(form);
        this._modalContext = 'ideas-entry';
        this._activeForm = form;

        const saveBtn = form.querySelector('#saveIdeaBtn');
        saveBtn.addEventListener('click', async () => {
            const textarea = form.querySelector('#entryText');
            const titleEl = form.querySelector('#entryTitle');
            const text = (textarea.value || '').trim();
            const title = (titleEl && titleEl.value) ? titleEl.value : '';
            if (!text) { textarea.focus(); return; }
            try {
                const created = await this.saveProjectIdea(text, this.tempPassword, title);
                const cur = Array.isArray(this.entriesCache.ideas) ? this.entriesCache.ideas : [];
                this.entriesCache.ideas = [created, ...cur];
                if (this.currentWall === 'ideas') { this.entries = this.entriesCache.ideas; this.renderEntries(); }
                this.closeModal();
            } catch (e) {
                const msg = String(e && e.message) || '';
                if (/Ideas require DB migration/i.test(msg)) alert('Ideas require DB migration. Please run supabase db push.');
                else if (/Invalid password/i.test(msg)) { this.tempPassword = null; alert('Invalid password. Please try again.'); this.closeModal(); }
                else alert('Error saving project idea.');
            }
        });
        this.openModal();
        setTimeout(() => document.getElementById('entryTitle')?.focus(), 100);
    }

    showIdeasEditForm(entry) {
        const form = document.createElement('form');
        form.className = 'entry-form';
        form.innerHTML = `
            <h3>Edit Project Idea</h3>
            <input type="text" id="entryTitle" placeholder="Title (optional)" value="${(entry && entry.title) ? String(entry.title).replace(/&/g,'&amp;').replace(/\"/g,'&quot;') : ''}">
            <textarea id="entryText" placeholder="Describe your idea..." required></textarea>
            <div style="display:flex; gap:8px;">
                <button type="button" id="saveIdeaBtn" class="btn-liquid clear">Save</button>
            </div>
        `;
        this.dom.modalBody.innerHTML = '';
        this.dom.modalBody.appendChild(form);
        this._modalContext = 'ideas-edit';
        this._activeForm = form;
        const textarea = form.querySelector('#entryText');
        const titleInput = form.querySelector('#entryTitle');
        textarea.value = entry.text || '';
        const saveBtn = form.querySelector('#saveIdeaBtn');
        saveBtn.addEventListener('click', async () => {
            const text = (textarea.value || '').trim();
            const title = (titleInput && titleInput.value) ? titleInput.value : '';
            if (!text) { textarea.focus(); return; }
            try {
                await this.updateProjectIdea(entry.id, text, title);
                this.entriesCache.ideas = null;
                await this.loadEntries();
                this.closeModal();
            } catch (e) {
                alert('Error updating project idea.');
            }
        });
        this.openModal();
        setTimeout(() => titleInput?.focus(), 100);
    }

    async saveProjectIdea(text, password, title = null) {
        const response = await fetch('/api/project-ideas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, password, title: (typeof title === 'string' && title.trim() && title.trim() !== '(optional)') ? title.trim() : undefined })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || 'Error');
        return result.data;
    }

    async updateProjectIdea(id, text, title = null) {
        const response = await fetch('/api/update-project-idea', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, text, title: (typeof title === 'string' && title.trim() && title.trim() !== '(optional)') ? title.trim() : undefined, password: this.tempPassword })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || 'Error');
        return result.data;
    }

    async removeProjectIdea(id) {
        const response = await fetch('/api/delete-project-idea', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, password: this.tempPassword })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || 'Error');
        return result.ok;
    }

    showPasswordForm() {
        const form = document.createElement('form');
        form.className = 'password-form';
        form.innerHTML = `
            <h3>Enter Password</h3>
            <input type="password" id="passwordInput" placeholder="Password" required autocomplete="current-password">
            <div id="passwordError" class="error"></div>
            <button type="submit" class="btn-liquid clear">Submit</button>
        `;

        this.dom.modalBody.innerHTML = '';
        this.dom.modalBody.appendChild(form);

        form.addEventListener('submit', (e) => this.handlePasswordSubmit(e));

        this.openModal();

        // Focus password input
        setTimeout(() => {
            document.getElementById('passwordInput')?.focus();
        }, 100);
    }

    handlePasswordSubmit(e) {
        e.preventDefault();

        const form = e.target;
        if (form.classList.contains('is-submitting')) return;

        const input = document.getElementById('passwordInput');
        const errorEl = document.getElementById('passwordError');
        const submitBtn = form.querySelector('#publishBtn');

        const pwd = (input.value || '').trim();
        errorEl.textContent = '';

        if (!pwd) {
            input.value = '';
            input.focus();
            return;
        }

        form.classList.add('is-submitting');
        if (submitBtn) submitBtn.disabled = true;

        // Verify password before showing entry form
        fetch('/api/verify-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: pwd })
        })
        .then(async (resp) => {
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok) throw new Error(data.error || 'Invalid password');
            // Success: store temp, persist auth, and proceed to entry form
            this.tempPassword = pwd;
            this.isAuthenticated = true;
            this.saveAuthState();
            this.updateAuthUI();
            // Open the appropriate form for the current wall
            if (this.currentWall === 'tech') this.showTechEntryForm();
            else this.showEntryForm();
        })
        .catch((err) => {
            errorEl.textContent = 'Invalid password. Please try again.';
            input.value = '';
            input.focus();
        })
        .finally(() => {
            if (submitBtn) submitBtn.disabled = false;
            form.classList.remove('is-submitting');
        });
    }

    showEntryForm() {
        const form = document.createElement('form');
        form.className = 'entry-form';
        form.innerHTML = `
            <h3>New Entry</h3>
            <input type="text" id="entryTitle" placeholder="Title (optional)">
            <textarea id="entryText" placeholder="Write your entry..." required></textarea>
            <div style="display:flex; gap:8px; align-items:center;">
                <button type="submit" id="publishBtn" class="btn-liquid clear">Publish</button>
                ${this.currentWall === 'drafts' ? `<select id="publishTarget" class="select-liquid" style="margin-left:8px;"><option value="rishu">rishu's wall</option><option value="tech">tech notes</option></select>` : ''}
                <button type="button" id="saveDraftBtn" class="btn-liquid clear">Save Draft</button>
            </div>
        `;

        this.dom.modalBody.innerHTML = '';
        this.dom.modalBody.appendChild(form);

        // Track modal state for backdrop autosave logic
        this._modalContext = 'new-entry';
        this._activeForm = form;

        // native placeholder handles optional UX for title

        form.addEventListener('submit', (e) => this.handleEntrySubmit(e));
        const saveDraftBtn = form.querySelector('#saveDraftBtn');
        if (saveDraftBtn) {
            saveDraftBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                const textarea = form.querySelector('#entryText');
                const titleEl = form.querySelector('#entryTitle');
                const text = (textarea.value || '').trim();
                const title = (titleEl && titleEl.value) ? titleEl.value : '';
                if (!text) {
                    textarea.value = '';
                    textarea.focus();
                    return;
                }
                try {
                    const created = await this.saveEntry(text, this.tempPassword, 'draft', title);
                    // Optimistically update drafts cache/UI
                    const next = [created, ...(Array.isArray(this.entriesCache.drafts) ? this.entriesCache.drafts : [])];
                    this.entriesCache.drafts = next;
                    if (this.currentWall === 'drafts') {
                        this.entries = next;
                        this.renderEntries();
                    }
                    this.closeModal();
                } catch (error) {
                    if (String(error && error.message) === 'Invalid password') {
                        this.tempPassword = null;
                        alert('Invalid password. Please try again.');
                        this.closeModal();
                    } else {
                        alert('Error saving draft. Please try again.');
                    }
                }
            });
        }

        this.openModal();

        // Focus title first
        setTimeout(() => {
            document.getElementById('entryTitle')?.focus();
        }, 100);
    }

    async handleModalBackdropClick() {
        // Autosave for any text-entry modal if authenticated
        if (this.isAuthenticated && this._activeForm) {
            const eligibleContexts = new Set([
                'new-entry',
                'friend-entry',
                'tech-entry',
                'songs-entry',
                'edit-entry',
                'tech-edit',
                'songs-edit',
                'ideas-entry',
                'ideas-edit',
            ]);
            if (eligibleContexts.has(this._modalContext)) {
                try {
                    const form = this._activeForm;
                    const textarea = form.querySelector('#entryText');
                    const titleEl = form.querySelector('#entryTitle');
                    const text = (textarea && textarea.value ? textarea.value : '').trim();
                    const title = (titleEl && titleEl.value) ? titleEl.value : '';
                    if (text) {
                        const created = await this.saveEntry(text, this.tempPassword, 'draft', title);
                        const next = [created, ...(Array.isArray(this.entriesCache.drafts) ? this.entriesCache.drafts : [])];
                        this.entriesCache.drafts = next;
                        if (this.currentWall === 'drafts') {
                            this.entries = next;
                            this.renderEntries();
                        }
                        this.closeModal();
                        return;
                    }
                } catch (_) {
                    // Silent fail; still close the modal
                }
            }
        }
        this.closeModal();
    }

    showFriendEntryForm() {
        const form = document.createElement('form');
        form.className = 'entry-form';
        form.innerHTML = `
            <h3>New Entry</h3>
            <input type="text" id="entryName" placeholder="Your name" required>
            <input type="text" id="entryTitle" placeholder="Title (optional)">
            <textarea id="entryText" placeholder="Write your entry..." required></textarea>
            <button type="submit" class="btn-liquid clear">Add to Wall</button>
        `;

        this.dom.modalBody.innerHTML = '';
        this.dom.modalBody.appendChild(form);

        // native placeholder handles optional UX for title

        // Track modal state
        this._modalContext = 'friend-entry';
        this._activeForm = form;

        form.addEventListener('submit', (e) => this.handleFriendEntrySubmit(e));

        this.openModal();

        // Focus name input
        setTimeout(() => {
            document.getElementById('entryName')?.focus();
        }, 100);
    }

    showSongsEntryForm() {
        const form = document.createElement('form');
        form.className = 'entry-form';
        form.innerHTML = `
            <h3>New Song Quote</h3>
            <input type="text" id="entryTitle" placeholder="Song / Artist (optional)">
            <textarea id="entryText" placeholder="Paste a lyric or quote..." required></textarea>
            <input type="url" id="spotifyUrl" placeholder="Spotify track/album URL (optional)">
            <div style="display:flex; gap:8px; align-items:center;">
                <button type="button" id="saveSongBtn" class="btn-liquid clear">Publish</button>
            </div>
        `;
        this.dom.modalBody.innerHTML = '';
        this.dom.modalBody.appendChild(form);
        this._modalContext = 'songs-entry';
        this._activeForm = form;
        const saveBtn = form.querySelector('#saveSongBtn');
        saveBtn.addEventListener('click', async () => {
            const textarea = form.querySelector('#entryText');
            const titleEl = form.querySelector('#entryTitle');
            const spotEl = form.querySelector('#spotifyUrl');
            const text = (textarea.value || '').trim();
            const title = (titleEl && titleEl.value) ? titleEl.value : '';
            const spotify_url = (spotEl && spotEl.value) ? spotEl.value.trim() : '';
            if (!text) { textarea.focus(); return; }
            try {
                const created = await this.saveSongQuote(text, this.tempPassword, title, spotify_url);
                const cur = Array.isArray(this.entriesCache.songs) ? this.entriesCache.songs : [];
                this.entriesCache.songs = [created, ...cur];
                if (this.currentWall === 'songs') { this.entries = this.entriesCache.songs; this.renderEntries(); }
                this.closeModal();
            } catch (e) {
                const msg = String(e && e.message) || '';
                if (/Song quotes require DB migration/i.test(msg)) alert('Song quotes require DB migration. Please run supabase db push.');
                else if (/Invalid password/i.test(msg)) { this.tempPassword = null; alert('Invalid password. Please try again.'); this.closeModal(); }
                else alert('Error saving song quote.');
            }
        });
        this.openModal();
        setTimeout(() => document.getElementById('entryTitle')?.focus(), 100);
    }

    showEditForm(entry) {
        const form = document.createElement('form');
        form.className = 'entry-form';
        form.innerHTML = `
            <h3>Edit Entry</h3>
            <input type="text" id="entryTitle" placeholder="Title (optional)" value="${(entry && entry.title) ? String(entry.title).replace(/&/g,'&amp;').replace(/"/g,'&quot;') : ''}">
            <textarea id="entryText" placeholder="Write your entry..." required></textarea>
            <div style="display:flex; gap:8px; align-items:center;">
                <button type="button" id="publishBtn" class="btn-liquid clear">Publish</button>
                ${this.currentWall === 'drafts' ? `<select id="publishTarget" style="margin-left:8px;"><option value="rishu">rishu's wall</option><option value="tech">tech notes</option></select>` : ''}
                <button type="button" id="saveDraftBtn" class="btn-liquid clear">Save Draft</button>
                <button type="button" id="deleteBtn" class="btn-liquid clear" style="margin-left:auto;">Delete</button>
            </div>
        `;

        this.dom.modalBody.innerHTML = '';
        this.dom.modalBody.appendChild(form);

        this._modalContext = 'edit-entry';
        this._activeForm = form;

        const textarea = form.querySelector('#entryText');
        const titleInput = form.querySelector('#entryTitle');
        textarea.value = entry.text || '';
        // native placeholder handles optional UX for title

        const publishBtn = form.querySelector('#publishBtn');
        const saveDraftBtn = form.querySelector('#saveDraftBtn');

        const doUpdate = async (vis) => {
            const text = (textarea.value || '').trim();
            const title = (titleInput && titleInput.value) ? titleInput.value : '';
            if (!text) { textarea.focus(); return; }
            try {
                if (vis === 'public' && this.currentWall === 'drafts') {
                    const target = (form.querySelector('#publishTarget')?.value) || 'rishu';
                    if (target === 'tech') {
                        await this.saveTechNote(text, this.tempPassword, title);
                        await this.removeEntry(entry.id);
                    } else {
                        await this.updateEntry(entry.id, text, 'public', title);
                    }
                } else {
                    await this.updateEntry(entry.id, text, vis, title);
                }
                this.entriesCache.rishu = null;
                this.entriesCache.drafts = null;
                this.entriesCache.tech = null;
                await this.loadEntries();
                this.closeModal();
            } catch (e) {
                const msg = String(e && e.message) || 'Error';
                if (/Drafts require DB migration/i.test(msg)) {
                    alert('Drafts require DB migration. Please run supabase db push.');
                } else {
                    alert(/Invalid password/i.test(msg) ? 'Invalid password. Please try again.' : 'Error updating entry.');
                }
            }
        };

        publishBtn.addEventListener('click', () => doUpdate('public'));
        saveDraftBtn.addEventListener('click', () => doUpdate('draft'));

        // Delete flow with confirm text
        const deleteBtn = form.querySelector('#deleteBtn');
        const confirmWrap = document.createElement('div');
        confirmWrap.className = 'delete-confirm';
        confirmWrap.style.display = 'none';
        confirmWrap.innerHTML = `
            <small>Type "delete me" to confirm deletion</small>
            <div class="confirm-row">
              <input type="text" class="confirm-input" placeholder="delete me" />
              <button type="button" class="btn-liquid clear confirm-btn" disabled>Confirm</button>
            </div>
        `;
        form.appendChild(confirmWrap);
        deleteBtn.addEventListener('click', () => {
            confirmWrap.style.display = confirmWrap.style.display === 'none' ? 'flex' : 'none';
        });
        const cInput = confirmWrap.querySelector('.confirm-input');
        const cBtn = confirmWrap.querySelector('.confirm-btn');
        cInput.addEventListener('input', () => {
            cBtn.disabled = !(cInput.value.trim().toLowerCase() === 'delete me');
        });
        cBtn.addEventListener('click', async () => {
            cBtn.disabled = true;
            try {
                await this.removeEntry(entry.id);
                this.entriesCache.rishu = null;
                this.entriesCache.drafts = null;
                await this.loadEntries();
                this.closeModal();
            } catch (e) {
                alert('Failed to delete entry.');
                cBtn.disabled = false;
            }
        });

        this.openModal();
        setTimeout(() => titleInput?.focus(), 100);
    }

    async updateEntry(id, text, visibility, title = null) {
        const response = await fetch('/api/update-entry', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, text, visibility, title: (typeof title === 'string' && title.trim() && title.trim() !== '(optional)') ? title.trim() : undefined, password: this.tempPassword })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || 'Error');
        return result.data;
    }

    async removeEntry(id) {
        const response = await fetch('/api/delete-entry', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, password: this.tempPassword })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || 'Error');
        return result.ok;
    }

    async removeFriendEntry(id) {
        const response = await fetch('/api/delete-friend-entry', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, password: this.tempPassword })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || 'Error');
        return result.ok;
    }

    showTechEntryForm() {
        const form = document.createElement('form');
        form.className = 'entry-form';
        form.innerHTML = `
            <h3>New Tech Note</h3>
            <input type="text" id="entryTitle" placeholder="Title (optional)">
            <textarea id=\"entryText\" placeholder=\"Write your note...\" required></textarea>
            <button type=\"submit\" id=\"techSubmitBtn\" class=\"btn-liquid clear\">Save</button>
        `;

        this.dom.modalBody.innerHTML = '';
        this.dom.modalBody.appendChild(form);

        this._modalContext = 'tech-entry';
        this._activeForm = form;

        const titleInput = form.querySelector('#entryTitle');
        this.attachOptionalTitleBehavior(titleInput);

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const formEl = e.target;
            if (formEl.classList.contains('is-submitting')) return;
            formEl.classList.add('is-submitting');
            const submitBtn = formEl.querySelector('#techSubmitBtn');
            if (submitBtn) submitBtn.disabled = true;

            const textarea = formEl.querySelector('#entryText');
            const titleEl = formEl.querySelector('#entryTitle');
            const text = (textarea.value || '').trim();
            const title = (titleEl && titleEl.value) ? titleEl.value : '';
            if (!text) { textarea.focus(); return; }

            // Optimistic insert
            const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
            const temp = { id: tempId, text, title: (title && title.trim()) ? title.trim() : undefined, timestamp: new Date().toISOString() };
            const cur = Array.isArray(this.entriesCache.tech) ? this.entriesCache.tech : [];
            this.entriesCache.tech = [temp, ...cur];
            if (this.currentWall === 'tech') {
                this.entries = this.entriesCache.tech;
                this.renderEntries();
            }
            this.closeModal();

            this.saveTechNote(text, this.tempPassword, title)
                .then((created) => {
                    const list = Array.isArray(this.entriesCache.tech) ? this.entriesCache.tech : [];
                    const idx = list.findIndex(e => e.id === tempId);
                    if (idx !== -1) {
                        this.entriesCache.tech = [created, ...list.slice(idx+1)];
                        if (this.currentWall === 'tech') {
                            this.entries = this.entriesCache.tech;
                            this.renderEntries();
                        }
                    }
                })
                .catch((error) => {
                    const msg = String(error && error.message) || '';
                    // Rollback temp
                    this.entriesCache.tech = (this.entriesCache.tech || []).filter(e => e.id !== tempId);
                    if (this.currentWall === 'tech') {
                        this.entries = this.entriesCache.tech;
                        this.renderEntries();
                    }
                    if (msg === 'Invalid password') {
                        this.tempPassword = null;
                        alert('Invalid password. Please try again.');
                    } else if (/Tech notes require DB migration/i.test(msg)) {
                        alert('Tech notes require DB migration. Please run supabase db push.');
                    } else {
                        alert(msg ? `Error saving note: ${msg}` : 'Error saving note. Please try again.');
                    }
                })
                .finally(() => {
                    if (submitBtn) submitBtn.disabled = false;
                    formEl.classList.remove('is-submitting');
                });
        });

        this.openModal();
        setTimeout(() => document.getElementById('entryTitle')?.focus(), 100);
    }

    showTechEditForm(entry) {
        const form = document.createElement('form');
        form.className = 'entry-form';
        form.innerHTML = `
            <h3>Edit Tech Note</h3>
            <input type="text" id="entryTitle" placeholder="Title (optional)" value="${(entry && entry.title) ? String(entry.title).replace(/&/g,'&amp;').replace(/\"/g,'&quot;') : ''}">
            <textarea id="entryText" placeholder="Write your note..." required></textarea>
            <div style="display:flex; gap:8px;">
                <button type="button" id="saveTechBtn" class="btn-liquid clear">Save</button>
            </div>
        `;
        this.dom.modalBody.innerHTML = '';
        this.dom.modalBody.appendChild(form);
        this._modalContext = 'tech-edit';
        this._activeForm = form;
        const textarea = form.querySelector('#entryText');
        const titleInput = form.querySelector('#entryTitle');
        textarea.value = entry.text || '';
        const saveBtn = form.querySelector('#saveTechBtn');
        saveBtn.addEventListener('click', async () => {
            const text = (textarea.value || '').trim();
            const title = (titleInput && titleInput.value) ? titleInput.value : '';
            if (!text) { textarea.focus(); return; }
            try {
                await this.updateTechNote(entry.id, text, title);
                this.entriesCache.tech = null;
                await this.loadEntries();
                this.closeModal();
            } catch (e) {
                alert('Error updating tech note.');
            }
        });
        this.openModal();
        setTimeout(() => titleInput?.focus(), 100);
    }

    showSongsEditForm(entry) {
        const form = document.createElement('form');
        form.className = 'entry-form';
        form.innerHTML = `
            <h3>Edit Song Quote</h3>
            <input type="text" id="entryTitle" placeholder="Song / Artist (optional)" value="${(entry && entry.title) ? String(entry.title).replace(/&/g,'&amp;').replace(/\"/g,'&quot;') : ''}">
            <textarea id="entryText" placeholder="Write your note..." required></textarea>
            <input type="url" id="spotifyUrl" placeholder="Spotify track/album URL (optional)" value="${entry && entry.spotify_url ? String(entry.spotify_url).replace(/&/g,'&amp;').replace(/\"/g,'&quot;') : ''}">
            <div style="display:flex; gap:8px;">
                <button type="button" id="saveSongBtn" class="btn-liquid clear">Save</button>
            </div>
        `;
        this.dom.modalBody.innerHTML = '';
        this.dom.modalBody.appendChild(form);
        this._modalContext = 'songs-edit';
        this._activeForm = form;
        const textarea = form.querySelector('#entryText');
        const titleInput = form.querySelector('#entryTitle');
        const spotInput = form.querySelector('#spotifyUrl');
        textarea.value = entry.text || '';
        const saveBtn = form.querySelector('#saveSongBtn');
        saveBtn.addEventListener('click', async () => {
            const text = (textarea.value || '').trim();
            const title = (titleInput && titleInput.value) ? titleInput.value : '';
            const spotify_url = (spotInput && spotInput.value) ? spotInput.value.trim() : '';
            if (!text) { textarea.focus(); return; }
            try {
                await this.updateSongQuote(entry.id, text, title, spotify_url);
                this.entriesCache.songs = null;
                await this.loadEntries();
                this.closeModal();
            } catch (e) {
                alert('Error updating song quote.');
            }
        });
        this.openModal();
        setTimeout(() => titleInput?.focus(), 100);
    }

    async updateTechNote(id, text, title = null) {
        const response = await fetch('/api/update-tech-note', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, text, title: (typeof title === 'string' && title.trim() && title.trim() !== '(optional)') ? title.trim() : undefined, password: this.tempPassword })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || 'Error');
        return result.data;
    }

    async saveTechNote(text, password, title = null) {
        const response = await fetch('/api/tech-notes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, password, title: (typeof title === 'string' && title.trim() && title.trim() !== '(optional)') ? title.trim() : undefined })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || 'Error');
        return result.data;
    }

    // Helper: optional title input UX
    attachOptionalTitleBehavior(input) {
        if (!input) return;
        const OPTIONAL = '(optional)';
        if (!input.value || !input.value.trim()) input.value = OPTIONAL;
        input.addEventListener('focus', () => {
            if (input.value.trim() === OPTIONAL) input.value = '';
        });
        input.addEventListener('input', () => {
            if (input.value.trim() === OPTIONAL) input.value = '';
        });
        input.addEventListener('blur', () => {
            if (!input.value.trim()) input.value = OPTIONAL;
        });
    }

    async removeTechNote(id) {
        const response = await fetch('/api/delete-tech-note', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, password: this.tempPassword })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || 'Error');
        return result.ok;
    }

    async createShortLink(entryId, type = 'rishu', longUrl = null) {
        const response = await fetch('/api/shorten', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(longUrl ? { longUrl } : { entryId, type, password: this.tempPassword })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || 'Error');
        return result;
    }

    showShareLoading() {
        const wrap = document.createElement('div');
        wrap.className = 'share-loading';
        wrap.innerHTML = `
            <div class="spinner" aria-hidden="true"></div>
            <div>Generating link…</div>
        `;
        this.dom.modalBody.innerHTML = '';
        this.dom.modalBody.appendChild(wrap);
        this.openModal();
    }

    showShareModal(shortUrl) {
        const wrap = document.createElement('div');
        wrap.className = 'entry-form share-box';
        wrap.innerHTML = `
            <h3>Share Link</h3>
            <input id="shareLinkInput" type="text" readonly value="${this.escapeHtml(shortUrl)}" />
            <div style="display:flex; gap:8px;">
                <button type="button" id="copyShareBtn" class="btn-liquid clear">Copy</button>
                <a id="openShareBtn" class="btn-like btn-liquid clear" href="${this.escapeHtml(shortUrl)}" target="_blank" rel="noopener noreferrer">Open</a>
            </div>
        `;
        this.dom.modalBody.innerHTML = '';
        this.dom.modalBody.appendChild(wrap);
        this.openModal();

        const input = wrap.querySelector('#shareLinkInput');
        const copyBtn = wrap.querySelector('#copyShareBtn');
        // Auto-select for convenience
        setTimeout(() => { try { input.select(); } catch(_){} }, 50);

        const copyFn = async () => {
            const val = input.value;
            try {
                await navigator.clipboard.writeText(val);
                copyBtn.textContent = 'Copied!';
                setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
            } catch (_) {
                // Fallback: execCommand
                try {
                    input.select();
                    document.execCommand('copy');
                    copyBtn.textContent = 'Copied!';
                    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
                } catch (e) {
                    alert('Copy failed. Select the text and press Cmd/Ctrl+C.');
                }
            }
        };
        copyBtn.addEventListener('click', copyFn);
    }

    showShareError(message) {
        const wrap = document.createElement('div');
        wrap.className = 'entry-form share-box';
        wrap.innerHTML = `
            <h3>Share Link</h3>
            <div class="error">${this.escapeHtml(message)}</div>
            <div style="display:flex; gap:8px;">
                <button type="button" id="retryShareBtn" class="btn-liquid clear">Try Again</button>
                <button type="button" id="closeShareBtn" class="btn-liquid clear">Close</button>
            </div>
        `;
        this.dom.modalBody.innerHTML = '';
        this.dom.modalBody.appendChild(wrap);
        this.openModal();
        const retry = wrap.querySelector('#retryShareBtn');
        const close = wrap.querySelector('#closeShareBtn');
        retry.addEventListener('click', () => {
            // Replace with loading; caller will re-initiate share by clicking the icon again
            this.showShareLoading();
        });
        close.addEventListener('click', () => this.closeModal());
    }

    async handleEntrySubmit(e) {
        e.preventDefault();

        const form = e.target;
        if (form.classList.contains('is-submitting')) return;

        const textarea = form.querySelector('#entryText');
        const titleEl = form.querySelector('#entryTitle');
        const submitBtn = form.querySelector('button[type="submit"]');
        const text = textarea.value.trim();
        const title = titleEl && titleEl.value ? titleEl.value : '';

        // Prevent empty/whitespace-only submissions
        if (!text) {
            textarea.value = '';
            textarea.focus();
            return;
        }

        // Immediately clear and prevent double submit
        textarea.value = '';
        if (submitBtn) submitBtn.disabled = true;
        form.classList.add('is-submitting');

        // Determine publish target (drafts page can choose)
        const targetSel = form.querySelector('#publishTarget');
        const target = (this.currentWall === 'drafts' && targetSel) ? (targetSel.value || 'rishu') : 'rishu';

        if (target === 'tech') {
            // Submit to tech notes
            this.closeModal();
            this.saveTechNote(text, this.tempPassword, title)
                .then((created) => {
                    // Update tech cache optimistically after success (no temp)
                    const list = Array.isArray(this.entriesCache.tech) ? this.entriesCache.tech : [];
                    this.entriesCache.tech = [created, ...list];
                    if (this.currentWall === 'tech') {
                        this.entries = this.entriesCache.tech;
                        this.renderEntries();
                    }
                })
                .catch((error) => {
                    const msg = String(error && error.message) || '';
                    if (msg === 'Invalid password') {
                        this.tempPassword = null;
                        alert('Invalid password. Please try again.');
                    } else if (/Tech notes require DB migration/i.test(msg)) {
                        alert('Tech notes require DB migration. Please run supabase db push.');
                    } else {
                        alert('Error saving note. Please try again.');
                    }
                })
                .finally(() => {
                    if (submitBtn) submitBtn.disabled = false;
                    form.classList.remove('is-submitting');
                });
            return;
        }

        // Default: publish to rishu's wall
        // Optimistic insert into UI/cache and close modal immediately
        const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
        const tempEntry = {
            id: tempId,
            text,
            title: (title && title.trim()) ? title.trim() : undefined,
            timestamp: new Date().toISOString(),
            is_pinned: false,
            pin_order: null,
            visibility: 'public'
        };
        const current = Array.isArray(this.entriesCache.rishu) ? this.entriesCache.rishu : [];
        this.entriesCache.rishu = [tempEntry, ...current];
        if (this.currentWall === 'rishu') {
            this.entries = this.entriesCache.rishu;
            this.renderEntries();
        }
        this.closeModal();

        // Persist to server; reconcile temp with real id
        this.saveEntry(text, this.tempPassword, 'public', title)
            .then((created) => {
                const list = Array.isArray(this.entriesCache.rishu) ? this.entriesCache.rishu : [];
                const idx = list.findIndex(e => e.id === tempId);
                if (idx !== -1) {
                    this.entriesCache.rishu = [created, ...list.slice(idx+1)];
                    if (this.currentWall === 'rishu') {
                        this.entries = this.entriesCache.rishu;
                        this.renderEntries();
                    }
                } else {
                    // If not found, prepend created
                    this.entriesCache.rishu = [created, ...list];
                }
            })
            .catch((error) => {
                // Remove temp and notify
                const list = Array.isArray(this.entriesCache.rishu) ? this.entriesCache.rishu : [];
                this.entriesCache.rishu = list.filter(e => e.id !== tempId);
                if (this.currentWall === 'rishu') {
                    this.entries = this.entriesCache.rishu;
                    this.renderEntries();
                }
                if (String(error && error.message) === 'Invalid password') {
                    this.tempPassword = null;
                    alert('Invalid password. Please try again.');
                } else {
                    alert('Error saving entry. Please try again.');
                }
            })
            .finally(() => {
                if (submitBtn) submitBtn.disabled = false;
                form.classList.remove('is-submitting');
            });
    }

    async handleFriendEntrySubmit(e) {
        e.preventDefault();

        const form = e.target;
        if (form.classList.contains('is-submitting')) return;

        const nameInput = form.querySelector('#entryName');
        const textarea = form.querySelector('#entryText');
        const titleEl = form.querySelector('#entryTitle');
        const submitBtn = form.querySelector('button[type="submit"]');

        const name = nameInput.value.trim();
        const text = textarea.value.trim();
        const title = titleEl && titleEl.value ? titleEl.value : '';

        // Prevent empty/whitespace-only submissions
        if (!name || !text) {
            if (!name) nameInput.focus();
            else textarea.focus();
            return;
        }

        // Immediately clear and prevent double submit
        nameInput.value = '';
        textarea.value = '';
        if (titleEl) titleEl.value = '';
        if (submitBtn) submitBtn.disabled = true;
        form.classList.add('is-submitting');

        // Optimistic insert to UI and close modal immediately
        const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
        const temp = { id: tempId, name, text, title: (title && title.trim()) ? title.trim() : undefined, timestamp: new Date().toISOString() };
        const cur = Array.isArray(this.entriesCache.friend) ? this.entriesCache.friend : [];
        this.entriesCache.friend = [temp, ...cur];
        if (this.currentWall === 'friend') {
            this.entries = this.entriesCache.friend;
            this.renderEntries();
        }
        this.closeModal();

        this.saveFriendEntry(text, name, title)
            .then((created) => {
                const list = Array.isArray(this.entriesCache.friend) ? this.entriesCache.friend : [];
                const idx = list.findIndex(e => e.id === tempId);
                if (idx !== -1) {
                    this.entriesCache.friend = [created, ...list.slice(idx+1)];
                    if (this.currentWall === 'friend') {
                        this.entries = this.entriesCache.friend;
                        this.renderEntries();
                    }
                }
            })
            .catch((error) => {
                const msg = String(error && error.message || '');
                // Roll back only if not 404 (already deleted)
                if (!(error && error.status === 404)) {
                    this.entriesCache.friend = (this.entriesCache.friend || []).filter(e => e.id !== tempId);
                    if (this.currentWall === 'friend') {
                        this.entries = this.entriesCache.friend;
                        this.renderEntries();
                    }
                }
                if (error && error.analysis) {
                    // Build a message with category scores vs thresholds
                    const th = error.thresholds || {};
                    const parts = [];
                    error.analysis.forEach((a) => {
                        if (!a) return;
                        const rows = [];
                        (a.tripped || []).forEach((k) => {
                            const sc = (a.scores && typeof a.scores[k] === 'number') ? a.scores[k] : 0;
                            const t = typeof th[k] === 'number' ? th[k] : 0;
                            rows.push(`${k}: score ${sc.toFixed(3)} > threshold ${t.toFixed(3)}`);
                        });
                        if (rows.length) parts.push(`${a.input || 'text'} — ${rows.join(', ')}`);
                    });
                    const detail = parts.length ? `Blocked by moderation — ${parts.join(' | ')}` : 'Blocked by moderation.';
                    alert(detail);
                } else if (error && error.status === 401) {
                    alert('Invalid password. Please try again.');
                } else if (error && error.status === 404) {
                    // Already deleted; keep UI state as-is
                } else if (/inappropriate/i.test(msg)) {
                    alert('Your entry was blocked due to inappropriate language (in the message or name). Please edit and try again.');
                } else {
                    alert('Error saving entry. Please try again.');
                }
            })
            .finally(() => {
                if (submitBtn) submitBtn.disabled = false;
                form.classList.remove('is-submitting');
            });
    }

    async saveFriendEntry(text, name, title = null) {
        try {
            const response = await fetch('/api/friend-entries', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    text: text,
                    name: name,
                    title: (typeof title === 'string' && title.trim() && title.trim() !== '(optional)') ? title.trim() : undefined
                })
            });

            const result = await response.json().catch(() => ({}));

            if (!response.ok) {
                const err = new Error(result && result.error || 'Error');
                if (result && result.analysis) err.analysis = result.analysis;
                if (result && result.thresholds) err.thresholds = result.thresholds;
                throw err;
            }

            return result.data;
        } catch (error) {
            console.error('Error saving friend entry:', error);
            throw error;
        }
    }

    toggleWall() {
        // Navigate via hash so refresh preserves selection
        if (this.currentWall === 'rishu') {
            location.hash = '#friends';
        } else {
            location.hash = '#rishu';
        }
    }

    // organize mode removed; auth-gated inline actions

    promptForPassword() {
        return new Promise((resolve, reject) => {
            const form = document.createElement('form');
            form.className = 'password-form';
            form.innerHTML = `
                <h3>Enter Password</h3>
                <input type="password" id="passwordInput" placeholder="Password" required autocomplete="current-password">
                <div id="passwordError" class="error"></div>
                <button type="submit" class="btn-liquid clear">Submit</button>
            `;
            this.dom.modalBody.innerHTML = '';
            this.dom.modalBody.appendChild(form);
            this.openModal();

            setTimeout(() => {
                document.getElementById('passwordInput')?.focus();
            }, 50);

            const onSubmit = async (e) => {
                e.preventDefault();
                const input = document.getElementById('passwordInput');
                const errorEl = document.getElementById('passwordError');
                const pwd = (input.value || '').trim();
                errorEl.textContent = '';
                if (!pwd) return;
                try {
                    const resp = await fetch('/api/verify-password', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ password: pwd })
                    });
                    const data = await resp.json().catch(() => ({}));
                    if (!resp.ok) throw new Error(data.error || 'Invalid password');
                    this.tempPassword = pwd;
                    this.isAuthenticated = true;
                    this.saveAuthState();
                    this.updateAuthUI();
                    this.closeModal();
                    resolve();
                } catch (err) {
                    errorEl.textContent = 'Invalid password. Please try again.';
                    input.value = '';
                    input.focus();
                }
            };
            form.addEventListener('submit', onSubmit, { once: true });
        });
    }

    async togglePin(entry) {
        if (!this.isAuthenticated) {
            try {
                await this.promptForPassword();
            } catch (_) {
                return; // cancelled
            }
        }
        const willPin = !entry.is_pinned;

        // Optimistic local update
        const prev = { is_pinned: entry.is_pinned, pin_order: entry.pin_order };
        if (willPin) {
            const maxOrder = Math.max(-1, ...this.entries.filter(e => e.is_pinned).map(e => e.pin_order ?? -1));
            entry.is_pinned = true;
            entry.pin_order = maxOrder + 1;
        } else {
            entry.is_pinned = false;
            entry.pin_order = null;
        }
        // Update caches and rerender immediately
        if (this.currentWall === 'rishu') {
            this.entriesCache.rishu = this.entries;
        }
        this.renderEntries();

        try {
            await this.pinEntry(entry.id, willPin);
        } catch (e) {
            // Revert on failure
            entry.is_pinned = prev.is_pinned;
            entry.pin_order = prev.pin_order;
            if (this.currentWall === 'rishu') this.entriesCache.rishu = this.entries;
            this.renderEntries();
            alert('Failed to update pin.');
        }
    }

    async pinEntry(id, pin) {
        const response = await fetch('/api/pin-entry', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, pin, password: this.tempPassword })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Error');
        return result.ok;
    }

    async savePinnedOrder(idList) {
        const response = await fetch('/api/reorder-pins', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderedIds: idList, password: this.tempPassword })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Error');
        return result.ok;
    }

    // HTML5 DnD handlers are no longer used
    onDragStart(e) {}

    onDragEnd(e) {}

    onDragOver(e) {}

    onDrop(e) {
        e.preventDefault();
        // Order persisted in onDragEnd
    }

    getDragAfterElement(y) {
        const draggableElements = [...this.dom.wall.querySelectorAll('.entry.pinned:not(.dragging)')];
        return draggableElements.reduce((closest, child) => {
            const box = child.getBoundingClientRect();
            const offset = y - box.top - box.height / 2;
            if (offset < 0 && offset > closest.offset) {
                return { offset, element: child };
            } else {
                return closest;
            }
        }, { offset: Number.NEGATIVE_INFINITY }).element;
    }

    openPendingEntry() {
        const id = this._pendingEntryId;
        this._pendingEntryId = null;
        if (!id) return;
        const entry = (this.entries || []).find(e => String(e.id) === String(id));
        if (!entry) return;
        if (this.currentWall === 'drafts' && this.isAuthenticated) {
            this.showEditForm(entry);
        } else {
            this.showEntry(entry);
        }
    }

    createTransparentDragImage() {
        try {
            const c = document.createElement('canvas');
            c.width = 1; c.height = 1;
            const ctx = c.getContext('2d');
            ctx.clearRect(0, 0, 1, 1);
            return c;
        } catch (_) {
            return null;
        }
    }

    // Custom mouse/touch drag for pinned rows
    onMouseDownDrag(e, el) {
        if (this.currentWall !== 'rishu') return;
        // left button only
        if (e.button !== undefined && e.button !== 0) return;
        // Ignore drags starting on the pin button
        if (e.target && e.target.closest && e.target.closest('.pin-btn')) return;
        // If not authenticated, do not allow drag and do not prompt;
        // allow the normal click to proceed.
        if (!this.isAuthenticated) return;
        // Do not preventDefault here; wait to see if it becomes a drag
        this._dragIntent = {
            type: 'mouse',
            el,
            startX: e.clientX,
            startY: e.clientY,
            started: false
        };
        document.addEventListener('mousemove', this.onMouseMoveMaybeStart, { passive: true });
        document.addEventListener('mouseup', this.onMouseUpMaybeStart, { once: true });
    }

    onTouchStartDrag(e, el) {
        if (this.currentWall !== 'rishu') return;
        if (e.target && e.target.closest && e.target.closest('.pin-btn')) return;
        if (!this.isAuthenticated) return; // do not allow drag or prompt; treat as normal tap
        if (e.touches && e.touches.length > 0) {
            // Do not preventDefault yet; wait to see if it becomes a drag
            const t = e.touches[0];
            this._dragIntent = {
                type: 'touch',
                el,
                startX: t.clientX,
                startY: t.clientY,
                started: false
            };
            document.addEventListener('touchmove', this.onTouchMoveMaybeStart, { passive: true });
            document.addEventListener('touchend', this.onTouchEndMaybeStart, { once: true });
        }
    }

    // Threshold helpers to decide when to start drag vs treat as click/tap
    onMouseMoveMaybeStart = (e) => {
        const intent = this._dragIntent;
        if (!intent || intent.type !== 'mouse' || intent.started) return;
        const dy = Math.abs(e.clientY - intent.startY);
        const dx = Math.abs(e.clientX - intent.startX);
        const threshold = 5; // pixels
        if (dy > threshold || dx > threshold) {
            // become a drag
            intent.started = true;
            // switch listeners to active drag
            document.removeEventListener('mousemove', this.onMouseMoveMaybeStart, { passive: true });
            // Now that drag starts, prevent default behaviors
            e.preventDefault();
            this.startMouseDrag(intent.el, intent.startY);
            document.addEventListener('mousemove', this.onMouseMoveDrag);
            document.addEventListener('mouseup', this.onMouseUpDrag, { once: true });
        }
    }

    onMouseUpMaybeStart = (e) => {
        const intent = this._dragIntent;
        // Clean up the maybe-start listener
        document.removeEventListener('mousemove', this.onMouseMoveMaybeStart, { passive: true });
        this._dragIntent = null;
        // If we didn't start a drag, do nothing here and allow the normal click to fire
    }

    onTouchMoveMaybeStart = (e) => {
        const intent = this._dragIntent;
        if (!intent || intent.type !== 'touch' || intent.started) return;
        if (!(e.touches && e.touches.length > 0)) return;
        const t = e.touches[0];
        const dy = Math.abs(t.clientY - intent.startY);
        const dx = Math.abs(t.clientX - intent.startX);
        const threshold = 5; // pixels
        if (dy > threshold || dx > threshold) {
            intent.started = true;
            // switch listeners to active drag
            document.removeEventListener('touchmove', this.onTouchMoveMaybeStart, { passive: true });
            // prevent scrolling etc once drag begins
            e.preventDefault();
            this.startMouseDrag(intent.el, intent.startY);
            document.addEventListener('touchmove', this.onTouchMoveDrag, { passive: false });
            document.addEventListener('touchend', this.onTouchEndDrag, { once: true });
        }
    }

    onTouchEndMaybeStart = (e) => {
        // If it never became a drag, allow the tap to generate a click
        document.removeEventListener('touchmove', this.onTouchMoveMaybeStart, { passive: true });
        this._dragIntent = null;
    }

    startMouseDrag(el, startY) {
        const elRect = el.getBoundingClientRect();

        // Compute pinned bounds (top of first pinned to bottom of last pinned)
        const pinnedEls = Array.from(this.dom.wall.querySelectorAll('.entry.pinned'));
        if (pinnedEls.length === 0) return;
        const firstRect = pinnedEls[0].getBoundingClientRect();
        const lastRect = pinnedEls[pinnedEls.length - 1].getBoundingClientRect();

        this._mouseDrag = {
            active: true,
            el,
            offsetY: startY - elRect.top,
            placeholder: null,
            bounds: { minY: firstRect.top, maxY: lastRect.bottom, height: elRect.height }
        };

        // Insert placeholder in original position
        const placeholder = document.createElement('div');
        placeholder.className = 'entry pinned placeholder';
        placeholder.style.height = `${elRect.height}px`;
        this._mouseDrag.placeholder = placeholder;
        el.parentNode.insertBefore(placeholder, el);

        // Lift the element: fixed positioning to follow cursor
        el.classList.add('dragging-abs');
        el.style.width = `${elRect.width}px`;
        el.style.left = `${elRect.left}px`;
        el.style.top = `${elRect.top}px`;

        document.body.classList.add('no-select');
    }

    onMouseMoveDrag = (e) => {
        if (!this._mouseDrag.active) return;
        e.preventDefault();
        this.reorderWhileDragging(e.clientY);
    }

    onMouseUpDrag = (e) => {
        if (!this._mouseDrag.active) return;
        this.finishMouseDrag();
    }

    onTouchMoveDrag = (e) => {
        if (!this._mouseDrag.active) return;
        if (e.touches && e.touches.length > 0) {
            e.preventDefault();
            this.reorderWhileDragging(e.touches[0].clientY);
        }
    }

    onTouchEndDrag = (e) => {
        if (!this._mouseDrag.active) return;
        this.finishMouseDrag();
    }

    reorderWhileDragging(y) {
        const drag = this._mouseDrag;
        const el = drag.el;

        // Clamp cursor within pinned bounds
        const minTop = drag.bounds.minY;
        const maxTop = drag.bounds.maxY - drag.bounds.height;
        const unclampedTop = y - (drag.offsetY || 0);
        const clampedTop = Math.max(minTop, Math.min(maxTop, unclampedTop));

        // Follow cursor within bounds
        el.style.top = `${clampedTop}px`;

        // Use clamped cursor position for placeholder placement
        const clampedCursorY = clampedTop + (drag.offsetY || 0);
        const afterEl = this.getPinnedAfterElement(clampedCursorY);
        const firstUnpinned = this.dom.wall.querySelector('.entry:not(.pinned)');
        const placeholder = drag.placeholder;
        if (afterEl == null) {
            if (firstUnpinned) this.dom.wall.insertBefore(placeholder, firstUnpinned);
            else this.dom.wall.appendChild(placeholder);
        } else {
            this.dom.wall.insertBefore(placeholder, afterEl);
        }
    }

    finishMouseDrag() {
        const drag = this._mouseDrag;
        const el = drag.el;
        const placeholder = drag.placeholder;
        if (el) {
            el.classList.remove('dragging-abs');
            el.style.position = '';
            el.style.top = '';
            el.style.left = '';
            el.style.width = '';
        }
        // Place element where placeholder is
        if (placeholder && placeholder.parentNode) {
            placeholder.parentNode.insertBefore(el, placeholder);
            placeholder.remove();
        }

        this._mouseDrag = { active: false, el: null, placeholder: null };
        document.body.classList.remove('no-select');

        // Remove move listeners
        document.removeEventListener('mousemove', this.onMouseMoveDrag);
        document.removeEventListener('touchmove', this.onTouchMoveDrag);

        // Persist new order and update local state
        const els = Array.from(this.dom.wall.querySelectorAll('.entry.pinned'));
        const orderedIds = els.map(el => el.dataset.id);
        const map = new Map(orderedIds.map((id, idx) => [id, idx]));
        this.entries.forEach(en => {
            if (en.is_pinned && map.has(String(en.id))) {
                en.pin_order = map.get(String(en.id));
            }
        });
        if (this.currentWall === 'rishu') this.entriesCache.rishu = this.entries;
        this.savePinnedOrder(orderedIds).catch(() => alert('Failed to save order'));

        // Suppress the synthetic click that may fire right after dragging
        this._suppressClickUntil = Date.now() + 400;
    }

    getPinnedAfterElement(y) {
        const selector = '.entry.pinned:not(.dragging-abs):not(.placeholder)';
        const draggableElements = [...this.dom.wall.querySelectorAll(selector)];
        return draggableElements.reduce((closest, child) => {
            const box = child.getBoundingClientRect();
            const offset = y - box.top - box.height / 2;
            if (offset < 0 && offset > closest.offset) {
                return { offset, element: child };
            } else {
                return closest;
            }
        }, { offset: Number.NEGATIVE_INFINITY }).element;
    }

    openModal() {
        this.dom.modal.classList.add('show');
    }

    closeModal() {
        this.dom.modal.classList.remove('show');

        // Clear modal content after animation
        setTimeout(() => {
            if (!this.dom.modal.classList.contains('show')) {
                this.dom.modalBody.innerHTML = '';
            }
        }, 200);

        // Reset modal context and active form
        this._modalContext = null;
        this._activeForm = null;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    linkify(text) {
        if (text == null) return '';
        const str = String(text);
        const urlRe = /((https?:\/\/|www\.)[^\s<]+)/gi;
        let out = '';
        let last = 0;
        let match;
        while ((match = urlRe.exec(str)) !== null) {
            const start = match.index;
            const end = start + match[0].length;
            // Non-link segment, escaped
            out += this.escapeHtml(str.slice(last, start));
            let href = match[0];
            if (/^www\./i.test(href)) href = 'https://' + href;
            if (/^https?:\/\//i.test(href)) {
                const safeHref = this.escapeHtml(href).replace(/'/g, '&#39;');
                const safeText = this.escapeHtml(match[0]);
                out += `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${safeText}</a>`;
            } else {
                // Fallback: not a supported protocol, just escape
                out += this.escapeHtml(match[0]);
            }
            last = end;
        }
        out += this.escapeHtml(str.slice(last));
        return out;
    }

    async fetchSpotifyArt(spotifyUrl) {
        try {
            const url = String(spotifyUrl || '').trim();
            if (!url) return null;
            if (this.spotifyCache.has(url)) return this.spotifyCache.get(url);
            const data = await this.fetchSpotifyOEmbed(url);
            const thumb = data && (data.thumbnail_url || (data.thumbnail && data.thumbnail.url));
            const val = thumb || null;
            this.spotifyCache.set(url, val);
            return val;
        } catch (_) {
            return null;
        }
    }

    async fetchSpotifyOEmbed(spotifyUrl) {
        try {
            const url = String(spotifyUrl || '').trim();
            if (!url) return null;
            if (this.spotifyEmbedCache.has(url)) return this.spotifyEmbedCache.get(url);
            const api = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`;
            const resp = await fetch(api);
            const data = await resp.json().catch(() => ({}));
            this.spotifyEmbedCache.set(url, data);
            return data;
        } catch (_) {
            return null;
        }
    }

    async saveSongQuote(text, password, title = null, spotify_url = null) {
        const response = await fetch('/api/song-quotes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, password, title: (typeof title === 'string' && title.trim() && title.trim() !== '(optional)') ? title.trim() : undefined, spotify_url: (typeof spotify_url === 'string' && spotify_url.trim()) ? spotify_url.trim() : undefined })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || 'Error');
        return result.data;
    }

    async updateSongQuote(id, text, title = null, spotify_url = null) {
        const response = await fetch('/api/update-song-quote', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, text, title: (typeof title === 'string' && title.trim() && title.trim() !== '(optional)') ? title.trim() : undefined, spotify_url: (typeof spotify_url === 'string' && spotify_url.trim()) ? spotify_url.trim() : undefined, password: this.tempPassword })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || 'Error');
        return result.data;
    }

    async removeSongQuote(id) {
        const response = await fetch('/api/delete-song-quote', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, password: this.tempPassword })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || 'Error');
        return true;
    }

    toggleDarkMode() {
        const isDark = this.dom.darkModeToggle.checked;
        document.body.classList.toggle('dark-mode', isDark);
        localStorage.setItem(CONFIG.STORAGE_KEYS.DARK_MODE, isDark);
        this.applyThemeColorMeta(isDark);
    }

    applyDarkMode() {
        const stored = localStorage.getItem(CONFIG.STORAGE_KEYS.DARK_MODE);
        const isDark = stored === null ? true : stored === 'true';
        if (stored === null) {
            localStorage.setItem(CONFIG.STORAGE_KEYS.DARK_MODE, 'true');
        }
        this.dom.darkModeToggle.checked = isDark;
        document.body.classList.toggle('dark-mode', isDark);
        this.applyThemeColorMeta(isDark);
    }

    applyThemeColorMeta(isDark) {
        try {
            const color = isDark ? '#0a0f1a' : '#fffdf2';
            // Update all theme-color metas so mobile UIs pick the active one
            const metas = Array.from(document.querySelectorAll('meta[name="theme-color"]'));
            if (metas.length === 0) {
                const m = document.createElement('meta');
                m.setAttribute('name', 'theme-color');
                document.head.appendChild(m);
                metas.push(m);
            }
            metas.forEach(m => {
                m.removeAttribute('media'); // avoid media-preferred override
                m.setAttribute('content', color);
                m.setAttribute('data-dynamic', '1');
            });
            // iOS Safari status bar style for PWA-like contexts
            let ios = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
            if (!ios) {
                ios = document.createElement('meta');
                ios.setAttribute('name', 'apple-mobile-web-app-status-bar-style');
                document.head.appendChild(ios);
            }
            ios.setAttribute('content', isDark ? 'black-translucent' : 'default');
        } catch (_) {}
    }
}

// Initialize app when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => new WallApp());
} else {
    new WallApp();
}
