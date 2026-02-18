/**
 * API communication layer
 */
import { Config } from './config.js';

export const API = {
    _parseErrorText(text) {
        try {
            const json = JSON.parse(text);
            return json.error || json.message || text;
        } catch { return text.substring(0, 500); }
    },

    async call(messages, preset, apiKey, systemPrompt = '', ragChunkIds = [], threadId = null) {
        if (preset.format === 'rag') return this._callRAG(messages, apiKey, ragChunkIds);
        if (preset.format === 'rag-pipeline' || preset.format === 'rag-agent') {
            // Streaming — caller must use callStreaming() directly
            throw new Error('Use API.callStreaming() for rag-pipeline/rag-agent presets');
        }

        if (!apiKey) throw new Error('API key vacía');

        const body = {
            _apikey: apiKey,
            _host: preset.host,
            _path: preset.path,
            model: preset.id,
        };

        if (preset.format === 'chat-completions') {
            body.messages = this._formatChatCompletions(messages, systemPrompt);
        } else {
            body.input = this._formatResponses(messages, systemPrompt);
        }

        const response = await fetch(Config.CHAT_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Error ${response.status}: ${this._parseErrorText(text)}`);
        }
        return response.json();
    },

    /**
     * Streaming call for .NET rag-pipeline and rag-agent endpoints.
     * Parses SSE events and calls callbacks:
     *   onToken(text)          — partial answer token
     *   onToolStatus(name, args) — agent tool call started
     *   onDone(data)           — final event with contextChunkIds / threadId / sources
     *   onError(msg)           — error event
     */
    async callStreaming(preset, apiKey, messages, { ragChunkIds = [], threadId = null, onToken, onToolStatus, onDone, onError } = {}) {
        const endpoint = preset.endpoint;
        let body;

        if (preset.format === 'rag-pipeline') {
            const ragMsgs = messages
                .filter(m => m.role === 'user' || m.role === 'assistant')
                .map(m => {
                    let text = typeof m.content === 'string' ? m.content : '';
                    if (Array.isArray(m.content)) {
                        const textPart = m.content.find(p => p.type === 'input_text');
                        if (textPart) text = textPart.text;
                    }
                    return { role: m.role, content: text };
                });
            body = { messages: ragMsgs };
            if (ragChunkIds.length > 0) body.previousChunkIds = ragChunkIds;
        } else {
            // rag-agent: only send the last user message + threadId for continuity
            const lastUser = [...messages].reverse().find(m => m.role === 'user');
            let text = lastUser ? (typeof lastUser.content === 'string' ? lastUser.content : '') : '';
            if (lastUser && Array.isArray(lastUser.content)) {
                const tp = lastUser.content.find(p => p.type === 'input_text');
                if (tp) text = tp.text;
            }
            body = { message: text };
            if (threadId) body.threadId = threadId;
        }

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const text = await response.text();
            if (onError) onError(`Error ${response.status}: ${this._parseErrorText(text)}`);
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            // Process complete SSE events (separated by double newline)
            let boundary;
            while ((boundary = buffer.indexOf('\n\n')) !== -1) {
                const raw = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);

                let eventType = 'message';
                let dataStr = '';
                for (const line of raw.split('\n')) {
                    if (line.startsWith('event: ')) eventType = line.slice(7).trim();
                    else if (line.startsWith('data: ')) dataStr = line.slice(6).trim();
                }
                if (!dataStr) continue;

                try {
                    const parsed = JSON.parse(dataStr);
                    if (eventType === 'token' && onToken) {
                        // Strip any leaked META section (safety net for partial delimiters)
                        let text = parsed.text ?? parsed;
                        const metaIdx = typeof text === 'string' ? text.indexOf('===META') : -1;
                        if (metaIdx >= 0) text = text.slice(0, metaIdx).trimEnd();
                        if (text) onToken(text);
                    }
                    else if (eventType === 'tool_status' && onToolStatus) onToolStatus(parsed.tool, parsed.args);
                    else if (eventType === 'done' && onDone) onDone(parsed);
                    else if (eventType === 'error' && onError) onError(parsed.error ?? parsed);
                } catch {
                    // non-JSON data line (heartbeat etc) — ignore
                }
            }
        }
    },

    async _callRAG(messages, apiKey, previousChunkIds = []) {
        if (!apiKey) throw new Error('Function Key (RAG) vacía. Ponla en la configuración.');

        const ragMsgs = messages
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .map(m => {
                let text = typeof m.content === 'string' ? m.content : '';
                if (Array.isArray(m.content)) {
                    const textPart = m.content.find(p => p.type === 'input_text');
                    if (textPart) text = textPart.text;
                }
                return { role: m.role, content: text };
            });

        const body = { messages: ragMsgs };
        if (previousChunkIds.length > 0) body.previousChunkIds = previousChunkIds;

        const response = await fetch(Config.RAG_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Error ${response.status}: ${this._parseErrorText(text)}`);
        }
        return response.json();
    },

    _formatChatCompletions(messages, systemPrompt) {
        const chatMsgs = [];
        if (systemPrompt) chatMsgs.push({ role: 'system', content: systemPrompt });

        for (const m of messages) {
            if (m.role === 'user') {
                if (Array.isArray(m.content)) {
                    const parts = m.content
                        .filter(p => p.type === 'input_text' || (p.type === 'input_image' && p.image_url !== '(imagen)'))
                        .map(p => {
                            if (p.type === 'input_text') return { type: 'text', text: p.text };
                            return { type: 'image_url', image_url: { url: p.image_url } };
                        });
                    chatMsgs.push({ role: 'user', content: parts });
                } else {
                    chatMsgs.push({ role: 'user', content: m.content });
                }
            } else if (m.role === 'assistant') {
                chatMsgs.push({ role: 'assistant', content: m.content });
            }
        }
        return chatMsgs;
    },

    _formatResponses(messages, systemPrompt) {
        const input = [];
        if (systemPrompt) input.push({ role: 'developer', content: systemPrompt });

        for (const m of messages) {
            if (m.role === 'user' && Array.isArray(m.content)) {
                const cleaned = m.content.filter(p =>
                    !(p.type === 'input_image' && p.image_url === '(imagen)')
                );
                if (cleaned.length === 1 && cleaned[0].type === 'input_text') {
                    input.push({ role: 'user', content: cleaned[0].text });
                } else {
                    input.push({ role: 'user', content: cleaned });
                }
            } else {
                input.push(m);
            }
        }
        return input;
    },

    extractResponse(data) {
        let reasoning = null;
        let text = null;

        if (data.output) {
            for (const item of data.output) {
                if (item.type === 'reasoning' && item.summary?.length > 0) {
                    reasoning = item.summary.map(s => s.text || s).join('\n');
                }
                if (item.type === 'message' && item.content) {
                    const outputText = item.content.find(c => c.type === 'output_text');
                    if (outputText) text = outputText.text;
                }
            }
        }

        if (!text && data.choices?.[0]) {
            const choice = data.choices[0];
            text = choice.message?.content || '';
            if (choice.message?.reasoning_content) reasoning = choice.message.reasoning_content;
        }

        let sourcesText = '';
        if (data.sources?.length > 0) {
            const seen = new Set();
            const sourceLines = data.sources
                .filter(s => {
                    const key = `${s.law}|${s.section}`;
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                })
                .map(s => `- ${s.law} > ${s.section}`);
            if (sourceLines.length > 0) {
                sourcesText = '\n\n---\n**Fuentes consultadas:**\n' + sourceLines.join('\n');
            }
        }

        return {
            text: (text || JSON.stringify(data, null, 2)) + sourcesText,
            reasoning,
            usage: data.usage,
        };
    },
};
