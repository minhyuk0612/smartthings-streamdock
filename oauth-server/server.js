const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');

// Both the source server and the bundled plugin use this runtime directory.
const OAUTH_DIR = path.join(__dirname, '..', 'oauth-server');
require('dotenv').config({ path: path.join(OAUTH_DIR, '.env'), quiet: true });
require('dotenv').config({ path: path.join(OAUTH_DIR, '..', '.env'), quiet: true });
const TOKEN_FILE = path.join(OAUTH_DIR, 'tokens.json');
const { SMARTTHINGS_CLIENT_ID, SMARTTHINGS_CLIENT_SECRET, SMARTTHINGS_REDIRECT_URI } = process.env;
const pendingOAuthStates = new Set();
let refreshPromise;

function loadTokens() {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    const text = fs.readFileSync(TOKEN_FILE, 'utf8');
    if (!text.trim()) return null;
    try { return JSON.parse(text); }
    catch { throw new Error('Saved tokens could not be read. Please reconnect SmartThings.'); }
}

function saveTokens(tokens, previous = {}) {
    const expiresIn = Number(tokens.expires_in);
    if (!tokens.access_token || !Number.isFinite(expiresIn) || expiresIn <= 0) {
        throw new Error('Invalid token response.');
    }
    const saved = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || previous.refresh_token,
        token_type: tokens.token_type || previous.token_type,
        scope: tokens.scope || previous.scope,
        expires_in: expiresIn,
        expires_at: Date.now() + expiresIn * 1000,
        updated_at: new Date().toISOString()
    };
    const temporaryFile = TOKEN_FILE + '.tmp';
    fs.writeFileSync(temporaryFile, JSON.stringify(saved, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryFile, TOKEN_FILE);
}

