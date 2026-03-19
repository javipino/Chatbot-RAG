// ── Admin Panel JS ──
// Communicates with /api/admin/* endpoints via fetch + SSE streaming for pipeline operations.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ── API Key ──
const apiKeyInput = $('#apiKeyInput');
apiKeyInput.value = sessionStorage.getItem('admin_api_key') || '';
apiKeyInput.addEventListener('change', () => {
    sessionStorage.setItem('admin_api_key', apiKeyInput.value);
});

function getHeaders() {
    const key = apiKeyInput.value.trim();
    const h = {};
    if (key) h['x-api-key'] = key;
    return h;
}

// ── Tabs ──
$$('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        $$('.tab').forEach(t => t.classList.remove('active'));
        $$('.panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        $(`#panel-${tab.dataset.tab}`).classList.add('active');
    });
});

// ── Progress log helpers ──
function logStep(container, msg, type = 'step') {
    container.classList.add('visible');
    const div = document.createElement('div');
    div.className = type;
    div.textContent = msg;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function clearLog(container) {
    container.innerHTML = '';
    container.classList.remove('visible');
}

// ── SSE stream reader (reused for pipeline endpoints) ──
async function streamRequest(url, options, progressEl, onDone) {
    clearLog(progressEl);
    logStep(progressEl, 'Iniciando...');

    try {
        const response = await fetch(url, options);
        if (!response.ok && response.headers.get('content-type')?.includes('json')) {
            const err = await response.json();
            logStep(progressEl, `Error: ${err.error || err.message || response.statusText}`, 'error');
            return;
        }
        if (!response.ok) {
            logStep(progressEl, `Error HTTP ${response.status}`, 'error');
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const parts = buffer.split('\n\n');
            buffer = parts.pop() || '';

            for (const part of parts) {
                let eventType = 'message', data = '';
                for (const line of part.split('\n')) {
                    if (line.startsWith('event: ')) eventType = line.slice(7).trim();
                    else if (line.startsWith('data: ')) data = line.slice(6);
                }
                if (!data) continue;

                try {
                    const parsed = JSON.parse(data);
                    if (eventType === 'tool_status') {
                        logStep(progressEl, parsed.args || parsed.message || JSON.stringify(parsed));
                    } else if (eventType === 'done') {
                        logStep(progressEl, parsed.message || 'Completado.', 'done');
                        if (onDone) onDone(parsed);
                    } else if (eventType === 'error') {
                        logStep(progressEl, `Error: ${parsed.message}`, 'error');
                    }
                } catch { /* skip unparseable */ }
            }
        }
    } catch (err) {
        logStep(progressEl, `Error de red: ${err.message}`, 'error');
    }
}

// ── Table rendering ──
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(str, max = 120) {
    if (!str) return '';
    return str.length > max ? str.slice(0, max) + '…' : str;
}

// ══════════════════════════════════════
// ══ CRITERIOS TAB
// ══════════════════════════════════════

$('#btnUploadCriterio').addEventListener('click', async () => {
    const pdf = $('#criterioPdf').files[0];
    const titulo = $('#criterioTitulo').value.trim();
    if (!pdf) return alert('Selecciona un archivo PDF.');
    if (!titulo) return alert('El título es obligatorio.');

    const form = new FormData();
    form.append('pdf', pdf);
    form.append('titulo', titulo);
    form.append('descripcion', $('#criterioDescripcion').value.trim());
    form.append('fecha', $('#criterioFecha').value.trim());
    form.append('emisor', $('#criterioEmisor').value.trim());
    form.append('criterio_num', $('#criterioNum').value.trim());
    form.append('estado', $('#criterioEstado').value);

    const btn = $('#btnUploadCriterio');
    btn.disabled = true;

    await streamRequest('/api/admin/criterios', {
        method: 'POST',
        headers: getHeaders(),
        body: form,
    }, $('#criterioProgress'), () => {
        // Clear form on success
        $('#criterioPdf').value = '';
        $('#criterioTitulo').value = '';
        $('#criterioDescripcion').value = '';
        $('#criterioFecha').value = '';
        $('#criterioEmisor').value = '';
        $('#criterioNum').value = '';
        $('#criterioEstado').value = 'Vigente';
        searchCriterios(); // refresh list
    });

    btn.disabled = false;
});

async function searchCriterios() {
    const q = $('#criterioSearch').value.trim();
    const params = q ? `?q=${encodeURIComponent(q)}` : '';
    try {
        const res = await fetch(`/api/admin/criterios${params}`, { headers: getHeaders() });
        if (!res.ok) { $('#criteriosTable').innerHTML = '<div class="empty-msg">Error al buscar.</div>'; return; }
        const items = await res.json();
        renderCriteriosTable(items);
    } catch (err) {
        $('#criteriosTable').innerHTML = `<div class="empty-msg">Error: ${escapeHtml(err.message)}</div>`;
    }
}

function renderCriteriosTable(items) {
    if (!items.length) {
        $('#criteriosTable').innerHTML = '<div class="empty-msg">No se encontraron criterios.</div>';
        return;
    }
    let html = `<table><thead><tr>
        <th>ID</th><th>Título</th><th>Fecha</th><th>Texto</th><th></th>
    </tr></thead><tbody>`;
    for (const item of items) {
        html += `<tr>
            <td>${escapeHtml(String(item.id ?? ''))}</td>
            <td>${escapeHtml(truncate(item.titulo, 60))}</td>
            <td>${escapeHtml(item.fecha || '')}</td>
            <td class="text-preview">${escapeHtml(truncate(item.text, 100))}</td>
            <td class="actions">
                <button class="btn-sm danger" onclick="deleteCriterio(${item.id})">Eliminar</button>
            </td>
        </tr>`;
    }
    html += '</tbody></table>';
    $('#criteriosTable').innerHTML = html;
}

$('#btnSearchCriterios').addEventListener('click', searchCriterios);
$('#criterioSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchCriterios(); });

window.deleteCriterio = async function(id) {
    if (!confirm(`¿Eliminar criterio ${id}?`)) return;
    try {
        const res = await fetch(`/api/admin/criterios/${id}`, {
            method: 'DELETE', headers: getHeaders(),
        });
        if (res.ok) searchCriterios();
        else alert('Error al eliminar.');
    } catch (err) { alert(`Error: ${err.message}`); }
};

// ══════════════════════════════════════
// ══ NORMATIVA TAB
// ══════════════════════════════════════

// State for parsed chunks
let parsedChunks = [];

// ── Auto-parse text ──
$('#btnParseNormativa').addEventListener('click', async () => {
    const rawText = $('#normRawText').value.trim();
    if (!rawText) return alert('Pega el texto de los artículos a procesar.');

    const btn = $('#btnParseNormativa');
    btn.disabled = true;
    btn.textContent = 'Analizando...';

    try {
        const res = await fetch('/api/admin/normativa/parse', {
            method: 'POST',
            headers: { ...getHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: rawText,
                law: $('#normLaw').value.trim() || null,
            }),
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            alert(`Error: ${err.error || res.statusText}`);
            return;
        }

        const data = await res.json();
        parsedChunks = data.chunks || [];

        // Auto-fill law if detected
        if (data.detectedLaw && !$('#normLaw').value.trim()) {
            $('#normLaw').value = data.detectedLaw;
        }

        renderParsedChunks();
    } catch (err) {
        alert(`Error de red: ${err.message}`);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Analizar texto';
    }
});

function renderParsedChunks() {
    const container = $('#parseResults');
    if (parsedChunks.length === 0) {
        container.style.display = 'none';
        return;
    }
    container.style.display = 'block';

    const replaceCount = parsedChunks.filter(c => c.action === 'replace').length;
    const addCount = parsedChunks.filter(c => c.action === 'add').length;
    $('#parseStats').textContent = `${parsedChunks.length} artículos · ${replaceCount} reemplazar · ${addCount} nuevos`;

    let html = '';
    for (let i = 0; i < parsedChunks.length; i++) {
        const c = parsedChunks[i];
        const isReplace = c.action === 'replace';
        const badgeClass = isReplace ? 'badge-replace' : 'badge-add';
        const badgeText = isReplace ? `Reemplazar ID ${c.existingId}` : 'Nuevo';
        const existingInfo = isReplace && c.existingSection
            ? `<span style="color:#888;font-size:0.72rem"> — existente: "${escapeHtml(truncate(c.existingSection, 50))}"</span>` : '';

        html += `<div class="chunk-row">
            <div class="chunk-info">
                <div class="chunk-section">
                    <span class="badge ${badgeClass}">${badgeText}</span>
                    ${escapeHtml(truncate(c.section, 80))}${existingInfo}
                </div>
                <div class="chunk-meta">
                    ${escapeHtml(c.law || '')}${c.chapter ? ' > ' + escapeHtml(c.chapter) : ''}
                    · ${c.text.length.toLocaleString()} chars
                </div>
                <div class="chunk-preview">${escapeHtml(truncate(c.text, 150))}</div>
            </div>
            <div class="chunk-actions">
                <select data-idx="${i}" class="action-select" style="background:#1a1a2e;border:1px solid #0f3460;color:#e0e0e0;padding:3px 6px;border-radius:3px;font-size:0.78rem">
                    <option value="replace" ${isReplace ? 'selected' : ''} ${!c.existingId ? 'disabled' : ''}>Reemplazar</option>
                    <option value="add" ${!isReplace ? 'selected' : ''}>Añadir nuevo</option>
                    <option value="skip">Omitir</option>
                </select>
            </div>
        </div>`;
    }
    $('#parsedChunksTable').innerHTML = html;
    clearLog($('#bulkProgress'));

    // Bind action select changes
    $$('.action-select').forEach(sel => {
        sel.addEventListener('change', (e) => {
            const idx = parseInt(e.target.dataset.idx);
            parsedChunks[idx].action = e.target.value;
            renderParsedChunks(); // re-render badges
        });
    });
}

// ── Bulk process ──
$('#btnProcessAll').addEventListener('click', async () => {
    const toProcess = parsedChunks.filter(c => c.action !== 'skip');
    if (toProcess.length === 0) return alert('No hay artículos seleccionados para procesar.');
    if (!confirm(`¿Procesar ${toProcess.length} artículos? Esto enriquecerá, generará embeddings y subirá cada uno a Qdrant.`)) return;

    const btn = $('#btnProcessAll');
    btn.disabled = true;

    await streamRequest('/api/admin/normativa/bulk', {
        method: 'POST',
        headers: { ...getHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ chunks: toProcess }),
    }, $('#bulkProgress'), () => {
        // Clear raw text on success
        $('#normRawText').value = '';
        parsedChunks = [];
        $('#parseResults').style.display = 'none';
    });

    btn.disabled = false;
});

// ── Search existing chunks ──
async function searchNormativa() {
    const q = $('#normativaSearch').value.trim();
    const law = $('#normativaLaw').value.trim();
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (law) params.set('law', law);
    const qs = params.toString() ? `?${params}` : '';
    try {
        const res = await fetch(`/api/admin/normativa${qs}`, { headers: getHeaders() });
        if (!res.ok) { $('#normativaTable').innerHTML = '<div class="empty-msg">Error al buscar.</div>'; return; }
        const items = await res.json();
        renderNormativaTable(items);
    } catch (err) {
        $('#normativaTable').innerHTML = `<div class="empty-msg">Error: ${escapeHtml(err.message)}</div>`;
    }
}

function renderNormativaTable(items) {
    if (!items.length) {
        $('#normativaTable').innerHTML = '<div class="empty-msg">No se encontraron chunks.</div>';
        return;
    }
    let html = `<table><thead><tr>
        <th>ID</th><th>Ley</th><th>Sección</th><th>Texto</th><th></th>
    </tr></thead><tbody>`;
    for (const item of items) {
        html += `<tr>
            <td>${escapeHtml(String(item.id ?? ''))}</td>
            <td>${escapeHtml(truncate(item.law, 40))}</td>
            <td>${escapeHtml(truncate(item.section, 40))}</td>
            <td class="text-preview">${escapeHtml(truncate(item.text, 100))}</td>
            <td class="actions">
                <button class="btn-sm secondary" onclick="editNormativa(${item.id})">Editar</button>
                <button class="btn-sm danger" onclick="deleteNormativa(${item.id})">Eliminar</button>
            </td>
        </tr>`;
    }
    html += '</tbody></table>';
    $('#normativaTable').innerHTML = html;
}

$('#btnSearchNormativa').addEventListener('click', searchNormativa);
$('#normativaSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchNormativa(); });
$('#normativaLaw').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchNormativa(); });

