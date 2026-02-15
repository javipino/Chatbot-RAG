// ── HTTPS request helper ──

const https = require('https');

/**
 * Make an HTTPS JSON request and return parsed response.
 * @param {Object} options - https.request options (hostname, path, method, headers, port)
 * @param {Object|null} body - JSON body to send
 * @returns {Promise<Object>} parsed JSON response
 */
function httpsRequest(options, body) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', d => chunks.push(d));
            res.on('end', () => {
                const data = Buffer.concat(chunks).toString();
                if (res.statusCode >= 400) {
                    reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 500)}`));
                } else {
                    resolve(JSON.parse(data));
                }
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

module.exports = { httpsRequest };
