/**
 * Configuration and model presets
 */
export const Config = {
    // API endpoints (relative to current domain)
    CHAT_ENDPOINT: '/api/chat',
    RAG_ENDPOINT: '/api/rag',

    // Model presets
    MODEL_PRESETS: [
        {
            id: 'gpt-5.2-codex',
            name: 'GPT-5.2 Codex',
            provider: 'azure-openai',
            format: 'responses',
            host: 'javie-mku5l3k8-swedencentral.cognitiveservices.azure.com',
            path: '/openai/responses?api-version=2025-04-01-preview',
        },
        {
            id: 'gpt-5.2',
            name: 'GPT-5.2',
            provider: 'azure-openai',
            format: 'responses',
            host: 'javie-mku5l3k8-swedencentral.cognitiveservices.azure.com',
            path: '/openai/responses?api-version=2025-04-01-preview',
        },
        {
            id: 'Kimi-K2.5',
            name: 'Kimi K2.5',
            provider: 'kimi',
            format: 'chat-completions',
            host: 'openai-reader-javi.services.ai.azure.com',
            path: '/openai/v1/chat/completions',
        },
        {
            id: 'ss-expert',
            name: 'SS Expert (RAG)',
            provider: 'rag',
            format: 'rag',
        },
    ],

    // Storage keys
    STORAGE_KEYS: {
        API_KEY: 'azure-chat-key',
        API_KEY_KIMI: 'azure-chat-key-kimi',
        API_KEY_RAG: 'azure-chat-key-rag',
        MODEL: 'azure-chat-model',
        SYSTEM_PROMPT: 'azure-chat-systemprompt',
        HISTORY: 'azure-chat-history',
        CURRENT_CONV: 'azure-chat-current',
    },

    MAX_HISTORY_ITEMS: 50,

    getPreset(id) {
        return this.MODEL_PRESETS.find(p => p.id === id) || this.MODEL_PRESETS[0];
    },

    getCurrentPreset() {
        const modelSelect = document.getElementById('model-select');
        return this.getPreset(modelSelect?.value);
    },
};