// ── Edit normativa chunk ──
window.editNormativa = async function(id) {
    try {
        const res = await fetch(`/api/admin/normativa/${id}`, { headers: getHeaders() });
        if (!res.ok) { alert('Error al cargar chunk.'); return; }
        const item = await res.json();

        $('#editId').value = id;
        $('#editLaw').value = item.law || '';
        $('#editChapter').value = item.chapter || '';
        $('#editSection').value = item.section || '';
        $('#editText').value = item.text || '';
        clearLog($('#editProgress'));
        $('#editOverlay').classList.add('visible');
    } catch (err) { alert(`Error: ${err.message}`); }
};

$('#btnCancelEdit').addEventListener('click', () => {
    $('#editOverlay').classList.remove('visible');
});

$('#editOverlay').addEventListener('click', (e) => {
    if (e.target === $('#editOverlay')) $('#editOverlay').classList.remove('visible');
});

$('#btnSaveEdit').addEventListener('click', async () => {
    const id = $('#editId').value;
    const text = $('#editText').value.trim();
    if (!text) return alert('El texto es obligatorio.');

    const btn = $('#btnSaveEdit');
    btn.disabled = true;

    await streamRequest(`/api/admin/normativa/${id}`, {
        method: 'PUT',
        headers: { ...getHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
            law: $('#editLaw').value.trim(),
            chapter: $('#editChapter').value.trim(),
            section: $('#editSection').value.trim(),
            text,
        }),
    }, $('#editProgress'), () => {
        setTimeout(() => {
            $('#editOverlay').classList.remove('visible');
            searchNormativa();
        }, 1000);
    });

    btn.disabled = false;
});

// ── Delete normativa chunk ──
window.deleteNormativa = async function(id) {
    if (!confirm(`¿Eliminar chunk ${id}?`)) return;
    try {
        const res = await fetch(`/api/admin/normativa/${id}`, {
            method: 'DELETE', headers: getHeaders(),
        });
        if (res.ok) searchNormativa();
        else alert('Error al eliminar.');
    } catch (err) { alert(`Error: ${err.message}`); }
};
