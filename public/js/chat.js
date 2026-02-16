/**
 * Chat logic and state management
 */
import { Config } from './config.js';
import { Storage } from './storage.js';
import { API } from './api.js';
import { UI } from './ui.js';

export const Chat = {
    conversationHistory: [],
    currentConvId: null,
    systemPrompt: '',
    pendingAttachments: [],
    isLoading: false,
    ragChunkIds: [],  // carryover: chunk IDs from last RAG response
    MAX_ATTACHMENT_BYTES: 8 * 1024 * 1024,
    MAX_ATTACHMENT_CHARS: 20000,

    init() {
        const config = Storage.loadConfig();
        this.systemPrompt = config.systemPrompt;
        const lastId = Storage.getCurrentConvId();
        if (lastId) this.loadConversation(lastId);
    },

    // ==================== Conversation management ====================

    generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    },

    getConversationTitle(messages) {
        for (const m of messages) {
            if (m.role === 'user') {
                let text = typeof m.content === 'string' ? m.content : '';
                if (Array.isArray(m.content)) {
                    const textPart = m.content.find(p => p.type === 'input_text');
                    if (textPart) text = textPart.text;
                }
                return text.length > 40 ? text.substring(0, 40) + '...' : text;
            }
        }
        return '(sin titulo)';
    },

    saveCurrentConversation() {
        if (this.conversationHistory.length === 0) return;
        if (!this.currentConvId) this.currentConvId = this.generateId();
        const title = this.getConversationTitle(this.conversationHistory);
        Storage.saveConversation(this.currentConvId, this.conversationHistory, title);
        this.renderHistoryList();
    },

    loadConversation(id) {
        const conv = Storage.getConversation(id);
        if (!conv) return;
        if (this.conversationHistory.length > 0 && this.currentConvId !== id) {
            this.saveCurrentConversation();
        }
        this.conversationHistory = conv.messages || [];
        this.currentConvId = id;
        this.ragChunkIds = [];  // reset carryover when switching conversations
        Storage.setCurrentConvId(id);
        this.rebuildChat();
        this.renderHistoryList();
        UI.closeSidebar();
    },

    deleteConversation(id) {
        Storage.deleteConversation(id);
        if (this.currentConvId === id) {
            this.currentConvId = null;
            this.conversationHistory = [];
            UI.clearChat();
        }
        this.renderHistoryList();
    },

    newChat() {
        if (this.conversationHistory.length > 0) this.saveCurrentConversation();
        this.conversationHistory = [];
        this.currentConvId = null;
        this.ragChunkIds = [];
        UI.clearChat();
        this.clearAttachments();
        this.renderHistoryList();
    },

    clearAllHistory() {
        if (confirm('¿Eliminar TODAS las conversaciones guardadas?')) {
            Storage.clearHistory();
            this.currentConvId = null;
            this.conversationHistory = [];
            UI.clearChat();
            this.renderHistoryList();
        }
    },

    renderHistoryList() {
        const history = Storage.getHistory();
        UI.renderHistoryList(history, this.currentConvId);
    },

    rebuildChat() {
        UI.clearChat();
        for (let i = 0; i < this.conversationHistory.length; i++) {
            const h = this.conversationHistory[i];
            if (h.role === 'user') {
                let text = typeof h.content === 'string' ? h.content : '';
                if (Array.isArray(h.content)) {
                    const textPart = h.content.find(p => p.type === 'input_text');
                    if (textPart) text = textPart.text;
                }
                UI.addMessage('user', text, { msgIdx: i });
            } else if (h.role === 'assistant') {
                UI.addMessage('assistant', h.content, { msgIdx: i });
            }
        }
    },

    // ==================== Attachments ====================

    addAttachment(attachment) {
        this.pendingAttachments.push(attachment);
        UI.renderPreviews(this.pendingAttachments);
    },

    removeAttachment(idx) {
        this.pendingAttachments.splice(idx, 1);
        UI.renderPreviews(this.pendingAttachments);
    },

    clearAttachments() {
        this.pendingAttachments = [];
        UI.clearPreviews();
    },

    async handleFiles(files) {
        const list = Array.from(files || []);
        for (const file of list) {
            try {
                const attachment = await this.buildAttachment(file);
                if (attachment) this.addAttachment(attachment);
            } catch (err) {
                UI.addMessage('error', `No se pudo procesar "${file.name}": ${err.message}`);
            }
        }
    },

    isTextLikeFile(file) {
        const textExts = [
            '.txt', '.md', '.csv', '.json', '.xml', '.html', '.css', '.js', '.ts', '.jsx', '.tsx',
            '.py', '.java', '.cs', '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.sql', '.yaml',
            '.yml', '.sh', '.bat', '.ps1', '.log', '.c', '.cpp', '.h', '.rtf'
        ];
        const lower = file.name.toLowerCase();
        return file.type.startsWith('text/') || textExts.some(ext => lower.endsWith(ext));
    },

    isPdfFile(file) {
        const lower = file.name.toLowerCase();
        return file.type === 'application/pdf' || lower.endsWith('.pdf');
    },

    isDocxFile(file) {
        const lower = file.name.toLowerCase();
        return file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || lower.endsWith('.docx');
    },

    truncateAttachmentText(text, fileName) {
        const clean = (text || '').replace(/\u0000/g, '').trim();
        if (clean.length <= this.MAX_ATTACHMENT_CHARS) return clean;
        const head = clean.substring(0, this.MAX_ATTACHMENT_CHARS);
        return `${head}\n\n[... contenido truncado de ${fileName}: ${clean.length - this.MAX_ATTACHMENT_CHARS} caracteres omitidos ...]`;
    },

    async buildAttachment(file) {
        if (file.size > this.MAX_ATTACHMENT_BYTES) {
            throw new Error(`archivo demasiado grande (${Math.round(file.size / 1024 / 1024)}MB). Máximo: 8MB`);
        }

        if (file.type.indexOf('image') === 0) {
            const data = await this.readAsDataURL(file);
            return { type: 'image', name: file.name, data };
        }

        if (this.isPdfFile(file)) {
            const text = await this.readPdfAsText(file);
            return { type: 'text', name: file.name, data: this.truncateAttachmentText(text, file.name) };
        }

        if (this.isDocxFile(file)) {
            const text = await this.readDocxAsText(file);
            return { type: 'text', name: file.name, data: this.truncateAttachmentText(text, file.name) };
        }

        if (this.isTextLikeFile(file)) {
            const text = await this.readAsText(file);
            return { type: 'text', name: file.name, data: this.truncateAttachmentText(text, file.name) };
        }

        throw new Error('formato no soportado (usa txt, md, csv, json, code, pdf, docx, rtf o imágenes)');
    },

    readAsDataURL(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = () => reject(new Error('error leyendo imagen'));
            reader.readAsDataURL(file);
        });
    },

    readAsText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result || '');
            reader.onerror = () => reject(new Error('error leyendo archivo de texto'));
            reader.readAsText(file);
        });
    },

    async readPdfAsText(file) {
        if (!window.pdfjsLib) throw new Error('PDF parser no disponible');
        const arrayBuffer = await file.arrayBuffer();
        const loadingTask = window.pdfjsLib.getDocument({ data: arrayBuffer });
        const pdf = await loadingTask.promise;

        const pages = [];
        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            const page = await pdf.getPage(pageNum);
            const textContent = await page.getTextContent();
            const text = textContent.items.map(item => item.str).join(' ').replace(/\s+/g, ' ').trim();
            if (text) pages.push(`[Página ${pageNum}] ${text}`);
        }

        if (pages.length === 0) return '[PDF sin texto extraíble o escaneado como imagen]';
        return pages.join('\n\n');
    },

    async readDocxAsText(file) {
        if (!window.mammoth) throw new Error('DOCX parser no disponible');
        const arrayBuffer = await file.arrayBuffer();
        const result = await window.mammoth.extractRawText({ arrayBuffer });
        return result.value?.trim() || '[DOCX sin texto extraíble]';
    },

    // ==================== Message sending ====================

    buildUserContent(text, attachments) {
        if (!attachments || attachments.length === 0) return text;
        const parts = [];
        const textParts = [text];
        for (const att of attachments) {
            if (att.type === 'image') parts.push({ type: 'input_image', image_url: att.data });
            else textParts.push(`\n--- ${att.name} ---\n${att.data}`);
        }
        parts.unshift({ type: 'input_text', text: textParts.join('\n') });
        return parts;
    },

    async sendMessage() {
        if (this.isLoading) return;
        let text = UI.getInputText();
        if (!text && this.pendingAttachments.length === 0) return;
        if (!text) text = '(adjunto)';

        const preset = Config.getCurrentPreset();
        const apiKey = this.getApiKey(preset);
        if (!apiKey) {
            UI.addMessage('error', 'Abre la configuración y pon tu API key.');
            return;
        }

        const content = this.buildUserContent(text, this.pendingAttachments);
        const displayAtts = [...this.pendingAttachments];
        this.clearAttachments();

        const msgIdx = UI.elements.chat.querySelectorAll('.msg').length;
        UI.addMessage('user', text, { attachments: displayAtts, msgIdx });
        this.conversationHistory.push({ role: 'user', content });
        UI.clearInput();
        await this.doSend(preset, apiKey);
    },

    async doSend(preset, apiKey) {
        this.isLoading = true;
        UI.enableInput(false);
        UI.showTyping(true);
        UI.scrollToBottom();

        const startTime = Date.now();
        try {
            const data = await API.call(this.conversationHistory, preset, apiKey, this.systemPrompt, this.ragChunkIds);
            const result = API.extractResponse(data);
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            const tokens = data.usage ? `${data.usage.total_tokens} tok` : '';
            const meta = `${preset.name} · ${elapsed}s ${tokens}`;

            // Update carryover chunk IDs for next RAG turn
            if (data.contextChunkIds) this.ragChunkIds = data.contextChunkIds;

            UI.addMessage('assistant', result.text, { reasoning: result.reasoning, meta });
            this.conversationHistory.push({ role: 'assistant', content: result.text });
            this.saveCurrentConversation();
        } catch (err) {
            UI.addMessage('error', err.message);
        }

        UI.showTyping(false);
        this.isLoading = false;
        UI.enableInput(true);
        UI.focusInput();
        UI.scrollToBottom();
    },

    async regenerate() {
        if (this.isLoading || this.conversationHistory.length < 2) return;
        if (this.conversationHistory[this.conversationHistory.length - 1].role === 'assistant') {
            this.conversationHistory.pop();
        }
        UI.removeLastAssistantMessage();
        const preset = Config.getCurrentPreset();
        const apiKey = this.getApiKey(preset);
        await this.doSend(preset, apiKey);
    },

    editMessage(msgIdx) {
        if (this.isLoading) return;
        const msgDivs = UI.elements.chat.querySelectorAll('.msg');
        const div = msgDivs[msgIdx];
        if (!div) return;

        let histIdx = -1;
        let count = 0;
        for (let i = 0; i < this.conversationHistory.length; i++) {
            const h = this.conversationHistory[i];
            if (h.role === 'user' || h.role === 'assistant') {
                if (count === msgIdx) { histIdx = i; break; }
                count++;
            }
        }
        if (histIdx < 0) return;

        const origContent = this.conversationHistory[histIdx].content;
        let origText = typeof origContent === 'string' ? origContent : '';
        if (Array.isArray(origContent)) {
            const textPart = origContent.find(p => p.type === 'input_text');
            if (textPart) origText = textPart.text;
        }

        UI.enterEditMode(div, origText,
            async (newText) => {
                this.conversationHistory = this.conversationHistory.slice(0, histIdx);
                this.conversationHistory.push({ role: 'user', content: newText });
                this.rebuildChat();
                const preset = Config.getCurrentPreset();
                const apiKey = this.getApiKey(preset);
                await this.doSend(preset, apiKey);
            },
            () => this.rebuildChat()
        );
    },

    // ==================== API Key helpers ====================

    getApiKey(preset) {
        if (preset.provider === 'rag') return UI.elements.apiKeyRag?.value.trim() || '';
        if (preset.provider === 'kimi') return UI.elements.apiKeyKimi?.value.trim() || '';
        return UI.elements.apiKey?.value.trim() || '';
    },

    // ==================== Export ====================

    exportChat() {
        if (this.conversationHistory.length === 0) return;
        let md = '# Conversación\n\n';
        for (const h of this.conversationHistory) {
            let text = typeof h.content === 'string' ? h.content : '';
            if (Array.isArray(h.content)) {
                const textPart = h.content.find(p => p.type === 'input_text');
                if (textPart) text = textPart.text;
            }
            if (h.role === 'user') md += `## Usuario\n\n${text}\n\n`;
            else if (h.role === 'assistant') md += `## Asistente\n\n${text}\n\n`;
        }
        const blob = new Blob([md], { type: 'text/markdown' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `conversacion-${new Date().toISOString().slice(0, 10)}.md`;
        a.click();
    },

    // ==================== Test connection ====================

    async testConnection() {
        const preset = Config.getCurrentPreset();
        const apiKey = this.getApiKey(preset);
        if (preset.provider !== 'rag' && !apiKey) {
            UI.setStatus('Pon tu API key', '');
            return;
        }
        UI.setStatus(`Probando ${preset.name}...`, 'testing');
        try {
            const testMsgs = [{ role: 'user', content: 'Di OK' }];
            await API.call(testMsgs, preset, apiKey, '');
            UI.setStatus(`${preset.name} - Conectado`, 'connected');
            UI.enableInput(true);
            UI.focusInput();
        } catch (err) {
            UI.setStatus(`Error: ${err.message.substring(0, 100)}`, 'error');
        }
    },
};
