// App state and configuration
// CONFIG is loaded from config.js

class WallApp {
    constructor() {
        this.entries = [];
        this.isAuthenticated = false;
        this.dom = {};
        this.currentWall = 'rishu'; // 'rishu' or 'friend'

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

        // Load entries from database
        this.loadEntries();

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
        try {
            const endpoint = this.currentWall === 'rishu' ? '/api/entries' : '/api/friend-entries';
            const response = await fetch(endpoint);
            const result = await response.json();

            if (!response.ok) throw new Error(result.error);

            this.entries = result.data || [];
            this.renderEntries();
        } catch (error) {
            console.error('Error loading entries:', error);
            this.entries = [];
            this.renderEntries();
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

        const input = document.getElementById('passwordInput');

        // Store password temporarily for entry submission
        this.tempPassword = input.value;
        this.showEntryForm();
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

        const textarea = document.getElementById('entryText');
        const text = textarea.value.trim();

        if (text) {
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
            }
        }
    }

    async handleFriendEntrySubmit(e) {
        e.preventDefault();

        const nameInput = document.getElementById('entryName');
        const textarea = document.getElementById('entryText');
        const name = nameInput.value.trim();
        const text = textarea.value.trim();

        if (text && name) {
            try {
                await this.saveFriendEntry(text, name);
                await this.loadEntries();
                this.closeModal();
            } catch (error) {
                alert('Error saving entry. Please try again.');
            }
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
        if (this.currentWall === 'rishu') {
            this.currentWall = 'friend';
            this.dom.wallTitle.textContent = "friends' wall";
            this.dom.toggleWallButton.textContent = "rishu's wall";
        } else {
            this.currentWall = 'rishu';
            this.dom.wallTitle.textContent = "rishu's wall";
            this.dom.toggleWallButton.textContent = "friends' wall";
        }
        this.loadEntries();
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
