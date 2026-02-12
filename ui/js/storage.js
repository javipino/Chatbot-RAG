/**
 * LocalStorage management for config and history
 */
const Storage = {
    /**
     * Save value to localStorage
     */
    set(key, value) {
        try {
            localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
        } catch (e) {
            console.error('Storage.set error:', e);
        }
    },
    
    /**
     * Get value from localStorage
     */
    get(key, defaultValue = null) {
        try {
            const value = localStorage.getItem(key);
            if (value === null) return defaultValue;
            try {
                return JSON.parse(value);
            } catch {
                return value;
            }
        } catch (e) {
            console.error('Storage.get error:', e);
            return defaultValue;
        }
    },
    
    /**
     * Remove key from localStorage
     */
    remove(key) {
        try {
            localStorage.removeItem(key);
        } catch (e) {
            console.error('Storage.remove error:', e);
        }
    },
    
    // ==================== Config ====================
    
    saveConfig(config) {
        const keys = Config.STORAGE_KEYS;
        if (config.apiKey !== undefined) this.set(keys.API_KEY, config.apiKey);
        if (config.apiKeyKimi !== undefined) this.set(keys.API_KEY_KIMI, config.apiKeyKimi);
        if (config.apiKeyRag !== undefined) this.set(keys.API_KEY_RAG, config.apiKeyRag);
        if (config.model !== undefined) this.set(keys.MODEL, config.model);
        if (config.systemPrompt !== undefined) this.set(keys.SYSTEM_PROMPT, config.systemPrompt);
    },
    
    loadConfig() {
        const keys = Config.STORAGE_KEYS;
        return {
            apiKey: this.get(keys.API_KEY, ''),
            apiKeyKimi: this.get(keys.API_KEY_KIMI, ''),
            apiKeyRag: this.get(keys.API_KEY_RAG, ''),
            model: this.get(keys.MODEL, Config.MODEL_PRESETS[0].id),
            systemPrompt: this.get(keys.SYSTEM_PROMPT, '')
        };
    },
    
    // ==================== History ====================
    
    /**
     * Get all conversations
     */
    getHistory() {
        return this.get(Config.STORAGE_KEYS.HISTORY, []);
    },
    
    /**
     * Save conversations list
     */
    setHistory(list) {
        // Limit to MAX_HISTORY_ITEMS
        if (list.length > Config.MAX_HISTORY_ITEMS) {
            list = list.slice(0, Config.MAX_HISTORY_ITEMS);
        }
        this.set(Config.STORAGE_KEYS.HISTORY, list);
    },
    
    /**
     * Get current conversation ID
     */
    getCurrentConvId() {
        return this.get(Config.STORAGE_KEYS.CURRENT_CONV, null);
    },
    
    /**
     * Set current conversation ID
     */
    setCurrentConvId(id) {
        if (id) {
            this.set(Config.STORAGE_KEYS.CURRENT_CONV, id);
        } else {
            this.remove(Config.STORAGE_KEYS.CURRENT_CONV);
        }
    },
    
    /**
     * Save or update a conversation
     */
    saveConversation(id, messages, title) {
        const list = this.getHistory();
        const now = Date.now();
        
        // Lightweight copy (remove large image data)
        const lightMessages = messages.map(m => {
            if (m.role === 'user' && Array.isArray(m.content)) {
                const filtered = m.content.map(p => {
                    if (p.type === 'input_image') {
                        return { type: 'input_image', image_url: '(imagen)' };
                    }
                    return p;
                });
                return { role: m.role, content: filtered };
            }
            return m;
        });
        
        // Check if exists
        const idx = list.findIndex(c => c.id === id);
        if (idx >= 0) {
            list[idx].messages = lightMessages;
            list[idx].title = title;
            list[idx].updated = now;
        } else {
            list.unshift({
                id,
                title,
                created: now,
                updated: now,
                messages: lightMessages
            });
        }
        
        this.setHistory(list);
        this.setCurrentConvId(id);
    },
    
    /**
     * Get conversation by ID
     */
    getConversation(id) {
        const list = this.getHistory();
        return list.find(c => c.id === id) || null;
    },
    
    /**
     * Delete conversation by ID
     */
    deleteConversation(id) {
        let list = this.getHistory();
        list = list.filter(c => c.id !== id);
        this.setHistory(list);
        
        if (this.getCurrentConvId() === id) {
            this.setCurrentConvId(null);
        }
    },
    
    /**
     * Clear all history
     */
    clearHistory() {
        this.remove(Config.STORAGE_KEYS.HISTORY);
        this.remove(Config.STORAGE_KEYS.CURRENT_CONV);
    }
};

window.Storage = Storage;
