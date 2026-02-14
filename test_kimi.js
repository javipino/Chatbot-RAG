const https = require('https');
const fs = require('fs');

// Load .env
const envLines = fs.readFileSync('.env', 'utf-8').split('\n');
for (const l of envLines) {
    const t = l.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) {
        const k = t.slice(0, i).trim(), v = t.slice(i + 1).trim();
        if (!process.env[k]) process.env[k] = v;
    }
}

const ep = process.env.AZURE_OPENAI_READER_ENDPOINT;
const key = process.env.AZURE_OPENAI_READER_KEY;

const body = JSON.stringify({
    messages: [{ role: 'user', content: 'Di solo: Hola mundo' }],
    max_completion_tokens: 4096
});

const opt = {
    hostname: ep,
    path: '/openai/deployments/Kimi-K2.5/chat/completions?api-version=2025-01-01-preview',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': key }
};

console.log('Calling Kimi K2.5...');
const t0 = Date.now();

const req = https.request(opt, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
        console.log('Status:', res.statusCode, 'Time:', (Date.now() - t0) + 'ms');
        try {
            const j = JSON.parse(d);
            const msg = j.choices[0].message;
            console.log('\ncontent:', JSON.stringify(msg.content));
            console.log('reasoning_content:', JSON.stringify((msg.reasoning_content || '').substring(0, 300)));
            console.log('finish_reason:', j.choices[0].finish_reason);
            console.log('\nusage:', JSON.stringify(j.usage));
        } catch (e) {
            console.log('Raw response:', d.substring(0, 1000));
        }
    });
});
req.on('error', e => console.error('Error:', e.message));
req.write(body);
req.end();
