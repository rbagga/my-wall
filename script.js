// App state and configuration
// CONFIG is loaded from config.js

class WallApp {
    constructor() {
        this.entries = [];
        this.isAuthenticated = false;
        this.dom = {};
        this.currentWall = 'rishu'; // 'rishu' or 'friend'
        this.entriesCache = { rishu: null, friend: null };
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
        // no organize button in UI

        // Load data
        this.loadAuthState();

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

    loadAuthState() {
        const auth = localStorage.getItem(CONFIG.STORAGE_KEYS.AUTH);
        const pwd = localStorage.getItem(CONFIG.STORAGE_KEYS.PASSWORD);
        this.isAuthenticated = auth === 'true' && !!pwd;
        this.tempPassword = this.isAuthenticated ? pwd : null;
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
            const endpoint = wallKey === 'rishu' ? '/api/entries' : '/api/friend-entries';
            const response = await fetch(endpoint);
            const result = await response.json();

            if (!response.ok) throw new Error(result.error);

            const fresh = result.data || [];
            this.entriesCache[wallKey] = fresh;
            this.entries = fresh;
            this.renderEntries();
        } catch (error) {
            console.error('Error loading entries:', error);
            // If no cache, leave loader in place on error; otherwise entries remain
        }
    }

    async saveEntry(text, password) {
        try {
            const response = await fetch('/api/entries', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    text: text,
                    password: password
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

        // Drag-and-drop listeners (auth-gated in handlers)
        this.dom.wall.addEventListener('dragover', (e) => this.onDragOver(e));
        this.dom.wall.addEventListener('drop', (e) => this.onDrop(e));
    }

    setupRouting() {
        window.addEventListener('hashchange', () => this.applyWallFromHash());
    }

    applyWallFromHash() {
        const hash = (location.hash || '').toLowerCase();
        const nextWall = hash.includes('friend') ? 'friend' : 'rishu';

        this.currentWall = nextWall;

        if (this.currentWall === 'friend') {
            this.dom.wallTitle.textContent = "friends' wall";
            this.dom.toggleWallButton.textContent = "rishu's wall";
        } else {
            this.dom.wallTitle.textContent = "rishu's wall";
            this.dom.toggleWallButton.textContent = "friends' wall";
        }

        // Render cached entries instantly if present, otherwise show loader
        const cached = this.entriesCache[this.currentWall];
        if (Array.isArray(cached)) {
            this.entries = cached;
            this.renderEntries();
        } else {
            this.showLoading();
        }
        this.loadEntries();
    }

    handleAddButtonClick() {
        if (this.currentWall === 'friend') {
            this.showFriendEntryForm();
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

            const textSpan = document.createElement('span');
            textSpan.className = 'entry-text';
            textSpan.textContent = entryText;

            entryDiv.appendChild(textSpan);

            // Entry click to open modal (suppressed immediately after a drag)
            entryDiv.addEventListener('click', (ev) => {
                if (Date.now() < (this._suppressClickUntil || 0)) {
                    // ignore click generated by finishing a drag
                    return;
                }
                this.showEntry(entryText);
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
        this.dom.modalBody.innerHTML = `<div class="full-entry">${this.escapeHtml(entry)}</div>`;
        this.openModal();
    }

    showPasswordForm() {
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
        const submitBtn = form.querySelector('button[type="submit"]');

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
            this.showEntryForm();
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
            <textarea id="entryText" placeholder="Write your entry..." required></textarea>
            <button type="submit">Add to Wall</button>
        `;

        this.dom.modalBody.innerHTML = '';
        this.dom.modalBody.appendChild(form);

        form.addEventListener('submit', (e) => this.handleEntrySubmit(e));

        this.openModal();

        // Focus textarea
        setTimeout(() => {
            document.getElementById('entryText')?.focus();
        }, 100);
    }

    showFriendEntryForm() {
        const form = document.createElement('form');
        form.className = 'entry-form';
        form.innerHTML = `
            <h3>New Entry</h3>
            <input type="text" id="entryName" placeholder="Your name" required>
            <textarea id="entryText" placeholder="Write your entry..." required></textarea>
            <button type="submit">Add to Wall</button>
        `;

        this.dom.modalBody.innerHTML = '';
        this.dom.modalBody.appendChild(form);

        form.addEventListener('submit', (e) => this.handleFriendEntrySubmit(e));

        this.openModal();

        // Focus name input
        setTimeout(() => {
            document.getElementById('entryName')?.focus();
        }, 100);
    }

    async handleEntrySubmit(e) {
        e.preventDefault();

        const form = e.target;
        if (form.classList.contains('is-submitting')) return;

        const textarea = form.querySelector('#entryText');
        const submitBtn = form.querySelector('button[type="submit"]');
        const text = textarea.value.trim();

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

        try {
            await this.saveEntry(text, this.tempPassword);
            await this.loadEntries();
            this.closeModal();
        } catch (error) {
            if (error.message === 'Invalid password') {
                // Password was wrong
                this.tempPassword = null;
                alert('Invalid password. Please try again.');
                this.closeModal();
            } else {
                alert('Error saving entry. Please try again.');
            }
        } finally {
            if (submitBtn) submitBtn.disabled = false;
            form.classList.remove('is-submitting');
        }
    }

    async handleFriendEntrySubmit(e) {
        e.preventDefault();

        const form = e.target;
        if (form.classList.contains('is-submitting')) return;

        const nameInput = form.querySelector('#entryName');
        const textarea = form.querySelector('#entryText');
        const submitBtn = form.querySelector('button[type="submit"]');

        const name = nameInput.value.trim();
        const text = textarea.value.trim();

        // Prevent empty/whitespace-only submissions
        if (!name || !text) {
            if (!name) nameInput.focus();
            else textarea.focus();
            return;
        }

        // Immediately clear and prevent double submit
        nameInput.value = '';
        textarea.value = '';
        if (submitBtn) submitBtn.disabled = true;
        form.classList.add('is-submitting');

        try {
            await this.saveFriendEntry(text, name);
            await this.loadEntries();
            this.closeModal();
        } catch (error) {
            // Provide clearer message for moderation blocks
            const msg = String(error && error.message || '');
            if (/inappropriate/i.test(msg)) {
                alert('Your entry was blocked due to inappropriate language (in the message or name). Please edit and try again.');
                // Restore inputs so user can edit
                nameInput.value = name;
                textarea.value = text;
            } else {
                alert('Error saving entry. Please try again.');
            }
        } finally {
            if (submitBtn) submitBtn.disabled = false;
            form.classList.remove('is-submitting');
        }
    }

    async saveFriendEntry(text, name) {
        try {
            const response = await fetch('/api/friend-entries', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    text: text,
                    name: name
                })
            });

            const result = await response.json();

            if (!response.ok) throw new Error(result.error);

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
        // Do not preventDefault here; wait to see if it becomes a drag
        const prepare = async () => {
            if (!this.isAuthenticated) {
                try { await this.promptForPassword(); } catch (_) { return; }
            }
            this._dragIntent = {
                type: 'mouse',
                el,
                startX: e.clientX,
                startY: e.clientY,
                started: false
            };
            document.addEventListener('mousemove', this.onMouseMoveMaybeStart, { passive: true });
            document.addEventListener('mouseup', this.onMouseUpMaybeStart, { once: true });
        };
        prepare();
    }

    onTouchStartDrag(e, el) {
        if (this.currentWall !== 'rishu') return;
        if (e.target && e.target.closest && e.target.closest('.pin-btn')) return;
        if (e.touches && e.touches.length > 0) {
            // Do not preventDefault yet; wait to see if it becomes a drag
            const t = e.touches[0];
            const prepare = async () => {
                if (!this.isAuthenticated) {
                    try { await this.promptForPassword(); } catch (_) { return; }
                }
                this._dragIntent = {
                    type: 'touch',
                    el,
                    startX: t.clientX,
                    startY: t.clientY,
                    started: false
                };
                document.addEventListener('touchmove', this.onTouchMoveMaybeStart, { passive: true });
                document.addEventListener('touchend', this.onTouchEndMaybeStart, { once: true });
            };
            prepare();
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
