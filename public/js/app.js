/**
 * Application initialization and event binding
 */
import { Config } from './config.js';
import { Storage } from './storage.js';
import { UI } from './ui.js';
import { Chat } from './chat.js';

function init() {
    UI.init();
    UI.populateModelSelect();

    const config = Storage.loadConfig();
    UI.elements.apiKey.value = config.apiKey;
    UI.elements.apiKeyKimi.value = config.apiKeyKimi;
    if (UI.elements.apiKeyRag) UI.elements.apiKeyRag.value = config.apiKeyRag;
    UI.elements.systemPrompt.value = config.systemPrompt;
    UI.setSelectedModel(config.model);

    Chat.init();
    onModelChange();
    Chat.renderHistoryList();

    const preset = Config.getCurrentPreset();
    if (Chat.getApiKey(preset) || preset.provider === 'rag') UI.enableInput(true);

    bindEvents();
}

function onModelChange() {
    const preset = Config.getCurrentPreset();
    UI.updateKeyFieldsVisibility(preset);
    UI.updateStatusFromPreset(preset, !!Chat.getApiKey(preset));
}

function saveConfig() {
    Chat.systemPrompt = UI.elements.systemPrompt.value.trim();
    Storage.saveConfig({
        apiKey: UI.elements.apiKey.value.trim(),
        apiKeyKimi: UI.elements.apiKeyKimi.value.trim(),
        apiKeyRag: UI.elements.apiKeyRag?.value.trim() || '',
        model: UI.elements.modelSelect.value,
        systemPrompt: Chat.systemPrompt,
    });
    onModelChange();
    UI.showSaveSuccess(document.getElementById('btn-save-config'));
}

function copyCode(btn) {
    const pre = btn.closest('.code-block');
    const code = pre.querySelector('code');
    navigator.clipboard.writeText(code ? code.textContent : pre.textContent)
        .then(() => {
            btn.textContent = 'Copiado!';
            btn.classList.add('copied');
            setTimeout(() => { btn.textContent = 'Copiar'; btn.classList.remove('copied'); }, 1500);
        });
}

function copyFullMessage(btn) {
    const contentDiv = btn.closest('.msg').querySelector('.content');
    if (!contentDiv) return;
    navigator.clipboard.writeText(contentDiv.textContent)
        .then(() => { btn.innerHTML = '✅'; setTimeout(() => { btn.innerHTML = '📋'; }, 1500); });
}

function toggleThinking(toggle) {
    const targetId = toggle.dataset.target;
    const content = document.getElementById(targetId);
    if (content) {
        content.classList.toggle('visible');
        toggle.textContent = content.classList.contains('visible') ? '▼ Razonamiento' : '▶ Razonamiento';
    }
}

function bindEvents() {
    UI.elements.modelSelect.addEventListener('change', onModelChange);
    document.getElementById('btn-save-config').addEventListener('click', saveConfig);

    document.getElementById('btn-toggle-sidebar')?.addEventListener('click', () => UI.toggleSidebar());
    document.getElementById('btn-close-sidebar')?.addEventListener('click', () => UI.closeSidebar());
    UI.elements.sidebarOverlay.addEventListener('click', () => UI.closeSidebar());

    document.getElementById('config-toggle')?.addEventListener('click', () => UI.toggleConfigSection());

    document.getElementById('btn-new-chat')?.addEventListener('click', () => Chat.newChat());
    document.getElementById('btn-test')?.addEventListener('click', () => Chat.testConnection());
    document.getElementById('btn-export')?.addEventListener('click', () => Chat.exportChat());
    document.getElementById('btn-clear-history')?.addEventListener('click', () => Chat.clearAllHistory());

    UI.elements.sendBtn.addEventListener('click', () => Chat.sendMessage());

    UI.elements.input.addEventListener('input', () => {
        UI.elements.input.style.height = 'auto';
        UI.elements.input.style.height = UI.elements.input.scrollHeight + 'px';
    });

    UI.elements.systemPrompt.addEventListener('input', () => {
        UI.elements.systemPrompt.style.height = 'auto';
        UI.elements.systemPrompt.style.height = UI.elements.systemPrompt.scrollHeight + 'px';
    });

    UI.elements.input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); Chat.sendMessage(); }
    });

    document.getElementById('btn-attach')?.addEventListener('click', () => UI.elements.fileInput.click());

    UI.elements.fileInput.addEventListener('change', () => {
        Chat.handleFiles(UI.elements.fileInput.files);
        UI.elements.fileInput.value = '';
    });

    UI.elements.input.addEventListener('paste', (e) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const item of items) {
            if (item.type.indexOf('image') === 0) {
                e.preventDefault();
                Chat.handleFiles([item.getAsFile()]);
                return;
            }
        }
    });

    document.body.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        UI.elements.chat.classList.add('drag-over');
    });

    document.body.addEventListener('dragleave', () => UI.elements.chat.classList.remove('drag-over'));

    document.body.addEventListener('drop', (e) => {
        e.preventDefault();
        UI.elements.chat.classList.remove('drag-over');
        Chat.handleFiles(e.dataTransfer.files);
    });

    UI.elements.historyList.addEventListener('click', (e) => {
        const deleteBtn = e.target.closest('.hi-del');
        if (deleteBtn) { e.stopPropagation(); Chat.deleteConversation(deleteBtn.dataset.id); return; }
        const item = e.target.closest('.history-item');
        if (item) Chat.loadConversation(item.dataset.id);
    });

    UI.elements.previewArea.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (btn && btn.dataset.idx !== undefined) Chat.removeAttachment(parseInt(btn.dataset.idx));
    });

    UI.elements.chat.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) {
            const toggle = e.target.closest('.thinking-toggle');
            if (toggle) toggleThinking(toggle);
            return;
        }
        const action = btn.dataset.action;
        if (action === 'edit') Chat.editMessage(parseInt(btn.dataset.idx));
        else if (action === 'regenerate') Chat.regenerate();
        else if (action === 'copy') copyFullMessage(btn);
        else if (action === 'copy-code') copyCode(btn);
    });
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
