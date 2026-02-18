// ── Express application entry point ──

const express = require('express');
const path = require('path');

const chatRouter = require('./routes/chat');
const ragRouter = require('./routes/rag');
const transcribeRouter = require('./routes/transcribe');

const app = express();
const PORT = process.env.PORT || 8080;

// Parse JSON bodies (100KB limit)
app.use(express.json({ limit: '100kb' }));

// ── API Routes (before static so /api/* isn't caught by static middleware) ──
app.use('/api/chat', chatRouter);
app.use('/api/rag', ragRouter);
app.use('/api/transcribe', transcribeRouter);

// ── Static files (frontend) ──
app.use(express.static(path.join(__dirname, '..', 'public')));

// SPA fallback — serve index.html for any non-API, non-file route
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ── Start server ──
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
