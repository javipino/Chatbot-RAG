// ── Chat proxy route ──
// Forwards requests to any Azure OpenAI endpoint using _apikey, _host, _path

const express = require('express');
const { forwardRequest } = require('../services/openai');

const router = express.Router();

router.post('/', async (req, res) => {
    let body = req.body;
    if (!body || typeof body !== 'object') {
        return res.status(400).json({ error: 'Body vacío o no es un objeto JSON' });
    }

    const DEFAULT_HOST = 'javie-mku5l3k8-swedencentral.cognitiveservices.azure.com';
    const DEFAULT_PATH = '/openai/responses?api-version=2025-04-01-preview';
    const API_KEY = process.env.AZURE_OPENAI_KEY || '';

    const apiKey = body._apikey || API_KEY;
    const targetHost = body._host || DEFAULT_HOST;
    const targetPath = body._path || DEFAULT_PATH;

    if (!apiKey) {
        return res.status(400).json({ error: 'No hay API key configurada.' });
    }

    // Remove internal fields before forwarding
    const forwardBody = { ...body };
    delete forwardBody._apikey;
    delete forwardBody._host;
    delete forwardBody._path;

    try {
        const result = await forwardRequest(targetHost, targetPath, apiKey, forwardBody);

        let responseBody;
        try {
            responseBody = JSON.parse(result.body);
        } catch {
            responseBody = result.body;
        }

        res.status(result.statusCode).json(responseBody);
    } catch (err) {
        res.status(502).json({ error: 'Error conectando: ' + err.message });
    }
});

module.exports = router;
