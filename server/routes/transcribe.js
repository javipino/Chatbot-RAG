// ── POST /api/transcribe ──
// Accepts a raw audio file body (multipart or raw binary).
// Returns: { text: string }
//
// cURL example:
//   curl -X POST https://<host>/api/transcribe \
//     -H "x-api-key: <RAG_API_KEY>" \
//     -H "Content-Type: audio/ogg" \
//     --data-binary @audio.ogg

const express = require('express');
const router = express.Router();

const { requireApiKey } = require('../middleware/auth');
const { transcribeBuffer } = require('../services/speech');

// Allowed MIME types and their Azure-accepted Content-Type header values
const MIME_MAP = {
    'audio/ogg': 'audio/ogg; codecs=opus',
    'audio/ogg; codecs=opus': 'audio/ogg; codecs=opus',
    'audio/wav': 'audio/wav',
    'audio/wave': 'audio/wav',
    'audio/x-wav': 'audio/wav',
    'audio/mp3': 'audio/mpeg',
    'audio/mpeg': 'audio/mpeg',
    'audio/flac': 'audio/flac',
    'audio/x-flac': 'audio/flac',
    'audio/webm': 'audio/webm; codecs=opus',
    'audio/webm; codecs=opus': 'audio/webm; codecs=opus',
};

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

// Parse raw binary body (express.raw middleware)
router.use(
    express.raw({
        type: Object.keys(MIME_MAP),
        limit: `${MAX_BYTES}`,
    })
);

router.post('/', requireApiKey, async (req, res) => {
    const rawContentType = (req.headers['content-type'] || '').toLowerCase().split(';')[0].trim();
    const speechContentType = MIME_MAP[rawContentType];

    if (!speechContentType) {
        return res.status(415).json({
            error: `Unsupported media type: ${rawContentType}. Supported: ${Object.keys(MIME_MAP).join(', ')}`,
        });
    }

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'Empty or non-binary body. Send raw audio bytes.' });
    }

    const language = (req.query.lang || req.headers['x-language'] || 'es-ES').trim();

    console.log(`[TRANSCRIBE] ${rawContentType} | ${req.body.length} bytes | lang=${language}`);

    try {
        const text = await transcribeBuffer(req.body, speechContentType, language);
        console.log(`[TRANSCRIBE] OK — "${text.substring(0, 80)}${text.length > 80 ? '…' : ''}"`);
        res.json({ text });
    } catch (err) {
        console.error('[TRANSCRIBE] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
