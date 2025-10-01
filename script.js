// App state and configuration
const CONFIG = {
    PASSWORD: 'mypassword',
    STORAGE_KEYS: {
        ENTRIES: 'wallEntries',
        AUTH: 'isAuthenticated',
        DARK_MODE: 'darkMode'
    }
};

class WallApp {
    constructor() {
        this.entries = [];
        this.isAuthenticated = false;
        this.dom = {};

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

        // Load data from localStorage
        this.loadData();

        // Set up event listeners
        this.setupEventListeners();

        // Initial render
        this.renderEntries();

        // Apply dark mode if enabled
        this.applyDarkMode();
    }

    loadData() {
        // Load entries
        const savedEntries = localStorage.getItem(CONFIG.STORAGE_KEYS.ENTRIES);
        this.entries = savedEntries ? JSON.parse(savedEntries) : [];

        // Load authentication state
        const savedAuth = localStorage.getItem(CONFIG.STORAGE_KEYS.AUTH);
        this.isAuthenticated = savedAuth === 'true';
    }

    saveEntries() {
        localStorage.setItem(CONFIG.STORAGE_KEYS.ENTRIES, JSON.stringify(this.entries));
    }

    saveAuthState() {
        localStorage.setItem(CONFIG.STORAGE_KEYS.AUTH, this.isAuthenticated ? 'true' : 'false');
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
    }

    handleAddButtonClick() {
        console.log('=== ADD BUTTON CLICKED ===');
        console.log('isAuthenticated:', this.isAuthenticated);
        console.log('Modal element:', this.dom.modal);
        console.log('Modal classList:', this.dom.modal.classList);
        console.log('Button element:', this.dom.addButton);

        if (this.isAuthenticated) {
            console.log('Showing entry form');
            this.showEntryForm();
        } else {
            console.log('Showing password form');
            this.showPasswordForm();
        }
    }

    renderEntries() {
        this.dom.wall.innerHTML = '';

        this.entries.forEach((entry) => {
            console.log('Entry:', entry);
            // Handle both old string entries and new object entries
            const entryText = typeof entry === 'string' ? entry : entry.text;
            const timestamp = typeof entry === 'string' ? null : entry.timestamp;
            console.log('Timestamp:', timestamp);

            const entryDiv = document.createElement('div');
            entryDiv.className = 'entry';

            const timestampSpan = document.createElement('span');
            timestampSpan.className = 'entry-timestamp';
            timestampSpan.textContent = timestamp ? this.formatTimestamp(timestamp) : '';

            const textSpan = document.createElement('span');
            textSpan.className = 'entry-text';
            textSpan.textContent = entryText;

            entryDiv.appendChild(timestampSpan);
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
        const errorDiv = document.getElementById('passwordError');

        if (input.value === CONFIG.PASSWORD) {
            this.isAuthenticated = true;
            this.saveAuthState();
            this.showEntryForm();
        } else {
            errorDiv.textContent = 'Incorrect password';
        }
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

    handleEntrySubmit(e) {
        e.preventDefault();

        const textarea = document.getElementById('entryText');
        const text = textarea.value.trim();

        if (text) {
            const entry = {
                text: text,
                timestamp: new Date().toISOString()
            };
            this.entries.unshift(entry);
            this.saveEntries();
            this.renderEntries();
            this.closeModal();
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
