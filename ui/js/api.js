/**
 * API communication layer
 */
const API = {
    /**
     * Call the chat API
     * @param {Array} messages - Conversation messages
     * @param {Object} preset - Model preset from Config
     * @param {string} apiKey - API key for the provider
     * @param {string} systemPrompt - System prompt (optional)
     * @returns {Promise<Object>} - API response
     */
    async call(messages, preset, apiKey, systemPrompt = '') {
        // RAG mode - uses server-side keys
        if (preset.format === 'rag') {
            return this._callRAG(messages);
        }
        
        if (!apiKey) {
            throw new Error('API key vacía');
        }
        
        const body = {
            _apikey: apiKey,
            _host: preset.host,
            _path: preset.path,
            model: preset.id
        };
        
        if (preset.format === 'chat-completions') {
            body.messages = this._formatChatCompletions(messages, systemPrompt);
        } else {
            body.input = this._formatResponses(messages, systemPrompt);
        }
        
        const response = await fetch(Config.CHAT_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`HTTP ${response.status}: ${text.substring(0, 200)}`);
        }
        
        return response.json();
    },
    
    /**
     * Call RAG endpoint
     */
    async _callRAG(messages) {
        // Extract plain text from messages
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
        
        const response = await fetch(Config.RAG_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: ragMsgs })
        });
        
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`HTTP ${response.status}: ${text.substring(0, 200)}`);
        }
        
        return response.json();
    },
    
    /**
     * Format messages for Chat Completions API (Kimi, etc.)
     */
    _formatChatCompletions(messages, systemPrompt) {
        const chatMsgs = [];
        
        if (systemPrompt) {
            chatMsgs.push({ role: 'system', content: systemPrompt });
        }
        
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
    
    /**
     * Format messages for Responses API (Azure OpenAI GPT)
     */
    _formatResponses(messages, systemPrompt) {
        const input = [];
        
        if (systemPrompt) {
            input.push({ role: 'developer', content: systemPrompt });
        }
        
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
    
    /**
     * Extract text and reasoning from API response
     */
    extractResponse(data) {
        let reasoning = null;
        let text = null;
        
        // Responses API format
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
        
        // Chat Completions format
        if (!text && data.choices?.[0]) {
            const choice = data.choices[0];
            text = choice.message?.content || '';
            if (choice.message?.reasoning_content) {
                reasoning = choice.message.reasoning_content;
            }
        }
        
        // Format sources for RAG responses
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
            usage: data.usage
        };
    }
};

window.API = API;
