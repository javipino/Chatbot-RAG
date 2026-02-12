// Azure Function - Proxy genérico para Azure OpenAI / Azure AI
// Acepta _apikey, _host y _path para redirigir a cualquier endpoint

const https = require('https');

module.exports = async function (context, req) {
    // --- Parse body ---
    let parsedBody = req.body;
    if (typeof parsedBody === 'string') {
        try { parsedBody = JSON.parse(parsedBody); } catch (e) {
            context.res = { status: 400, body: { error: 'Body no es JSON valido' } };
            return;
        }
    }

    if (!parsedBody || typeof parsedBody !== 'object') {
        context.res = {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
            body: { error: 'Body vacío o no es un objeto JSON' }
        };
        return;
    }

    // --- Config ---
    const DEFAULT_HOST = 'javie-mku5l3k8-swedencentral.cognitiveservices.azure.com';
    const DEFAULT_PATH = '/openai/responses?api-version=2025-04-01-preview';
    const API_KEY = process.env.AZURE_OPENAI_KEY || '';

    const apiKey = (parsedBody && parsedBody._apikey) || API_KEY;
    const targetHost = (parsedBody && parsedBody._host) || DEFAULT_HOST;
    const targetPath = (parsedBody && parsedBody._path) || DEFAULT_PATH;

    if (!apiKey) {
        context.res = {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
            body: { error: 'No hay API key configurada.' }
        };
        return;
    }

    // Clean internal fields before forwarding
    const body = { ...parsedBody };
    delete body._apikey;
    delete body._host;
    delete body._path;
    const bodyStr = JSON.stringify(body);

    // --- Forward to target endpoint ---
    try {
        const result = await new Promise((resolve, reject) => {
            const options = {
                hostname: targetHost,
                port: 443,
                path: targetPath,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'api-key': apiKey,
                    'Content-Length': Buffer.byteLength(bodyStr)
                },
                timeout: 120000
            };

            const request = https.request(options, (response) => {
                let data = '';
                response.on('data', chunk => data += chunk);
                response.on('end', () => {
                    resolve({ statusCode: response.statusCode, body: data });
                });
            });

            request.on('error', reject);
            request.on('timeout', () => {
                request.destroy();
                reject(new Error('Timeout conectando al endpoint'));
            });

            request.write(bodyStr);
            request.end();
        });

        let responseBody;
        try {
            responseBody = JSON.parse(result.body);
        } catch {
            responseBody = result.body;
        }

        context.res = {
            status: result.statusCode,
            headers: { 'Content-Type': 'application/json' },
            body: responseBody
        };

    } catch (err) {
        context.res = {
            status: 502,
            headers: { 'Content-Type': 'application/json' },
            body: { error: 'Error conectando: ' + err.message }
        };
    }
};