async function requestToken(parameters) {
    if (!SMARTTHINGS_CLIENT_ID || !SMARTTHINGS_CLIENT_SECRET) {
        throw new Error('SmartThings OAuth credentials are not configured.');
    }
    const basicAuth = Buffer.from(`${SMARTTHINGS_CLIENT_ID}:${SMARTTHINGS_CLIENT_SECRET}`).toString('base64');
    const response = await fetch('https://api.smartthings.com/oauth/token', {
        method: 'POST',
        headers: { Authorization: `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(parameters)
    });
    // Never include OAuth response bodies in errors or logs.
    if (!response.ok) throw new Error(`OAuth token request failed (${response.status}).`);
    try { return await response.json(); }
    catch { throw new Error('Invalid OAuth token response.'); }
}

async function refreshAccessToken() {
    // Multiple controls may request an expired token at the same time.
    if (!refreshPromise) {
        refreshPromise = (async () => {
            const current = loadTokens();
            if (!current?.refresh_token) throw new Error('No refresh token saved.');
            const tokens = await requestToken({ grant_type: 'refresh_token', refresh_token: current.refresh_token });
            saveTokens(tokens, current);
            return tokens.access_token;
        })();
    }
    try { return await refreshPromise; }
    finally { refreshPromise = undefined; }
}

async function getAccessToken() {
    const tokens = loadTokens();
    if (!tokens?.access_token) throw new Error('SmartThings is not connected.');
    if (!tokens.expires_at || Date.now() >= tokens.expires_at - 60000) return refreshAccessToken();
    return tokens.access_token;
}

async function smartThingsRequest(endpoint, options = {}, accessToken) {
    const token = accessToken || await getAccessToken();
    const response = await fetch(`https://api.smartthings.com/v1${endpoint}`, {
        ...options,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    if (!response.ok) throw new Error(`SmartThings API failed (${response.status}).`);
    try { return await response.json(); }
    catch { throw new Error('Invalid SmartThings API response.'); }
}

function json(res, status, data) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://127.0.0.1:3000');
        if (req.method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type'
            });
            return res.end();
        }
        if (url.pathname === '/login') {
            if (!SMARTTHINGS_CLIENT_ID || !SMARTTHINGS_REDIRECT_URI) {
                return json(res, 500, { success: false, error: 'SmartThings OAuth is not configured.' });
            }
            const state = randomBytes(24).toString('hex');
            pendingOAuthStates.add(state);
            setTimeout(() => pendingOAuthStates.delete(state), 10 * 60 * 1000).unref();
            const authorizeUrl = new URL('https://api.smartthings.com/oauth/authorize');
            authorizeUrl.search = new URLSearchParams({
                client_id: SMARTTHINGS_CLIENT_ID, response_type: 'code',
                redirect_uri: SMARTTHINGS_REDIRECT_URI, scope: 'r:devices:* x:devices:*', state
            }).toString();
            res.writeHead(302, { Location: authorizeUrl.toString() });
            return res.end();
        }
        if (url.pathname === '/oauth/callback') {
            const state = url.searchParams.get('state');
            if (!state || !pendingOAuthStates.delete(state)) {
                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                return res.end('<h1>Invalid OAuth state</h1>');
            }
            const code = url.searchParams.get('code');
            if (url.searchParams.get('error') || !code) {
                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                return res.end('<h1>SmartThings authorization failed</h1>');
            }
            const tokens = await requestToken({ grant_type: 'authorization_code', code, redirect_uri: SMARTTHINGS_REDIRECT_URI });
            saveTokens(tokens);
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end('<!doctype html><html><head><meta charset="utf-8"><title>SmartThings Connected</title></head><body><h1>SmartThings connected successfully</h1><p>You can close this window.</p></body></html>');
        }
        if (url.pathname === '/test') {
            const token = await refreshAccessToken();
            const data = await smartThingsRequest('/devices', {}, token);
            return json(res, 200, { success: true, deviceCount: data.items?.length ?? 0 });
        }
        if (url.pathname === '/devices') {
            const data = await smartThingsRequest('/devices');
            const devices = (data.items || []).map(({ deviceId, name, label }) => ({ deviceId, name, label }));
            return json(res, 200, { success: true, devices });
        }
        const statusMatch = url.pathname.match(/^\/api\/devices\/([^/]+)\/status$/);
        if (req.method === 'GET' && statusMatch) {
            const deviceId = encodeURIComponent(decodeURIComponent(statusMatch[1]));
            const status = await smartThingsRequest(`/devices/${deviceId}/status`);
            return json(res, 200, { success: true, status });
        }
        const commandMatch = url.pathname.match(/^\/api\/devices\/([^/]+)\/commands$/);
        if (req.method === 'POST' && commandMatch) {
            const deviceId = encodeURIComponent(decodeURIComponent(commandMatch[1]));
            let body = '';
            for await (const chunk of req) body += chunk;
            let payload;
            try { payload = JSON.parse(body || '{}'); }
            catch { return json(res, 400, { success: false, error: 'Invalid command JSON.' }); }
            if (!Array.isArray(payload.commands)) {
                return json(res, 400, { success: false, error: 'commands array is required.' });
            }
            const result = await smartThingsRequest(`/devices/${deviceId}/commands`, {
                method: 'POST', body: JSON.stringify({ commands: payload.commands })
            });
            return json(res, 200, { success: true, result });
        }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('StreamDock SmartThings OAuth Server');
    } catch {
        // Parser, network and filesystem errors can contain sensitive input.
        console.error('SmartThings request failed. Check OAuth configuration and connection.');
        json(res, 500, { success: false, error: 'SmartThings request failed. Please check the connection or reconnect.' });
    }
});

let starting = false;
server.on('listening', () => { starting = false; });
server.on('close', () => { starting = false; });
server.on('error', (error) => {
    starting = false;
    console.error(error.code === 'EADDRINUSE'
        ? 'OAuth server could not start: port 3000 is already in use.'
        : 'OAuth server could not start.');
});

function startOAuthServer() {
    if (server.listening || starting) return server;
    starting = true;
    server.listen(3000, '127.0.0.1', () => {
        console.log('OAuth server running on http://127.0.0.1:3000');
    });
    return server;
}

module.exports = { startOAuthServer };

if (require.main === module) {
    startOAuthServer();
}
