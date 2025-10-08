// App state and configuration
// CONFIG is loaded from config.js

class WallApp {
    constructor() {
        this.entries = [];
        this.isAuthenticated = false;
        this.dom = {};
        this.currentWall = 'rishu'; // 'rishu' or 'friend'
        this.entriesCache = { rishu: null, friend: null };

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

        // Load data
        this.loadAuthState();

        // Set up event listeners
        this.setupEventListeners();

        // Setup routing and render based on current hash
        this.setupRouting();
        this.applyWallFromHash();

        // Apply dark mode if enabled
        this.applyDarkMode();
    }

    loadAuthState() {
        // Don't persist authentication - always require password
        this.isAuthenticated = false;
        this.tempPassword = null;
    }

    saveAuthState() {
        // Don't save auth state - always require password
    }

    async loadEntries() {
        const wallKey = this.currentWall;

        // If we have cached entries, render them immediately to avoid blank state
        const cached = this.entriesCache[wallKey];
        if (Array.isArray(cached)) {
            this.entries = cached;
            this.renderEntries();
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
            // Only show empty if we have no cache to fall back to
            if (!Array.isArray(this.entriesCache[wallKey])) {
                this.entries = [];
                this.renderEntries();
            }
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

        // Render cached entries instantly, then refresh
        const cached = this.entriesCache[this.currentWall] || [];
        this.entries = cached;
        this.renderEntries();
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

        this.entries.forEach((entry) => {
            const entryText = entry.text;
            const timestamp = entry.timestamp;
            const name = entry.name;

            const entryDiv = document.createElement('div');
            entryDiv.className = 'entry';

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

            entryDiv.addEventListener('click', () => this.showEntry(entryText));
            this.dom.wall.appendChild(entryDiv);
        });
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
            // Success: store temp and proceed to entry form
            this.tempPassword = pwd;
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
            this.tempPassword = null;
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
        const isDark = localStorage.getItem(CONFIG.STORAGE_KEYS.DARK_MODE) === 'true';
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
