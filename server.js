// Express server for Azure App Service deployment
// Serves static frontend (ui/) and API endpoints (/api/chat, /api/rag)
// Replaces SWA managed functions to avoid 45s proxy timeout

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

// Parse JSON bodies (100KB limit for safety)
app.use(express.json({ limit: '100kb' }));

// ── API Routes (before static, so /api/* is not caught by static middleware) ──

// Adapter: wraps Azure Functions handler (context, req) → Express (req, res)
function wrapAzureFunction(handler) {
    return async (req, res) => {
        const context = {
            log: (...args) => console.log('[API]', ...args),
            res: null
        };
        context.log.error = (...args) => console.error('[API]', ...args);
        context.log.warn = (...args) => console.warn('[API]', ...args);

        const azureReq = {
            body: req.body,
            headers: req.headers,
            method: req.method,
            query: req.query
        };

        try {
            await handler(context, azureReq);

            if (context.res) {
                const status = context.res.status || 200;
                const headers = context.res.headers || {};
                const body = context.res.body;

                for (const [k, v] of Object.entries(headers)) {
                    res.set(k, v);
                }
                res.status(status).json(body);
            } else {
                res.status(204).end();
            }
        } catch (err) {
            console.error('[API] Unhandled error:', err);
            res.status(500).json({ error: err.message });
        }
    };
}

const chatHandler = require('./api/chat/index');
const ragHandler = require('./api/rag/index');

app.post('/api/chat', wrapAzureFunction(chatHandler));
app.post('/api/rag', wrapAzureFunction(ragHandler));

// ── Static files (frontend) ──
app.use(express.static(path.join(__dirname, 'ui')));

// SPA fallback — serve index.html for any non-API, non-file route
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'ui', 'index.html'));
});

// ── Start ──
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
