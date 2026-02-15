// ── API Key authentication middleware ──

const { RAG_API_KEY } = require('../config');

/**
 * Validates x-api-key header against RAG_API_KEY
 */
function requireApiKey(req, res, next) {
    if (!RAG_API_KEY) return next(); // No key configured = open

    const clientKey = req.headers['x-api-key'];
    if (!clientKey || clientKey !== RAG_API_KEY) {
        return res.status(401).json({ error: 'Invalid or missing API key' });
    }
    next();
}

module.exports = { requireApiKey };
