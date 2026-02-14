/**
 * UI manipulation and rendering
 */
const UI = {
    // DOM element references (initialized in init())
    elements: {},
    
    /**
     * Initialize element references
     */
    init() {
        this.elements = {
            chat: document.getElementById('chat'),
            input: document.getElementById('user-input'),
            sendBtn: document.getElementById('btn-send'),
            typing: document.getElementById('typing'),
            status: document.getElementById('status'),
            statusDot: document.getElementById('status-dot'),
            fileInput: document.getElementById('file-input'),
            previewArea: document.getElementById('preview-area'),
            historyList: document.getElementById('history-list'),
            sidebar: document.getElementById('sidebar'),
            sidebarOverlay: document.getElementById('sidebar-overlay'),
            modelSelect: document.getElementById('model-select'),
            configSection: document.getElementById('config-section'),
            configArrow: document.getElementById('config-arrow'),
            apiKey: document.getElementById('api-key'),
            apiKeyKimi: document.getElementById('api-key-kimi'),
            apiKeyRag: document.getElementById('api-key-rag'),
            systemPrompt: document.getElementById('system-prompt'),
            keyGroupOpenai: document.getElementById('key-group-openai'),
            keyGroupKimi: document.getElementById('key-group-kimi'),
            keyGroupRag: document.getElementById('key-group-rag'),
            systemPromptGroup: document.getElementById('system-prompt-group')
        };
    },
    
    // ==================== Status ====================
    
    setStatus(text, className = '') {
        this.elements.status.textContent = text;
        this.elements.statusDot.className = 'status-dot ' + className;
    },
    
    updateStatusFromPreset(preset, hasKey) {
        if (preset.provider === 'rag') {
            const ragKey = this.elements.apiKeyRag?.value.trim();
            if (ragKey) {
                this.setStatus(`${preset.name} - Listo`, 'connected');
                this.enableInput(true);
            } else {
                this.setStatus('Sin Function Key (RAG)', '');
            }
            return;
        }
        
        if (hasKey) {
            this.setStatus(`${preset.name} - Listo`, 'connected');
            this.enableInput(true);
        } else {
            this.setStatus(`Sin API key (${preset.provider})`, '');
        }
    },
    
    // ==================== Input ====================
    
    enableInput(enabled) {
        this.elements.input.disabled = !enabled;
        this.elements.sendBtn.disabled = !enabled;
    },
    
    clearInput() {
        this.elements.input.value = '';
        this.elements.input.style.height = 'auto';
    },
    
    focusInput() {
        this.elements.input.focus();
    },
    
    getInputText() {
        return this.elements.input.value.trim();
    },
    
    // ==================== Typing indicator ====================
    
    showTyping(visible) {
        this.elements.typing.classList.toggle('visible', visible);
    },
    
    // ==================== Sidebar ====================
    
    toggleSidebar() {
        this.elements.sidebar.classList.toggle('open');
        this.elements.sidebarOverlay.classList.toggle('open');
    },
    
    closeSidebar() {
        this.elements.sidebar.classList.remove('open');
        this.elements.sidebarOverlay.classList.remove('open');
    },
    
    toggleConfigSection() {
        const isOpen = this.elements.configSection.classList.toggle('open');
        this.elements.configArrow.textContent = isOpen ? '▼' : '▶';
    },
    
    // ==================== Model select ====================
    
    populateModelSelect() {
        const select = this.elements.modelSelect;
        select.innerHTML = '';
        
        for (const preset of Config.MODEL_PRESETS) {
            const option = document.createElement('option');
            option.value = preset.id;
            option.textContent = preset.name;
            select.appendChild(option);
        }
    },
    
    setSelectedModel(modelId) {
        this.elements.modelSelect.value = modelId;
    },
    
    updateKeyFieldsVisibility(preset) {
        this.elements.keyGroupOpenai.style.display = preset.provider === 'azure-openai' ? 'flex' : 'none';
        this.elements.keyGroupKimi.style.display = preset.provider === 'kimi' ? 'flex' : 'none';
        this.elements.keyGroupRag.style.display = preset.provider === 'rag' ? 'flex' : 'none';
        this.elements.systemPromptGroup.style.display = preset.provider === 'rag' ? 'none' : 'flex';
    },
    
    // ==================== History list ====================
    
    renderHistoryList(history, currentId) {
        const container = this.elements.historyList;
        container.innerHTML = '';
        
        if (history.length === 0) {
            container.innerHTML = '<div class="history-empty">Sin conversaciones</div>';
            return;
        }
        
        for (const conv of history) {
            const el = document.createElement('div');
            el.className = 'history-item' + (conv.id === currentId ? ' active' : '');
            el.dataset.id = conv.id;
            
            const nMsgs = conv.messages?.length || 0;
            const title = (conv.title || '(sin titulo)').replace(/</g, '&lt;');
            
            el.innerHTML = `
                <div class="hi-title">${title}</div>
                <div class="hi-meta">${nMsgs} msgs</div>
                <button class="hi-del" data-id="${conv.id}" title="Eliminar">✕</button>
            `;
            
            container.appendChild(el);
        }
    },
    
    // ==================== Attachments preview ====================
    
    renderPreviews(attachments) {
        const area = this.elements.previewArea;
        area.innerHTML = '';
        
        if (attachments.length === 0) {
            area.style.display = 'none';
            return;
        }
        
        for (let i = 0; i < attachments.length; i++) {
            const att = attachments[i];
            const el = document.createElement('div');
            el.className = 'preview-item';
            el.dataset.idx = i;
            
            if (att.type === 'image') {
                el.innerHTML = `
                    <img src="${att.data}" alt="">
                    <span>${att.name}</span>
                    <button data-idx="${i}">✕</button>
                `;
            } else {
                const size = att.data.length > 1000 
                    ? Math.round(att.data.length / 1024) + 'KB' 
                    : att.data.length + 'B';
                el.innerHTML = `
                    <span class="file-icon">📄</span>
                    <span>${att.name} (${size})</span>
                    <button data-idx="${i}">✕</button>
                `;
            }
            
            area.appendChild(el);
        }
        
        area.style.display = 'flex';
    },
    
    clearPreviews() {
        this.elements.previewArea.innerHTML = '';
        this.elements.previewArea.style.display = 'none';
    },
    
    // ==================== Messages ====================
    
    addMessage(role, text, options = {}) {
        const { reasoning, meta, attachments, msgIdx } = options;
        const div = document.createElement('div');
        div.className = 'msg ' + role;
        
        if (role === 'user') {
            let inner = '<div class="msg-content">';
            
            if (attachments?.length > 0) {
                inner += '<div class="msg-attachments">';
                for (const att of attachments) {
                    if (att.type === 'image') {
                        inner += `<img class="msg-thumb" src="${att.data}" alt="">`;
                    } else {
                        inner += `<span class="msg-file">📄 ${att.name}</span>`;
                    }
                }
                inner += '</div>';
            }
            
            inner += `<span>${this.escapeHtml(text)}</span></div>`;
            inner += `<div class="msg-actions"><button data-action="edit" data-idx="${msgIdx}" title="Editar">✎</button></div>`;
            div.innerHTML = inner;
            
        } else if (role === 'assistant') {
            let inner = '';
            
            if (reasoning) {
                const tid = 'think-' + Date.now();
                inner += `<div class="thinking-toggle" data-target="${tid}">▶ Razonamiento</div>`;
                inner += `<div class="thinking-content" id="${tid}">${this.escapeHtml(reasoning)}</div>`;
            }
            
            inner += `<div class="content">${this.formatContent(text)}</div>`;
            
            if (meta) {
                inner += `<div class="msg-meta">${meta}</div>`;
            }
            
            inner += `<div class="msg-actions">
                <button data-action="regenerate" title="Regenerar">🔄</button>
                <button data-action="copy" title="Copiar todo">📋</button>
            </div>`;
            
            div.innerHTML = inner;
            
        } else {
            // Error
            div.textContent = text;
        }
        
        this.elements.chat.appendChild(div);
        this.scrollToBottom();
        
        return div;
    },
    
    clearChat() {
        this.elements.chat.innerHTML = '';
    },
    
    scrollToBottom() {
        this.elements.chat.scrollTop = this.elements.chat.scrollHeight;
    },
    
    removeLastAssistantMessage() {
        const msgs = this.elements.chat.querySelectorAll('.msg.assistant');
        if (msgs.length > 0) {
            msgs[msgs.length - 1].remove();
        }
    },
    
    // ==================== Edit mode ====================
    
    enterEditMode(msgDiv, originalText, onSave, onCancel) {
        msgDiv.innerHTML = '';
        msgDiv.classList.add('editing');
        
        const ta = document.createElement('textarea');
        ta.className = 'edit-textarea';
        ta.value = originalText;
        msgDiv.appendChild(ta);
        
        const btns = document.createElement('div');
        btns.className = 'edit-btns';
        
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancelar';
        cancelBtn.className = 'action-btn';
        cancelBtn.onclick = onCancel;
        
        const saveBtn = document.createElement('button');
        saveBtn.textContent = 'Enviar';
        saveBtn.className = 'action-btn primary';
        saveBtn.onclick = () => {
            const newText = ta.value.trim();
            if (newText) onSave(newText);
        };
        
        btns.appendChild(cancelBtn);
        btns.appendChild(saveBtn);
        msgDiv.appendChild(btns);
        
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        
        ta.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                saveBtn.click();
            }
            if (e.key === 'Escape') {
                cancelBtn.click();
            }
        });
    },
    
    // ==================== Formatting ====================
    
    escapeHtml(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    },
    
    formatContent(text) {
        let html = this.escapeHtml(text);
        
        // Code blocks (must be first to avoid processing inside them)
        const codeBlocks = [];
        html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
            const label = lang ? `<span class="code-lang">${lang}</span>` : '';
            const placeholder = `%%CODEBLOCK${codeBlocks.length}%%`;
            codeBlocks.push(`<pre class="code-block">${label}<button class="copy-btn" data-action="copy-code">Copiar</button><code>${code.trim()}</code></pre>`);
            return placeholder;
        });
        
        // Process line by line for block elements
        const lines = html.split('\n');
        const output = [];
        let inList = false;
        let listType = null; // 'ul' or 'ol'

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];

            // Code block placeholder — pass through
            if (line.match(/%%CODEBLOCK\d+%%/)) {
                if (inList) { output.push(`</${listType}>`); inList = false; }
                output.push(line);
                continue;
            }

            // Headers
            const headerMatch = line.match(/^(#{1,4})\s+(.+)$/);
            if (headerMatch) {
                if (inList) { output.push(`</${listType}>`); inList = false; }
                const level = headerMatch[1].length;
                output.push(`<h${level + 1}>${this._inlineFormat(headerMatch[2])}</h${level + 1}>`);
                continue;
            }

            // Horizontal rule
            if (line.match(/^---+$/)) {
                if (inList) { output.push(`</${listType}>`); inList = false; }
                output.push('<hr>');
                continue;
            }

            // Unordered list item (- or *)
            const ulMatch = line.match(/^(\s*)[-*]\s+(.+)$/);
            if (ulMatch) {
                if (!inList || listType !== 'ul') {
                    if (inList) output.push(`</${listType}>`);
                    output.push('<ul>');
                    inList = true;
                    listType = 'ul';
                }
                output.push(`<li>${this._inlineFormat(ulMatch[2])}</li>`);
                continue;
            }

            // Ordered list item
            const olMatch = line.match(/^(\s*)\d+[.)]\s+(.+)$/);
            if (olMatch) {
                if (!inList || listType !== 'ol') {
                    if (inList) output.push(`</${listType}>`);
                    output.push('<ol>');
                    inList = true;
                    listType = 'ol';
                }
                output.push(`<li>${this._inlineFormat(olMatch[2])}</li>`);
                continue;
            }

            // Close list if we hit a non-list line
            if (inList) {
                output.push(`</${listType}>`);
                inList = false;
            }

            // Empty line = paragraph break
            if (line.trim() === '') {
                output.push('<br>');
                continue;
            }

            // Regular paragraph line
            output.push(`<p>${this._inlineFormat(line)}</p>`);
        }

        if (inList) output.push(`</${listType}>`);

        html = output.join('\n');

        // Restore code blocks
        for (let i = 0; i < codeBlocks.length; i++) {
            html = html.replace(`%%CODEBLOCK${i}%%`, codeBlocks[i]);
        }

        return html;
    },

    _inlineFormat(text) {
        // Bold
        text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        // Italic
        text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
        // Inline code
        text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
        return text;
    },
    
    // ==================== Save button feedback ====================
    
    showSaveSuccess(btn) {
        const original = btn.textContent;
        btn.textContent = '✓ Guardado';
        setTimeout(() => { btn.textContent = original; }, 1500);
    }
};

window.UI = UI;
