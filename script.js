// App state and configuration
// CONFIG is loaded from config.js

class WallApp {
    constructor() {
        this.entries = [];
        this.isAuthenticated = false;
        this.dom = {};
        this.currentWall = 'rishu'; // 'rishu', 'friend', 'tech', or 'drafts'
        this.entriesCache = { rishu: null, friend: null, tech: null, drafts: null };
        this._dragImg = null; // legacy HTML5 DnD ghost suppressor (no longer used)
        this._mouseDrag = { active: false, el: null };
        this._dragIntent = null; // pending drag start info (click-vs-drag threshold)
        this._suppressClickUntil = 0; // timestamp to ignore click right after a drag

        this.init();
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
        this.dom.wallTitle = document.getElementById('wallTitle');
        this.dom.draftsButton = document.getElementById('draftsButton');
        this.dom.techButton = document.getElementById('techButton');
        // no organize button in UI

        // Load data
        this.loadAuthState();
        this.updateAuthUI();

        // Set up event listeners
        this.setupEventListeners();

        // Setup routing and render based on current hash
        this.setupRouting();
        this.applyWallFromHash();

        // Apply dark mode if enabled
        this.applyDarkMode();

        // Prepare transparent drag image (kept for compatibility but not used now)
        this._dragImg = this.createTransparentDragImage();
    }

    showLoading() {
        this.dom.wall.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    }

