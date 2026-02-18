// ── Azure AI Speech — Speech-to-Text service ──
// Uses the Azure Cognitive Services Speech REST API v1
// Supports: wav, ogg (opus), mp3, flac, etc. — max 10 MB, max ~60 s per request
// For long audio use the Batch Transcription API (async job).

const https = require('https');
const { SPEECH_KEY, SPEECH_REGION } = require('../config');

/**
 * Transcribe an audio buffer using Azure AI Speech REST API.
 *
 * @param {Buffer} audioBuffer  - Raw audio bytes
 * @param {string} contentType  - MIME type e.g. 'audio/ogg; codecs=opus' | 'audio/wav'
 * @param {string} [language]   - BCP-47 locale, default 'es-ES'
 * @returns {Promise<string>}   - Transcribed text
 */
async function transcribeBuffer(audioBuffer, contentType, language = 'es-ES') {
    if (!SPEECH_KEY) throw new Error('AZURE_SPEECH_KEY not configured');

    const region = SPEECH_REGION || 'swedencentral';
    const host = `${region}.stt.speech.microsoft.com`;
    const path = `/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(language)}&format=detailed`;

    return new Promise((resolve, reject) => {
        const options = {
            hostname: host,
            path,
            method: 'POST',
            headers: {
                'Ocp-Apim-Subscription-Key': SPEECH_KEY,
                'Content-Type': contentType,
                'Content-Length': audioBuffer.length,
            },
        };

        const req = https.request(options, (res) => {
            let raw = '';
            res.on('data', (chunk) => (raw += chunk));
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    return reject(new Error(`Speech API error ${res.statusCode}: ${raw}`));
                }
                try {
                    const json = JSON.parse(raw);
                    // "RecognitionStatus": "Success" | "NoMatch" | "InitialSilenceTimeout" ...
                    if (json.RecognitionStatus !== 'Success') {
                        return reject(new Error(`Speech recognition failed: ${json.RecognitionStatus}`));
                    }
                    const text = json.DisplayText || json.NBest?.[0]?.Display || '';
                    resolve(text);
                } catch (e) {
                    reject(new Error(`Failed to parse Speech API response: ${raw}`));
                }
            });
        });

        req.on('error', reject);
        req.write(audioBuffer);
        req.end();
    });
}

module.exports = { transcribeBuffer };
