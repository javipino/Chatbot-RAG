// Azure Function - Sirve la pagina del chat (v6 - multi-model dropdown)
// Crear como funcion en el portal: Nombre "page", Trigger HTTP, GET, Anonymous

module.exports = async function (context, req) {
    // Get function key from environment (set in Azure Function App Configuration)
    const FUNCTION_KEY = process.env.AZURE_FUNCTION_KEY || '';
    const CHAT_ENDPOINT_URL = FUNCTION_KEY ? `/api/api?code=${FUNCTION_KEY}` : '/api/api';

    var JS_CODE = [
        'var chatEl = document.getElementById("chat");',
        'var inputEl = document.getElementById("user-input");',
        'var sendBtn = document.getElementById("btn-send");',
        'var typingEl = document.getElementById("typing");',
        'var statusEl = document.getElementById("status");',
        'var fileInput = document.getElementById("file-input");',
        'var previewArea = document.getElementById("preview-area");',
        'var conversationHistory = [];',
        'var systemPrompt = "";',
        'var isLoading = false;',
        'var pendingAttachments = [];',
        'var currentConvId = null;',
        `var CHAT_ENDPOINT = "${CHAT_ENDPOINT_URL}";`,
        '',
        '// ========== MODEL PRESETS ==========',
        'var MODEL_PRESETS = [',
        '    {',
        '        id: "gpt-5.2-codex",',
        '        name: "GPT-5.2 Codex",',
        '        provider: "azure-openai",',
        '        format: "responses",',
        '        host: "javie-mku5l3k8-swedencentral.cognitiveservices.azure.com",',
        '        path: "/openai/responses?api-version=2025-04-01-preview"',
        '    },',
        '    {',
        '        id: "gpt-5.2",',
        '        name: "GPT-5.2",',
        '        provider: "azure-openai",',
        '        format: "responses",',
        '        host: "javie-mku5l3k8-swedencentral.cognitiveservices.azure.com",',
        '        path: "/openai/responses?api-version=2025-04-01-preview"',
        '    },',
        '    {',
        '        id: "Kimi-K2.5",',
        '        name: "Kimi K2.5",',
        '        provider: "kimi",',
        '        format: "chat-completions",',
        '        host: "openai-reader-javi.services.ai.azure.com",',
        '        path: "/openai/v1/chat/completions"',
        '    },',
        '    {',
        '        id: "ss-expert",',
        '        name: "SS Expert (RAG)",',
        '        provider: "rag",',
        '        format: "rag"',
        '    }',
        '];',
        'var RAG_ENDPOINT = "/api/rag";',
        '',
        'function getPreset() {',
        '    var sel = document.getElementById("model-select").value;',
        '    for (var i = 0; i < MODEL_PRESETS.length; i++) {',
        '        if (MODEL_PRESETS[i].id === sel) return MODEL_PRESETS[i];',
        '    }',
        '    return MODEL_PRESETS[0];',
        '}',
        '',
        '// --- Auto-resize ---',
        'inputEl.addEventListener("input", function() {',
        '    inputEl.style.height = "auto";',
        '    inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + "px";',
        '});',
        'inputEl.addEventListener("keydown", function(e) {',
        '    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }',
        '});',
        '',
        '// --- Sidebar toggle (mobile) ---',
        'function toggleSidebar() {',
        '    document.getElementById("sidebar").classList.toggle("open");',
        '    document.getElementById("sidebar-overlay").classList.toggle("open");',
        '}',
        'function closeSidebar() {',
        '    document.getElementById("sidebar").classList.remove("open");',
        '    document.getElementById("sidebar-overlay").classList.remove("open");',
        '}',
        'document.getElementById("sidebar-overlay").addEventListener("click", closeSidebar);',
        '',
        '// --- Config ---',
        'function getApiKey() {',
        '    var preset = getPreset();',
        '    if (preset.provider === "rag") return document.getElementById("api-key-rag").value.trim();',
        '    if (preset.provider === "kimi") return document.getElementById("api-key-kimi").value.trim();',
        '    return document.getElementById("api-key").value.trim();',
        '}',
        'function getModel() { return document.getElementById("model-select").value; }',
        '',
        '// --- Show/hide provider key fields based on selected model ---',
        'function onModelChange() {',
        '    var preset = getPreset();',
        '    document.getElementById("key-group-openai").style.display = preset.provider === "azure-openai" ? "flex" : "none";',
        '    document.getElementById("key-group-kimi").style.display = preset.provider === "kimi" ? "flex" : "none";',
        '    document.getElementById("key-group-rag").style.display = preset.provider === "rag" ? "flex" : "none";',
        '    var spGroup = document.getElementById("system-prompt").parentElement;',
        '    if (preset.provider === "rag") { spGroup.style.display = "none"; } else { spGroup.style.display = "flex"; }',
        '    updateStatusDot();',
        '}',
        '',
        'document.getElementById("model-select").addEventListener("change", onModelChange);',
        '',
        'function saveConfig() {',
        '    systemPrompt = document.getElementById("system-prompt").value.trim();',
        '    try {',
        '        localStorage.setItem("azure-chat-key", document.getElementById("api-key").value.trim());',
        '        localStorage.setItem("azure-chat-key-kimi", document.getElementById("api-key-kimi").value.trim());',
        '        localStorage.setItem("azure-chat-model", getModel());',
        '        localStorage.setItem("azure-chat-systemprompt", systemPrompt);',
        '    } catch(e) {}',
        '    updateStatusDot();',
        '    var btn = document.getElementById("btn-save-config");',
        '    btn.textContent = "\\u2713 Guardado";',
        '    setTimeout(function() { btn.textContent = "Guardar"; }, 1500);',
        '}',
        '',
        'function updateStatusDot() {',
        '    var dot = document.getElementById("status-dot");',
        '    var label = document.getElementById("status");',
        '    var preset = getPreset();',
        '    if (preset.provider === "rag") {',
        '        var ragKey = document.getElementById("api-key-rag").value.trim();',
        '        if (ragKey) {',
        '            dot.className = "status-dot connected";',
        '            label.textContent = preset.name + " - Listo";',
        '            inputEl.disabled = false; sendBtn.disabled = false;',
        '        } else {',
        '            dot.className = "status-dot";',
        '            label.textContent = "Sin Function Key (RAG)";',
        '        }',
        '        return;',
        '    }',
        '    var hasKey = getApiKey();',
        '    if (hasKey) {',
        '        dot.className = "status-dot connected";',
        '        if (label.textContent === "Sin API key") label.textContent = preset.name + " - Listo";',
        '    } else {',
        '        dot.className = "status-dot";',
        '        label.textContent = "Sin API key (" + preset.provider + ")";',
        '    }',
        '}',
        '',
        '// --- New chat ---',
        'function newChat() {',
        '    if (conversationHistory.length > 0) saveCurrentConversation();',
        '    conversationHistory = [];',
        '    currentConvId = null;',
        '    chatEl.innerHTML = "";',
        '    clearAttachments();',
        '    renderHistoryList();',
        '}',
        '',
        '// ========== HISTORY PERSISTENCE ==========',
        '',
        'function generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2, 5); }',
        '',
        'function getConversationTitle(msgs) {',
        '    for (var i = 0; i < msgs.length; i++) {',
        '        if (msgs[i].role === "user") {',
        '            var t = typeof msgs[i].content === "string" ? msgs[i].content : "";',
        '            if (Array.isArray(msgs[i].content)) {',
        '                for (var k = 0; k < msgs[i].content.length; k++) {',
        '                    if (msgs[i].content[k].type === "input_text") { t = msgs[i].content[k].text; break; }',
        '                }',
        '            }',
        '            return t.length > 40 ? t.substring(0, 40) + "..." : t;',
        '        }',
        '    }',
        '    return "(sin titulo)";',
        '}',
        '',
        'function saveCurrentConversation() {',
        '    if (conversationHistory.length === 0) return;',
        '    try {',
        '        var list = JSON.parse(localStorage.getItem("azure-chat-history") || "[]");',
        '        var lightHistory = conversationHistory.map(function(m) {',
        '            if (m.role === "user" && Array.isArray(m.content)) {',
        '                var filtered = m.content.map(function(p) {',
        '                    if (p.type === "input_image") return { type: "input_image", image_url: "(imagen)" };',
        '                    return p;',
        '                });',
        '                return { role: m.role, content: filtered };',
        '            }',
        '            return m;',
        '        });',
        '        if (!currentConvId) currentConvId = generateId();',
        '        var exists = false;',
        '        for (var i = 0; i < list.length; i++) {',
        '            if (list[i].id === currentConvId) {',
        '                list[i].messages = lightHistory;',
        '                list[i].title = getConversationTitle(lightHistory);',
        '                list[i].updated = Date.now();',
        '                exists = true;',
        '                break;',
        '            }',
        '        }',
        '        if (!exists) {',
        '            list.unshift({ id: currentConvId, title: getConversationTitle(lightHistory), created: Date.now(), updated: Date.now(), messages: lightHistory });',
        '        }',
        '        if (list.length > 50) list = list.slice(0, 50);',
        '        localStorage.setItem("azure-chat-history", JSON.stringify(list));',
        '        localStorage.setItem("azure-chat-current", currentConvId);',
        '        renderHistoryList();',
        '    } catch(e) { console.error("Save error:", e); }',
        '}',
        '',
        'function loadConversation(id) {',
        '    try {',
        '        var list = JSON.parse(localStorage.getItem("azure-chat-history") || "[]");',
        '        for (var i = 0; i < list.length; i++) {',
        '            if (list[i].id === id) {',
        '                if (conversationHistory.length > 0 && currentConvId !== id) saveCurrentConversation();',
        '                conversationHistory = list[i].messages;',
        '                currentConvId = id;',
        '                localStorage.setItem("azure-chat-current", id);',
        '                rebuildChat();',
        '                renderHistoryList();',
        '                closeSidebar();',
        '                return;',
        '            }',
        '        }',
        '    } catch(e) {}',
        '}',
        '',
        'function deleteConversation(id, evt) {',
        '    if (evt) evt.stopPropagation();',
        '    try {',
        '        var list = JSON.parse(localStorage.getItem("azure-chat-history") || "[]");',
        '        list = list.filter(function(c) { return c.id !== id; });',
        '        localStorage.setItem("azure-chat-history", JSON.stringify(list));',
        '        if (currentConvId === id) { currentConvId = null; conversationHistory = []; chatEl.innerHTML = ""; }',
        '        renderHistoryList();',
        '    } catch(e) {}',
        '}',
        '',
        'function renderHistoryList() {',
        '    var container = document.getElementById("history-list");',
        '    var q = String.fromCharCode(39);',
        '    container.innerHTML = "";',
        '    try {',
        '        var list = JSON.parse(localStorage.getItem("azure-chat-history") || "[]");',
        '        if (list.length === 0) {',
        '            container.innerHTML = "<div class=\\"history-empty\\">Sin conversaciones</div>";',
        '            return;',
        '        }',
        '        for (var i = 0; i < list.length; i++) {',
        '            var c = list[i];',
        '            var el = document.createElement("div");',
        '            el.className = "history-item" + (c.id === currentConvId ? " active" : "");',
        '            var nMsgs = c.messages ? c.messages.length : 0;',
        '            el.innerHTML = "<div class=\\"hi-title\\">" + (c.title || "(sin titulo)").replace(/</g,"&lt;") + "</div><div class=\\"hi-meta\\">" + nMsgs + " msgs</div><button class=\\"hi-del\\" onclick=\\"deleteConversation(" + q + c.id + q + ", event)\\" title=\\"Eliminar\\">&#x2715;</button>";',
        '            el.setAttribute("onclick", "loadConversation(" + q + c.id + q + ")");',
        '            container.appendChild(el);',
        '        }',
        '    } catch(e) {}',
        '}',
        '',
        '// --- Toggle config section in sidebar ---',
        'function toggleConfigSection() {',
        '    var sec = document.getElementById("config-section");',
        '    var arrow = document.getElementById("config-arrow");',
        '    var isOpen = sec.style.display !== "none";',
        '    sec.style.display = isOpen ? "none" : "flex";',
        '    arrow.textContent = isOpen ? "\\u25B6" : "\\u25BC";',
        '}',
        '',
        '// --- Test ---',
        'function testConnection() {',
        '    var key = getApiKey();',
        '    if (!key) { setStatus("Pon tu API key", "#ffaa00"); return; }',
        '    setStatus("Probando " + getPreset().name + "...", "#8899aa");',
        '    var dot = document.getElementById("status-dot");',
        '    dot.className = "status-dot testing";',
        '    var preset = getPreset();',
        '    var testMsgs = (preset.format === "chat-completions")',
        '        ? [{ role: "user", content: "Di OK" }]',
        '        : [{ role: "user", content: "Di OK" }];',
        '    callAPI(testMsgs)',
        '        .then(function() {',
        '            setStatus(preset.name + " - Conectado", "#4ade80");',
        '            dot.className = "status-dot connected";',
        '            inputEl.disabled = false;',
        '            sendBtn.disabled = false;',
        '            inputEl.focus();',
        '        })',
        '        .catch(function(err) {',
        '            setStatus("Error: " + err.message.substring(0, 40), "#f87171");',
        '            dot.className = "status-dot error";',
        '        });',
        '}',
        '',
        '// ========== FILE ATTACHMENTS ==========',
        '',
        'function triggerFileInput() { fileInput.click(); }',
        '',
        'fileInput.addEventListener("change", function() {',
        '    handleFiles(fileInput.files);',
        '    fileInput.value = "";',
        '});',
        '',
        'inputEl.addEventListener("paste", function(e) {',
        '    var items = e.clipboardData && e.clipboardData.items;',
        '    if (!items) return;',
        '    for (var i = 0; i < items.length; i++) {',
        '        if (items[i].type.indexOf("image") === 0) {',
        '            e.preventDefault();',
        '            handleFiles([items[i].getAsFile()]);',
        '            return;',
        '        }',
        '    }',
        '});',
        '',
        'document.body.addEventListener("dragover", function(e) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; chatEl.classList.add("drag-over"); });',
        'document.body.addEventListener("dragleave", function(e) { chatEl.classList.remove("drag-over"); });',
        'document.body.addEventListener("drop", function(e) { e.preventDefault(); chatEl.classList.remove("drag-over"); handleFiles(e.dataTransfer.files); });',
        '',
        'function handleFiles(files) {',
        '    for (var i = 0; i < files.length; i++) {',
        '        var file = files[i];',
        '        if (file.type.indexOf("image") === 0) {',
        '            readAsDataURL(file);',
        '        } else {',
        '            readAsText(file);',
        '        }',
        '    }',
        '}',
        '',
        'function readAsDataURL(file) {',
        '    var reader = new FileReader();',
        '    reader.onload = function(e) {',
        '        pendingAttachments.push({ type: "image", name: file.name, data: e.target.result });',
        '        renderPreviews();',
        '    };',
        '    reader.readAsDataURL(file);',
        '}',
        '',
        'function readAsText(file) {',
        '    var reader = new FileReader();',
        '    reader.onload = function(e) {',
        '        pendingAttachments.push({ type: "text", name: file.name, data: e.target.result });',
        '        renderPreviews();',
        '    };',
        '    reader.readAsText(file);',
        '}',
        '',
        'function renderPreviews() {',
        '    previewArea.innerHTML = "";',
        '    for (var i = 0; i < pendingAttachments.length; i++) {',
        '        var att = pendingAttachments[i];',
        '        var el = document.createElement("div");',
        '        el.className = "preview-item";',
        '        el.setAttribute("data-idx", i);',
        '        if (att.type === "image") {',
        '            el.innerHTML = \'<img src="\' + att.data + \'" alt=""><span>\' + att.name + \'</span><button onclick="removeAttachment(\' + i + \')">&#x2715;</button>\';',
        '        } else {',
        '            el.innerHTML = \'<span class="file-icon">&#x1F4C4;</span><span>\' + att.name + \' (\' + (att.data.length > 1000 ? Math.round(att.data.length/1024) + "KB" : att.data.length + "B") + \')</span><button onclick="removeAttachment(\' + i + \')">&#x2715;</button>\';',
        '        }',
        '        previewArea.appendChild(el);',
        '    }',
        '    previewArea.style.display = pendingAttachments.length ? "flex" : "none";',
        '}',
        '',
        'function removeAttachment(idx) {',
        '    pendingAttachments.splice(idx, 1);',
        '    renderPreviews();',
        '}',
        '',
        'function clearAttachments() {',
        '    pendingAttachments = [];',
        '    previewArea.innerHTML = "";',
        '    previewArea.style.display = "none";',
        '}',
        '',
        '// ========== API ==========',
        '',
        'function callAPI(messages) {',
        '    var apiKey = getApiKey();',
        '    var preset = getPreset();',
        '',
        '    // RAG mode - no API key needed, uses server-side keys',
        '    if (preset.format === "rag") {',
        '        var ragMsgs = [];',
        '        for (var i = 0; i < messages.length; i++) {',
        '            var m = messages[i];',
        '            if (m.role === "user" || m.role === "assistant") {',
        '                var txt = typeof m.content === "string" ? m.content : "";',
        '                if (Array.isArray(m.content)) {',
        '                    for (var k = 0; k < m.content.length; k++) {',
        '                        if (m.content[k].type === "input_text") { txt = m.content[k].text; break; }',
        '                    }',
        '                }',
        '                ragMsgs.push({ role: m.role, content: txt });',
        '            }',
        '        }',
        '        return fetch(RAG_ENDPOINT, {',
        '            method: "POST",',
        '            headers: { "Content-Type": "application/json" },',
        '            body: JSON.stringify({ messages: ragMsgs })',
        '        }).then(function(resp) {',
        '            if (!resp.ok) {',
        '                return resp.text().then(function(t) { throw new Error("HTTP " + resp.status + ": " + t.substring(0, 200)); });',
        '            }',
        '            return resp.json();',
        '        });',
        '    }',
        '',
        '    if (!apiKey) return Promise.reject(new Error("API key vacia"));',
        '',
        '    var body = {};',
        '    body._apikey = apiKey;',
        '    body._host = preset.host;',
        '    body._path = preset.path;',
        '',
        '    if (preset.format === "chat-completions") {',
        '        // Chat Completions format (Kimi, etc.)',
        '        var chatMsgs = [];',
        '        if (systemPrompt) { chatMsgs.push({ role: "system", content: systemPrompt }); }',
        '        for (var i = 0; i < messages.length; i++) {',
        '            var m = messages[i];',
        '            if (m.role === "user") {',
        '                if (Array.isArray(m.content)) {',
        '                    var parts = [];',
        '                    for (var j = 0; j < m.content.length; j++) {',
        '                        var p = m.content[j];',
        '                        if (p.type === "input_text") { parts.push({ type: "text", text: p.text }); }',
        '                        else if (p.type === "input_image" && p.image_url !== "(imagen)") { parts.push({ type: "image_url", image_url: { url: p.image_url } }); }',
        '                    }',
        '                    chatMsgs.push({ role: "user", content: parts });',
        '                } else {',
        '                    chatMsgs.push({ role: "user", content: m.content });',
        '                }',
        '            } else if (m.role === "assistant") {',
        '                chatMsgs.push({ role: "assistant", content: m.content });',
        '            }',
        '        }',
        '        body.model = preset.id;',
        '        body.messages = chatMsgs;',
        '    } else {',
        '        // Responses API format (Azure OpenAI GPT)',
        '        var input = [];',
        '        if (systemPrompt) { input.push({ role: "developer", content: systemPrompt }); }',
        '        for (var i = 0; i < messages.length; i++) {',
        '            var m = messages[i];',
        '            if (m.role === "user" && Array.isArray(m.content)) {',
        '                var cleaned = m.content.filter(function(p) {',
        '                    return !(p.type === "input_image" && p.image_url === "(imagen)");',
        '                });',
        '                input.push({ role: "user", content: cleaned.length === 1 && cleaned[0].type === "input_text" ? cleaned[0].text : cleaned });',
        '            } else {',
        '                input.push(m);',
        '            }',
        '        }',
        '        body.input = input;',
        '        body.model = preset.id;',
        '    }',
        '',
        '    return fetch(CHAT_ENDPOINT, {',
        '        method: "POST",',
        '        headers: { "Content-Type": "application/json" },',
        '        body: JSON.stringify(body)',
        '    }).then(function(resp) {',
        '        if (!resp.ok) {',
        '            return resp.text().then(function(t) { throw new Error("HTTP " + resp.status + ": " + t.substring(0, 200)); });',
        '        }',
        '        return resp.json();',
        '    });',
        '}',
        '',
        'function extractText(data) {',
        '    var reasoning = null, text = null;',
        '    // Responses API format',
        '    if (data.output) {',
        '        for (var i = 0; i < data.output.length; i++) {',
        '            var item = data.output[i];',
        '            if (item.type === "reasoning" && item.summary && item.summary.length > 0) {',
        '                reasoning = item.summary.map(function(s) { return s.text || s; }).join("\\n");',
        '            }',
        '            if (item.type === "message" && item.content) {',
        '                for (var j = 0; j < item.content.length; j++) {',
        '                    if (item.content[j].type === "output_text") { text = item.content[j].text; }',
        '                }',
        '            }',
        '        }',
        '    }',
        '    // Chat Completions format',
        '    if (!text && data.choices && data.choices[0]) {',
        '        var choice = data.choices[0];',
        '        text = choice.message ? choice.message.content : "";',
        '        if (choice.message && choice.message.reasoning_content) {',
        '            reasoning = choice.message.reasoning_content;',
        '        }',
        '    }',
        '    return { text: text || JSON.stringify(data, null, 2), reasoning: reasoning };',
        '}',
        '',
        '// ========== SEND / EDIT / REGENERATE ==========',
        '',
        'function buildUserContent(text, attachments) {',
        '    if (!attachments || attachments.length === 0) return text;',
        '    var parts = [];',
        '    var textParts = [text];',
        '    for (var i = 0; i < attachments.length; i++) {',
        '        if (attachments[i].type === "image") {',
        '            parts.push({ type: "input_image", image_url: attachments[i].data });',
        '        } else {',
        '            textParts.push("\\n--- " + attachments[i].name + " ---\\n" + attachments[i].data);',
        '        }',
        '    }',
        '    parts.unshift({ type: "input_text", text: textParts.join("\\n") });',
        '    return parts;',
        '}',
        '',
        'function sendMessage() {',
        '    if (isLoading) return;',
        '    var text = inputEl.value.trim();',
        '    if (!text && pendingAttachments.length === 0) return;',
        '    if (!text) text = "(adjunto)";',
        '    var preset = getPreset();',
        '    var key = getApiKey();',
        '    if (preset.provider !== "rag" && !key) { addMsg("error", "Abre la configuracion y pon tu API key."); return; }',
        '',
        '    var content = buildUserContent(text, pendingAttachments);',
        '    var displayAtts = pendingAttachments.slice();',
        '    clearAttachments();',
        '',
        '    addMsg("user", text, null, null, displayAtts);',
        '    conversationHistory.push({ role: "user", content: content });',
        '',
        '    inputEl.value = "";',
        '    inputEl.style.height = "auto";',
        '    doSend();',
        '}',
        '',
        'function doSend() {',
        '    isLoading = true;',
        '    sendBtn.disabled = true;',
        '    inputEl.disabled = true;',
        '    typingEl.classList.add("visible");',
        '    scrollToBottom();',
        '    var startTime = Date.now();',
        '    var modelName = getPreset().name;',
        '    callAPI(conversationHistory)',
        '        .then(function(data) {',
        '            var result = extractText(data);',
        '            var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);',
        '            var tokens = data.usage ? data.usage.total_tokens + " tok" : "";',
        '            // Include sources for RAG responses',
        '            var sourcesHtml = "";',
        '            if (data.sources && data.sources.length > 0) {',
        '                sourcesHtml = "\\n\\n---\\n**Fuentes consultadas:**\\n";',
        '                var seen = {};',
        '                for (var s = 0; s < data.sources.length; s++) {',
        '                    var src = data.sources[s];',
        '                    var key = src.law + "|" + src.section;',
        '                    if (!seen[key]) {',
        '                        seen[key] = true;',
        '                        sourcesHtml += "- " + src.law + " > " + src.section + "\\n";',
        '                    }',
        '                }',
        '            }',
        '            addMsg("assistant", result.text + sourcesHtml, result.reasoning, modelName + " \\u00b7 " + elapsed + "s " + tokens);',
        '            conversationHistory.push({ role: "assistant", content: result.text });',
        '            saveCurrentConversation();',
        '        })',
        '        .catch(function(err) { addMsg("error", err.message); })',
        '        .then(function() {',
        '            typingEl.classList.remove("visible");',
        '            isLoading = false;',
        '            sendBtn.disabled = false;',
        '            inputEl.disabled = false;',
        '            inputEl.focus();',
        '            scrollToBottom();',
        '        });',
        '}',
        '',
        'function regenerate() {',
        '    if (isLoading || conversationHistory.length < 2) return;',
        '    if (conversationHistory[conversationHistory.length - 1].role === "assistant") {',
        '        conversationHistory.pop();',
        '    }',
        '    var msgs = chatEl.querySelectorAll(".msg.assistant");',
        '    if (msgs.length > 0) { msgs[msgs.length - 1].remove(); }',
        '    doSend();',
        '}',
        '',
        'function editMsg(msgIdx) {',
        '    if (isLoading) return;',
        '    var msgDivs = chatEl.querySelectorAll(".msg");',
        '    var div = msgDivs[msgIdx];',
        '    if (!div) return;',
        '',
        '    var histIdx = -1;',
        '    var count = 0;',
        '    for (var i = 0; i < conversationHistory.length; i++) {',
        '        if (conversationHistory[i].role === "user" || conversationHistory[i].role === "assistant") {',
        '            if (count === msgIdx) { histIdx = i; break; }',
        '            count++;',
        '        }',
        '    }',
        '    if (histIdx < 0) return;',
        '',
        '    var origContent = conversationHistory[histIdx].content;',
        '    var origText = typeof origContent === "string" ? origContent : "";',
        '    if (Array.isArray(origContent)) {',
        '        for (var k = 0; k < origContent.length; k++) {',
        '            if (origContent[k].type === "input_text") { origText = origContent[k].text; break; }',
        '        }',
        '    }',
        '',
        '    div.innerHTML = "";',
        '    div.classList.add("editing");',
        '    var ta = document.createElement("textarea");',
        '    ta.className = "edit-textarea";',
        '    ta.value = origText;',
        '    div.appendChild(ta);',
        '',
        '    var btns = document.createElement("div");',
        '    btns.className = "edit-btns";',
        '    var saveB = document.createElement("button");',
        '    saveB.textContent = "Enviar";',
        '    saveB.className = "action-btn primary";',
        '    var cancelB = document.createElement("button");',
        '    cancelB.textContent = "Cancelar";',
        '    cancelB.className = "action-btn";',
        '    btns.appendChild(cancelB);',
        '    btns.appendChild(saveB);',
        '    div.appendChild(btns);',
        '',
        '    ta.focus();',
        '    ta.setSelectionRange(ta.value.length, ta.value.length);',
        '',
        '    cancelB.onclick = function() { rebuildChat(); };',
        '    saveB.onclick = function() {',
        '        var newText = ta.value.trim();',
        '        if (!newText) return;',
        '        conversationHistory = conversationHistory.slice(0, histIdx);',
        '        conversationHistory.push({ role: "user", content: newText });',
        '        rebuildChat();',
        '        doSend();',
        '    };',
        '    ta.addEventListener("keydown", function(e) {',
        '        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveB.click(); }',
        '        if (e.key === "Escape") { cancelB.click(); }',
        '    });',
        '}',
        '',
        'function rebuildChat() {',
        '    chatEl.innerHTML = "";',
        '    for (var i = 0; i < conversationHistory.length; i++) {',
        '        var h = conversationHistory[i];',
        '        if (h.role === "user") {',
        '            var txt = typeof h.content === "string" ? h.content : "";',
        '            if (Array.isArray(h.content)) {',
        '                for (var k = 0; k < h.content.length; k++) {',
        '                    if (h.content[k].type === "input_text") { txt = h.content[k].text; break; }',
        '                }',
        '            }',
        '            addMsg("user", txt);',
        '        } else if (h.role === "assistant") {',
        '            addMsg("assistant", h.content);',
        '        }',
        '    }',
        '}',
        '',
        '// ========== EXPORT ==========',
        '',
        'function exportChat() {',
        '    if (conversationHistory.length === 0) return;',
        '    var md = "# Conversacion\\n\\n";',
        '    for (var i = 0; i < conversationHistory.length; i++) {',
        '        var h = conversationHistory[i];',
        '        var txt = typeof h.content === "string" ? h.content : "";',
        '        if (Array.isArray(h.content)) {',
        '            for (var k = 0; k < h.content.length; k++) {',
        '                if (h.content[k].type === "input_text") { txt = h.content[k].text; break; }',
        '            }',
        '        }',
        '        if (h.role === "user") { md += "## Usuario\\n\\n" + txt + "\\n\\n"; }',
        '        else if (h.role === "assistant") { md += "## Asistente\\n\\n" + txt + "\\n\\n"; }',
        '    }',
        '    var blob = new Blob([md], { type: "text/markdown" });',
        '    var a = document.createElement("a");',
        '    a.href = URL.createObjectURL(blob);',
        '    a.download = "conversacion-" + new Date().toISOString().slice(0,10) + ".md";',
        '    a.click();',
        '}',
        '',
        '// ========== COPY CODE ==========',
        '',
        'function copyCode(btn) {',
        '    var pre = btn.parentElement;',
        '    var code = pre.querySelector("code");',
        '    navigator.clipboard.writeText(code ? code.textContent : pre.textContent).then(function() {',
        '        btn.textContent = "Copiado!";',
        '        btn.classList.add("copied");',
        '        setTimeout(function() { btn.textContent = "Copiar"; btn.classList.remove("copied"); }, 1500);',
        '    });',
        '}',
        '',
        '// ========== FORMAT ==========',
        '',
        'function formatContent(text) {',
        '    var html = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");',
        '    var bt = String.fromCharCode(96);',
        '    var codeBlockRe = new RegExp(bt+bt+bt+"(\\\\w*)\\\\n([\\\\s\\\\S]*?)"+bt+bt+bt, "g");',
        '    html = html.replace(codeBlockRe, function(_, lang, code) {',
        '        var label = lang ? \'<span class="code-lang">\' + lang + "</span>" : "";',
        '        return \'<pre class="code-block">\' + label + \'<button class="copy-btn" onclick="copyCode(this)">Copiar</button><code>\' + code.trim() + "</code></pre>";',
        '    });',
        '    var inlineRe = new RegExp(bt+"([^"+bt+"]+)"+bt, "g");',
        '    html = html.replace(inlineRe, "<code>$1</code>");',
        '    html = html.replace(/\\*\\*(.+?)\\*\\*/g, "<strong>$1</strong>");',
        '    return html;',
        '}',
        '',
        '// ========== ADD MESSAGE ==========',
        '',
        'function addMsg(role, text, reasoning, meta, attachments) {',
        '    var msgIdx = chatEl.querySelectorAll(".msg").length;',
        '    var div = document.createElement("div");',
        '    div.className = "msg " + role;',
        '',
        '    if (role === "user") {',
        '        var inner = \'<div class="msg-content">\';',
        '        if (attachments && attachments.length > 0) {',
        '            inner += \'<div class="msg-attachments">\';',
        '            for (var a = 0; a < attachments.length; a++) {',
        '                if (attachments[a].type === "image") {',
        '                    inner += \'<img class="msg-thumb" src="\' + attachments[a].data + \'" alt="">\';',
        '                } else {',
        '                    inner += \'<span class="msg-file">&#x1F4C4; \' + attachments[a].name + "</span>";',
        '                }',
        '            }',
        '            inner += "</div>";',
        '        }',
        '        inner += \'<span>\' + text.replace(/</g,"&lt;").replace(/>/g,"&gt;") + "</span></div>";',
        '        inner += \'<div class="msg-actions"><button onclick="editMsg(\' + msgIdx + \')" title="Editar">&#x270E;</button></div>\';',
        '        div.innerHTML = inner;',
        '    } else if (role === "assistant") {',
        '        var inner = "";',
        '        if (reasoning) {',
        '            var tid = "think-" + Date.now();',
        '            inner += \'<div class="thinking-toggle" onclick="document.getElementById(\\x27\' + tid + \'\\x27).classList.toggle(\\x27visible\\x27)">\\u25B6 Razonamiento</div>\';',
        '            inner += \'<div class="thinking-content" id="\' + tid + \'">\' + reasoning.replace(/</g,"&lt;") + "</div>";',
        '        }',
        '        inner += \'<div class="content">\' + formatContent(text) + "</div>";',
        '        if (meta) { inner += \'<div class="msg-meta">\' + meta + "</div>"; }',
        '        inner += \'<div class="msg-actions"><button onclick="regenerate()" title="Regenerar">&#x1F504;</button><button onclick="copyFullMsg(this)" title="Copiar todo">&#x1F4CB;</button></div>\';',
        '        div.innerHTML = inner;',
        '    } else {',
        '        div.textContent = text;',
        '    }',
        '    chatEl.appendChild(div);',
        '    scrollToBottom();',
        '}',
        '',
        'function copyFullMsg(btn) {',
        '    var contentDiv = btn.closest(".msg").querySelector(".content");',
        '    if (!contentDiv) return;',
        '    navigator.clipboard.writeText(contentDiv.textContent).then(function() {',
        '        btn.innerHTML = "&#x2705;";',
        '        setTimeout(function() { btn.innerHTML = "&#x1F4CB;"; }, 1500);',
        '    });',
        '}',
        '',
        'function scrollToBottom() { chatEl.scrollTop = chatEl.scrollHeight; }',
        'function setStatus(text, color) { statusEl.textContent = text; statusEl.style.color = color; }',
        '',
        '// --- Load config & init ---',
        'try {',
        '    var saved = localStorage.getItem("azure-chat-key");',
        '    if (saved) document.getElementById("api-key").value = saved;',
        '    var savedKimi = localStorage.getItem("azure-chat-key-kimi");',
        '    if (savedKimi) document.getElementById("api-key-kimi").value = savedKimi;',
        '    var savedModel = localStorage.getItem("azure-chat-model");',
        '    if (savedModel) {',
        '        var sel = document.getElementById("model-select");',
        '        for (var i = 0; i < sel.options.length; i++) {',
        '            if (sel.options[i].value === savedModel) { sel.selectedIndex = i; break; }',
        '        }',
        '    }',
        '    var savedSP = localStorage.getItem("azure-chat-systemprompt");',
        '    if (savedSP) { systemPrompt = savedSP; document.getElementById("system-prompt").value = savedSP; }',
        '    onModelChange();',
        '    if (getApiKey()) { inputEl.disabled = false; sendBtn.disabled = false; }',
        '    var lastId = localStorage.getItem("azure-chat-current");',
        '    if (lastId) loadConversation(lastId);',
        '    renderHistoryList();',
        '} catch(e) { console.error("Init error:", e); }',
        '',
        'document.getElementById("clear-history-btn").addEventListener("click", function() {',
        '    if (confirm("Eliminar TODAS las conversaciones guardadas?")) {',
        '        localStorage.removeItem("azure-chat-history");',
        '        localStorage.removeItem("azure-chat-current");',
        '        currentConvId = null;',
        '        conversationHistory = [];',
        '        chatEl.innerHTML = "";',
        '        renderHistoryList();',
        '    }',
        '});',
    ].join('\n');

    var CSS_CODE = `
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; background: #1e1e1e; color: #d4d4d4; height: 100vh; display: flex; flex-direction: row; overflow: hidden; }

        /* --- Sidebar --- */
        .sidebar { width: 260px; height: 100vh; background: #252526; border-right: 1px solid #333; display: flex; flex-direction: column; flex-shrink: 0; overflow: hidden; }
        .sidebar-header { padding: 14px 16px; border-bottom: 1px solid #333; display: flex; align-items: center; gap: 10px; }
        .sidebar-header .app-icon { font-size: 18px; }
        .sidebar-header h1 { font-size: 13px; font-weight: 600; color: #ccc; letter-spacing: 0.3px; flex: 1; }
        .sidebar-close { display: none; background: none; border: none; color: #888; font-size: 18px; cursor: pointer; padding: 2px 6px; border-radius: 4px; }
        .sidebar-close:hover { color: #e0e0e0; background: #3c3c3c; }

        /* Status bar */
        .status-bar { padding: 10px 16px; border-bottom: 1px solid #333; display: flex; align-items: center; gap: 8px; }
        .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #555; display: inline-block; flex-shrink: 0; }
        .status-dot.connected { background: #4ade80; }
        .status-dot.error { background: #f87171; }
        .status-dot.testing { background: #facc15; animation: pulse 0.8s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        #status { font-size: 11px; color: #888; flex: 1; }

        /* Sidebar actions */
        .sidebar-actions { padding: 10px 12px; display: flex; flex-wrap: wrap; gap: 6px; border-bottom: 1px solid #333; }
        .action-btn { background: #2d2d2d; color: #ccc; border: 1px solid #404040; padding: 6px 10px; border-radius: 6px; cursor: pointer; font-size: 11px; display: flex; align-items: center; gap: 4px; transition: all 0.12s; font-family: inherit; flex: 1; justify-content: center; min-width: 0; }
        .action-btn:hover { background: #3c3c3c; color: #e0e0e0; }
        .action-btn.primary { background: #0078d4; border-color: #0078d4; color: #fff; }
        .action-btn.primary:hover { background: #1a8ae8; }
        .action-btn.danger { color: #f87171; }
        .action-btn.danger:hover { background: #f8717115; }

        /* Config section */
        .config-header { padding: 10px 16px 6px; display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; }
        .config-header:hover { background: #2a2a2a; }
        .config-header span { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.8px; font-weight: 600; }
        .config-header .arrow { font-size: 10px; color: #888; }
        .config-section { display: none; flex-direction: column; gap: 8px; padding: 8px 16px 12px; border-bottom: 1px solid #333; }
        .cfg-group { display: flex; flex-direction: column; gap: 3px; }
        .cfg-group label { font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
        .cfg-group input, .cfg-group textarea, .cfg-group select { background: #1e1e1e; border: 1px solid #404040; color: #d4d4d4; padding: 7px 10px; border-radius: 4px; font-size: 12px; font-family: inherit; transition: border-color 0.12s; }
        .cfg-group input:focus, .cfg-group textarea:focus, .cfg-group select:focus { outline: none; border-color: #0078d4; }
        .cfg-group textarea { resize: vertical; min-height: 50px; }
        .cfg-group select { cursor: pointer; appearance: none; -webkit-appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 10px center; padding-right: 28px; }
        .cfg-group select option { background: #1e1e1e; color: #d4d4d4; }
        .provider-badge { font-size: 9px; color: #0078d4; background: #0078d415; padding: 2px 6px; border-radius: 3px; margin-top: 2px; display: inline-block; align-self: flex-start; }

        /* History section */
        .history-header { padding: 10px 16px 6px; display: flex; align-items: center; justify-content: space-between; }
        .history-header span { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.8px; font-weight: 600; }
        #history-list { flex: 1; overflow-y: auto; padding: 4px 8px; }
        #history-list::-webkit-scrollbar { width: 3px; }
        #history-list::-webkit-scrollbar-thumb { background: #404040; border-radius: 2px; }
        .history-item { padding: 8px 10px; border-radius: 6px; cursor: pointer; position: relative; transition: background 0.1s; margin-bottom: 1px; }
        .history-item:hover { background: #2d2d2d; }
        .history-item.active { background: #37373d; border-left: 2px solid #0078d4; }
        .hi-title { font-size: 12px; color: #ccc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 20px; }
        .hi-meta { font-size: 10px; color: #666; margin-top: 2px; }
        .hi-del { position: absolute; top: 8px; right: 6px; background: none; border: none; color: #666; cursor: pointer; font-size: 11px; padding: 2px 4px; border-radius: 3px; display: none; }
        .history-item:hover .hi-del { display: block; }
        .hi-del:hover { color: #f87171; background: #f8717118; }
        .history-empty { color: #666; font-size: 12px; text-align: center; padding: 24px 0; }
        .sidebar-footer { padding: 8px 12px; border-top: 1px solid #333; }
        .sidebar-footer button { width: 100%; justify-content: center; }

        /* Sidebar overlay (mobile) */
        .sidebar-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 90; }
        .sidebar-overlay.open { display: block; }

        /* --- Main area --- */
        .main { flex: 1; display: flex; flex-direction: column; min-width: 0; height: 100vh; }

        /* Mobile top bar */
        .mobile-bar { display: none; background: #252526; border-bottom: 1px solid #333; padding: 8px 12px; align-items: center; gap: 8px; flex-shrink: 0; }
        .mobile-bar button { background: none; border: none; color: #ccc; font-size: 20px; cursor: pointer; padding: 4px 8px; border-radius: 4px; }
        .mobile-bar button:hover { background: #3c3c3c; }
        .mobile-bar span { font-size: 13px; color: #888; }

        /* --- Chat area --- */
        #chat { flex: 1; overflow-y: auto; padding: 24px 0 12px; display: flex; flex-direction: column; gap: 4px; max-width: 800px; width: 100%; margin: 0 auto; }
        #chat::-webkit-scrollbar { width: 4px; }
        #chat::-webkit-scrollbar-track { background: transparent; }
        #chat::-webkit-scrollbar-thumb { background: #404040; border-radius: 2px; }
        #chat:empty::after { content: "Escribe un mensaje para empezar..."; color: #555; font-size: 15px; text-align: center; margin: auto; }
        #chat.drag-over { outline: 2px dashed #0078d4; outline-offset: -8px; background: #0078d408; }

        /* --- Messages --- */
        .msg { max-width: 100%; padding: 8px 20px; line-height: 1.7; font-size: 14.5px; word-wrap: break-word; position: relative; border-radius: 0; }
        .msg.user { align-self: flex-end; background: #2d2d2d; color: #e0e0e0; border-radius: 16px; padding: 10px 16px; max-width: 75%; margin: 8px 20px 4px 60px; }
        .msg.user .msg-content { white-space: pre-wrap; }
        .msg.assistant { align-self: stretch; background: transparent; border: none; padding: 12px 20px 8px; margin: 4px 0; }
        .msg.assistant .content { white-space: pre-wrap; color: #d4d4d4; }
        .msg.error { align-self: center; background: #f8717112; border: 1px solid #f8717130; color: #f87171; font-size: 13px; max-width: 80%; border-radius: 10px; padding: 10px 16px; margin: 8px 0; }

        /* Message actions */
        .msg-actions { display: flex; gap: 2px; margin-top: 8px; opacity: 0; transition: opacity 0.12s; }
        .msg.user .msg-actions { position: absolute; left: -30px; top: 8px; margin-top: 0; }
        .msg.assistant .msg-actions { opacity: 1; padding-top: 4px; border-top: 1px solid #333; margin-top: 12px; }
        .msg:hover .msg-actions { opacity: 1; }
        .msg-actions button { background: transparent; border: 1px solid transparent; color: #666; width: 28px; height: 28px; border-radius: 4px; cursor: pointer; font-size: 13px; display: flex; align-items: center; justify-content: center; padding: 0; transition: all 0.12s; }
        .msg-actions button:hover { background: #333; color: #e0e0e0; border-color: #444; }

        /* Edit mode */
        .msg.editing { background: #252526; border: 1px solid #0078d4; padding: 12px; max-width: 75%; border-radius: 12px; }
        .edit-textarea { width: 100%; min-height: 60px; background: #1e1e1e; border: 1px solid #404040; color: #d4d4d4; padding: 10px; border-radius: 4px; font-size: 14px; font-family: inherit; resize: vertical; }
        .edit-textarea:focus { outline: none; border-color: #0078d4; }
        .edit-btns { display: flex; gap: 6px; margin-top: 8px; justify-content: flex-end; }

        /* Attachments in messages */
        .msg-attachments { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
        .msg-thumb { max-width: 200px; max-height: 140px; border-radius: 8px; cursor: pointer; }
        .msg-thumb:hover { opacity: 0.9; }
        .msg-file { font-size: 12px; background: rgba(255,255,255,0.06); padding: 4px 10px; border-radius: 4px; }

        /* --- Code blocks --- */
        .code-block { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; margin: 10px 0; overflow: hidden; position: relative; }
        .code-block code { display: block; padding: 14px 16px; padding-top: 28px; overflow-x: auto; font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace; font-size: 13px; line-height: 1.5; color: #d4d4d4; background: none; }
        .code-lang { position: absolute; top: 6px; left: 12px; font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; }
        .copy-btn { position: absolute; top: 6px; right: 8px; background: #333; color: #888; border: 1px solid #444; padding: 3px 10px; border-radius: 4px; font-size: 11px; cursor: pointer; opacity: 0; transition: opacity 0.12s; }
        .code-block:hover .copy-btn { opacity: 1; }
        .copy-btn:hover { background: #444; color: #e0e0e0; }
        .copy-btn.copied { background: #0078d4; color: #fff; border-color: #0078d4; opacity: 1; }
        .msg code { font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace; background: #2d2d2d; padding: 2px 6px; border-radius: 3px; font-size: 13px; color: #9cdcfe; }

        /* Thinking */
        .thinking-toggle { font-size: 12px; color: #666; cursor: pointer; margin-bottom: 6px; user-select: none; }
        .thinking-toggle:hover { color: #888; }
        .thinking-content { display: none; background: #1a1a1a; border-left: 2px solid #444; padding: 10px 14px; margin-bottom: 10px; font-size: 12px; color: #888; white-space: pre-wrap; border-radius: 0 4px 4px 0; }
        .thinking-content.visible { display: block; }
        .msg-meta { font-size: 11px; color: #555; margin-top: 4px; }

        /* Typing */
        .typing { display: none; padding: 16px 20px; gap: 6px; align-items: center; max-width: 800px; width: 100%; margin: 0 auto; }
        .typing.visible { display: flex; }
        .typing span { width: 7px; height: 7px; background: #0078d4; border-radius: 50%; animation: bounce 1.4s infinite ease-in-out; }
        .typing span:nth-child(2) { animation-delay: 0.16s; }
        .typing span:nth-child(3) { animation-delay: 0.32s; }
        @keyframes bounce { 0%, 80%, 100% { transform: scale(0); opacity: 0.3; } 40% { transform: scale(1); opacity: 1; } }

        /* --- Input area --- */
        #input-area { padding: 12px 16px 20px; background: #1e1e1e; display: flex; flex-direction: column; gap: 6px; max-width: 800px; width: 100%; margin: 0 auto; }
        #preview-area { display: none; flex-wrap: wrap; gap: 6px; padding: 4px 0; }
        .preview-item { display: flex; align-items: center; gap: 6px; background: #252526; border: 1px solid #333; padding: 5px 10px; border-radius: 6px; font-size: 12px; color: #888; }
        .preview-item img { width: 40px; height: 40px; object-fit: cover; border-radius: 4px; }
        .preview-item .file-icon { font-size: 18px; }
        .preview-item button { background: none; border: none; color: #f87171; cursor: pointer; font-size: 14px; padding: 0 2px; }
        .preview-item button:hover { color: #fca5a5; }
        .input-row { display: flex; gap: 8px; align-items: flex-end; }
        #user-input { flex: 1; background: #2d2d2d; border: 1px solid #404040; color: #d4d4d4; padding: 12px 16px; border-radius: 20px; font-size: 14px; resize: none; font-family: inherit; min-height: 48px; max-height: 180px; line-height: 1.4; transition: border-color 0.12s, box-shadow 0.12s; }
        #user-input:focus { outline: none; border-color: #0078d4; box-shadow: 0 0 0 1px #0078d420; }
        #user-input:disabled { opacity: 0.3; }
        .attach-btn { background: #2d2d2d; color: #888; border: 1px solid #404040; width: 44px; height: 44px; border-radius: 50%; cursor: pointer; font-size: 18px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: all 0.12s; }
        .attach-btn:hover { background: #3c3c3c; color: #e0e0e0; }
        #btn-send { background: #0078d4; color: white; border: none; width: 44px; height: 44px; border-radius: 50%; cursor: pointer; font-size: 16px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: background 0.12s; }
        #btn-send:hover { background: #1a8ae8; }
        #btn-send:disabled { opacity: 0.2; cursor: not-allowed; }
        #btn-send svg { width: 18px; height: 18px; fill: currentColor; }

        /* --- Responsive --- */
        @media (max-width: 768px) {
            .sidebar { position: fixed; left: -280px; z-index: 100; width: 270px; transition: left 0.25s ease; }
            .sidebar.open { left: 0; }
            .sidebar-close { display: block; }
            .mobile-bar { display: flex; }
        }
    `;

    const HTML = `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Consultas internas</title>
    <style>${CSS_CODE}</style>
</head>
<body>

<!-- Sidebar overlay (mobile) -->
<div class="sidebar-overlay" id="sidebar-overlay"></div>

<!-- LEFT SIDEBAR -->
<aside class="sidebar" id="sidebar">
    <div class="sidebar-header">
        <span class="app-icon">&#x1F916;</span>
        <h1>Consultas internas</h1>
        <button class="sidebar-close" onclick="closeSidebar()">&#x2715;</button>
    </div>

    <!-- Status -->
    <div class="status-bar">
        <span id="status-dot" class="status-dot"></span>
        <span id="status">Sin API key</span>
    </div>

    <!-- Action buttons -->
    <div class="sidebar-actions">
        <button class="action-btn primary" onclick="newChat()">&#x2795; Nueva</button>
        <button class="action-btn" onclick="testConnection()">&#x26A1; Test</button>
        <button class="action-btn" onclick="exportChat()">&#x1F4BE;</button>
    </div>

    <!-- Config (collapsible, COLLAPSED by default) -->
    <div class="config-header" onclick="toggleConfigSection()">
        <span id="config-arrow" class="arrow">&#x25B6;</span>
        <span>Configuraci&oacute;n</span>
    </div>
    <div class="config-section" id="config-section" style="display:none">
        <div class="cfg-group">
            <label>Modelo</label>
            <select id="model-select">
                <option value="gpt-5.2-codex">GPT-5.2 Codex</option>
                <option value="gpt-5.2">GPT-5.2</option>
                <option value="Kimi-K2.5">Kimi K2.5</option>
                <option value="ss-expert">SS Expert (RAG)</option>
            </select>
        </div>
        <div class="cfg-group" id="key-group-openai">
            <label>API Key (Azure OpenAI)</label>
            <input type="password" id="api-key" placeholder="Key para GPT-5.2, GPT-4.1...">
        </div>
        <div class="cfg-group" id="key-group-kimi" style="display:none">
            <label>API Key (Kimi)</label>
            <input type="password" id="api-key-kimi" placeholder="Key para Kimi K2.5">
        </div>
        <div class="cfg-group">
            <label>System prompt</label>
            <textarea id="system-prompt" rows="2" placeholder="Ej: Eres un asistente experto..."></textarea>
        </div>
        <button class="action-btn primary" id="btn-save-config" onclick="saveConfig()" style="align-self:flex-start">Guardar</button>
    </div>

    <!-- History -->
    <div class="history-header">
        <span>Historial</span>
    </div>
    <div id="history-list"></div>

    <!-- Footer -->
    <div class="sidebar-footer">
        <button class="action-btn danger" id="clear-history-btn">&#x1F5D1; Borrar todo</button>
    </div>
</aside>

<!-- MAIN CHAT AREA -->
<div class="main">
    <!-- Mobile top bar -->
    <div class="mobile-bar">
        <button onclick="toggleSidebar()">&#x2630;</button>
        <span>Consultas internas</span>
    </div>

    <div id="chat"></div>
    <div class="typing" id="typing"><span></span><span></span><span></span></div>

    <div id="input-area">
        <div id="preview-area"></div>
        <div class="input-row">
            <button class="attach-btn" onclick="triggerFileInput()" title="Adjuntar archivo o imagen">&#x1F4CE;</button>
            <input type="file" id="file-input" multiple accept="image/*,.txt,.js,.py,.ts,.json,.csv,.xml,.html,.css,.md,.log,.sql,.yaml,.yml,.sh,.bat,.ps1,.jsx,.tsx,.c,.cpp,.h,.java,.cs,.go,.rs,.rb,.php,.swift,.kt" style="display:none">
            <textarea id="user-input" rows="1" placeholder="Escribe un mensaje... (Ctrl+V para pegar imagen)" disabled></textarea>
            <button id="btn-send" disabled onclick="sendMessage()"><svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></button>
        </div>
    </div>
</div>

<script>
` + JS_CODE + `
</script>
</body>
</html>`;

    context.res = {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: HTML,
        isRaw: true
    };
};