    showEmptyState() {
        const msg = (
            this.currentWall === 'friend' ? "No friend entries yet." :
            this.currentWall === 'tech' ? "No tech notes yet." :
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

    updateAuthUI() {
        if (this.dom && this.dom.draftsButton) {
            const onDrafts = this.currentWall === 'drafts';
            this.dom.draftsButton.style.display = this.isAuthenticated && !onDrafts ? 'inline-block' : 'none';
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
                    body: JSON.stringify({ password: this.tempPassword })
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

            let endpoint = '/api/entries';
            if (wallKey === 'friend') endpoint = '/api/friend-entries';
            else if (wallKey === 'tech') endpoint = '/api/tech-notes';
            const response = await fetch(endpoint);
            const result = await response.json();

            if (!response.ok) throw new Error(result.error);

            const fresh = result.data || [];
            this.entriesCache[wallKey] = fresh;
            this.entries = fresh;
            this.renderEntries();
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
                    title: (typeof title === 'string' && title.trim() && title.trim() !== '(optional)') ? title.trim() : undefined
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

        // Close button click
        this.dom.closeBtn.addEventListener('click', () => this.closeModal());

        // Click outside modal to close
        this.dom.modal.addEventListener('click', (e) => {
            if (e.target === this.dom.modal) {
                this.closeModal();
            }
        });

        // Dark mode toggle
        this.dom.darkModeToggle.addEventListener('change', () => this.toggleDarkMode());

        // Toggle wall button
        this.dom.toggleWallButton.addEventListener('click', () => this.toggleWall());

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

        // Drag-and-drop listeners (auth-gated in handlers)
        this.dom.wall.addEventListener('dragover', (e) => this.onDragOver(e));
        this.dom.wall.addEventListener('drop', (e) => this.onDrop(e));
    }

    setupRouting() {
        window.addEventListener('hashchange', () => this.applyWallFromHash());
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
        const params = this.parseHashParams();
        let nextWall;
        if (hash.includes('tech')) nextWall = 'tech';
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
        } else if (this.currentWall === 'rishu') {
            this.dom.wallTitle.textContent = "rishu's wall";
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
        } else {
            if (this.isAuthenticated) {
                this.showEntryForm();
            } else {
                this.showPasswordForm();
            }
        }
    }

    renderEntries() {
        this.dom.wall.innerHTML = '';
        // Sort: pinned first by pin_order asc, then others by timestamp desc
        const entries = [...this.entries];
        if (!entries.length) {
            this.showEmptyState();
            return;
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
            textSpan.textContent = entryText;

            entryDiv.appendChild(textSpan);

            // Entry click: view on public/friends, edit on drafts (auth only)
            entryDiv.addEventListener('click', (ev) => {
                if (Date.now() < (this._suppressClickUntil || 0)) {
                    // ignore click generated by finishing a drag
                    return;
                }
                if (this.currentWall === 'drafts' && this.isAuthenticated) {
                    this.showEditForm(entry);
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
        // Optional title heading
        if (isObj && entry.title && String(entry.title).trim()) {
            const h = document.createElement('h3');
            h.className = 'full-entry-title';
            h.textContent = String(entry.title).trim();
            container.appendChild(h);
        }
        const content = document.createElement('div');
        content.className = 'full-entry';
        content.innerHTML = this.escapeHtml(text);
        container.appendChild(content);

        // Actions at bottom for main, friends, and tech walls
        if ((this.currentWall === 'rishu' || this.currentWall === 'friend' || this.currentWall === 'tech') && isObj) {
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
                delBtn.className = 'danger';
                delBtn.textContent = 'Delete';
                left.appendChild(delBtn);
            }

            // Edit (auth only) for rishu and tech walls
            if (this.isAuthenticated && (this.currentWall === 'rishu' || this.currentWall === 'tech')) {
                const editBtn = document.createElement('button');
                editBtn.type = 'button';
                editBtn.className = 'action-edit-btn btn-liquid';
                editBtn.innerHTML = `
                    <svg viewBox=\"0 0 24 24\" aria-hidden=\"true\" style=\"width:16px;height:16px;vertical-align:middle;margin-right:6px;\">
                      <path d=\"M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>
                      <path d=\"M14.06 6.19l1.83-1.83 3.75 3.75-1.83 1.83-3.75-3.75z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>
                    </svg>
                    Edit`;
                editBtn.addEventListener('click', () => {
                    if (this.currentWall === 'tech') this.showTechEditForm(entry);
                    else this.showEditForm(entry);
                });
                right.appendChild(editBtn);
            }

            // Share icon button (all walls)
            const shareBtn = document.createElement('button');
            shareBtn.type = 'button';
            shareBtn.className = 'icon-btn';
            shareBtn.title = 'Share link';
            shareBtn.setAttribute('aria-label', 'Share link');
            // Tray-only share icon (rounded tray + up arrow), slightly larger
            shareBtn.innerHTML = `
                <svg viewBox=\"0 0 24 24\" width=\"22\" height=\"22\" aria-hidden=\"true\">
                  <!-- Up arrow -->
                  <path d=\"M12 13V6\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\"/>
                  <path d=\"M9 9l3-3 3 3\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>
                  <!-- Rounded tray at bottom -->
                  <rect x=\"5\" y=\"14\" width=\"14\" height=\"5\" rx=\"2.5\" ry=\"2.5\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\"/>
                </svg>`;
            shareBtn.addEventListener('click', async () => {
                // Show loading modal while generating link
                this.showShareLoading();
                try {
                    if (this.currentWall === 'tech') {
                        const base = location.origin || '';
                        const longUrl = `${base}/#tech&entry=${encodeURIComponent(entry.id)}`;
                        this.showShareModal(longUrl);
                        return;
                    }
                    const { shortUrl } = await this.createShortLink(entry.id, this.currentWall === 'friend' ? 'friend' : 'rishu');
                    this.showShareModal(shortUrl);
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

            // Delete confirm UI (hidden until clicked)
            if (delBtn) {
                const confirmWrap = document.createElement('div');
                confirmWrap.className = 'delete-confirm';
                confirmWrap.style.display = 'none';
                confirmWrap.innerHTML = `
                    <small>Type "delete me" to confirm</small>
                    <div class="confirm-row">
                      <input type="text" class="confirm-input" placeholder="delete me" />
                      <button type="button" class="danger confirm-btn" disabled>Confirm</button>
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

    showPasswordForm() {
        const form = document.createElement('form');
        form.className = 'password-form';
        form.innerHTML = `
            <h3>Enter Password</h3>
            <input type="password" id="passwordInput" placeholder="Password" required autocomplete="current-password">
            <div id="passwordError" class="error"></div>
            <button type="submit" class="btn-liquid">Submit</button>
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
            <div style="display:flex; gap:8px;">
                <button type="submit" id="publishBtn" class="btn-liquid">Publish</button>
                <button type="button" id="saveDraftBtn" class="btn-liquid">Save Draft</button>
            </div>
        `;

        this.dom.modalBody.innerHTML = '';
        this.dom.modalBody.appendChild(form);

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

    showFriendEntryForm() {
        const form = document.createElement('form');
        form.className = 'entry-form';
        form.innerHTML = `
            <h3>New Entry</h3>
            <input type="text" id="entryName" placeholder="Your name" required>
            <input type="text" id="entryTitle" placeholder="Title (optional)">
            <textarea id="entryText" placeholder="Write your entry..." required></textarea>
            <button type="submit" class="btn-liquid">Add to Wall</button>
        `;

        this.dom.modalBody.innerHTML = '';
        this.dom.modalBody.appendChild(form);

        // native placeholder handles optional UX for title

        form.addEventListener('submit', (e) => this.handleFriendEntrySubmit(e));

        this.openModal();

        // Focus name input
        setTimeout(() => {
            document.getElementById('entryName')?.focus();
        }, 100);
    }

    showEditForm(entry) {
        const form = document.createElement('form');
        form.className = 'entry-form';
        form.innerHTML = `
            <h3>Edit Entry</h3>
            <input type="text" id="entryTitle" placeholder="Title (optional)" value="${(entry && entry.title) ? String(entry.title).replace(/&/g,'&amp;').replace(/"/g,'&quot;') : ''}">
            <textarea id="entryText" placeholder="Write your entry..." required></textarea>
            <div style="display:flex; gap:8px; align-items:center;">
                <button type="button" id="publishBtn" class="btn-liquid">Publish</button>
                ${this.currentWall === 'drafts' ? `<select id="publishTarget" style="margin-left:8px;"><option value="rishu">rishu's wall</option><option value="tech">tech notes</option></select>` : ''}
                <button type="button" id="saveDraftBtn" class="btn-liquid">Save Draft</button>
                <button type="button" id="deleteBtn" class="danger" style="margin-left:auto;">Delete</button>
            </div>
        `;

        this.dom.modalBody.innerHTML = '';
        this.dom.modalBody.appendChild(form);

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
              <button type="button" class="danger confirm-btn" disabled>Confirm</button>
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
            <button type=\"submit\" id=\"techSubmitBtn\" class=\"btn-liquid\">Save</button>
        `;

        this.dom.modalBody.innerHTML = '';
        this.dom.modalBody.appendChild(form);

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
                <button type="button" id="saveTechBtn" class="btn-liquid">Save</button>
            </div>
        `;
        this.dom.modalBody.innerHTML = '';
        this.dom.modalBody.appendChild(form);
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

    async createShortLink(entryId, type = 'rishu') {
        const response = await fetch('/api/shorten', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entryId, type, password: this.tempPassword })
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
                <button type="button" id="copyShareBtn" class="btn-liquid">Copy</button>
                <a id="openShareBtn" class="btn-like btn-liquid" href="${this.escapeHtml(shortUrl)}" target="_blank" rel="noopener noreferrer">Open</a>
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
                <button type="button" id="retryShareBtn" class="btn-liquid">Try Again</button>
                <button type="button" id="closeShareBtn" class="btn-liquid">Close</button>
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
                <button type="submit">Submit</button>
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
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    toggleDarkMode() {
        const isDark = this.dom.darkModeToggle.checked;
        document.body.classList.toggle('dark-mode', isDark);
        localStorage.setItem(CONFIG.STORAGE_KEYS.DARK_MODE, isDark);
    }

    applyDarkMode() {
        const stored = localStorage.getItem(CONFIG.STORAGE_KEYS.DARK_MODE);
        const isDark = stored === null ? true : stored === 'true';
        if (stored === null) {
            localStorage.setItem(CONFIG.STORAGE_KEYS.DARK_MODE, 'true');
        }
        this.dom.darkModeToggle.checked = isDark;
        document.body.classList.toggle('dark-mode', isDark);
    }
}

// Initialize app when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => new WallApp());
} else {
    new WallApp();
}
