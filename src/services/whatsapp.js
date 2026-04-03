/**
 * WhatsApp Service
 * Handles Baileys WhatsApp connection logic
 *
 * Multi-tenant mode (RETENA_MODE=true):
 *   - Auth stored in Supabase Storage via supabase-auth-state.js
 *   - Messages routed through retena.js (capture + transcription)
 *   - tenant_id = sessionId (each session is one tenant)
 *
 * Standard mode (RETENA_MODE not set):
 *   - Auth stored on disk (auth_info_baileys/)
 *   - Messages delivered via onMessage callback
 */

const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    fetchLatestWaWebVersion,
    makeCacheableSignalKeyStore,
    isJidBroadcast,
    Browsers,
    DisconnectReason
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs   = require('fs');
const Session      = require('../models/Session');
const ActivityLog  = require('../models/ActivityLog');

// Logger configuration
const defaultLogLevel = process.env.NODE_ENV === 'production' ? 'silent' : 'warn';
const logger = pino({ level: process.env.LOG_LEVEL || defaultLogLevel });

// Active socket connections (in-memory)
const activeSockets = new Map();
const retryCounters = new Map();

// Auth directory — configurable via env for persistent volume support
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, '../../auth_info_baileys');

// Retena mode flag
const RETENA_MODE = process.env.RETENA_MODE === 'true' || process.env.RETENA_MODE === '1';

// Lazy-load retena services only when needed
let retenaService        = null;
let supabaseAuthState    = null;
function getRetena() {
    if (!retenaService) retenaService = require('./retena');
    return retenaService;
}
function getSupabaseAuth() {
    if (!supabaseAuthState) supabaseAuthState = require('./supabase-auth-state');
    return supabaseAuthState;
}

/**
 * Ensure auth directory exists (for file-based auth)
 */
function ensureAuthDir() {
    if (!fs.existsSync(AUTH_DIR)) {
        fs.mkdirSync(AUTH_DIR, { recursive: true });
    }
}

/**
 * Connect to WhatsApp
 * @param {string} sessionId - Session ID
 * @param {function} onUpdate  - Callback for status updates
 * @param {function} onMessage - Callback for incoming messages (non-Retena mode)
 * @returns {object} Socket connection
 */
async function connect(sessionId, onUpdate, onMessage) {
    if (!require('../utils/validation').isValidId(sessionId)) {
        throw new Error('Invalid session ID');
    }

    // ── Auth state ────────────────────────────────────────────────────────────
    let state, saveCreds;

    if (RETENA_MODE) {
        const { useSupabaseAuthState } = getSupabaseAuth();
        ({ state, saveCreds } = await useSupabaseAuthState(sessionId));
    } else {
        ensureAuthDir();
        const sessionDir = path.join(AUTH_DIR, sessionId);
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }
        ({ state, saveCreds } = await useMultiFileAuthState(sessionDir));
    }

    // Update session status
    Session.updateStatus(sessionId, 'CONNECTING', 'Initializing...');
    if (onUpdate) onUpdate(sessionId, 'CONNECTING', 'Initializing...', null);

    // ── WA version ────────────────────────────────────────────────────────────
    let version;
    try {
        const waVersion = await fetchLatestWaWebVersion({});
        version = waVersion.version;
        console.log(`[${sessionId}] Using WA Web version: ${version.join('.')}`);
    } catch (e) {
        const baileysVersion = await fetchLatestBaileysVersion();
        version = baileysVersion.version;
        console.log(`[${sessionId}] Using Baileys version: ${version.join('.')} (fallback)`);
    }

    // ── Socket ────────────────────────────────────────────────────────────────
    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys:  makeCacheableSignalKeyStore(state.keys, logger),
        },
        printQRInTerminal: false,
        logger,
        browser:                     Browsers.macOS('Chrome'),   // best compat for pairing
        generateHighQualityLinkPreview: false,
        shouldIgnoreJid:             (jid) => isJidBroadcast(jid),
        qrTimeout:                   40000,
        markOnlineOnConnect:         false,  // keep phone notifications
        syncFullHistory:             false,
        retryRequestDelayMs:         500,
        maxMsgRetryCount:            3,
        connectTimeoutMs:            60000,
        keepAliveIntervalMs:         25000,
        defaultQueryTimeoutMs:       undefined,
        getMessage:                  async () => ({ conversation: 'hello' }),
    });

    activeSockets.set(sessionId, sock);

    // ── Credentials update ────────────────────────────────────────────────────
    sock.ev.on('creds.update', saveCreds);

    // ── Connection state ──────────────────────────────────────────────────────
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            Session.updateStatus(sessionId, 'GENERATING_QR', 'Scan QR code');
            if (onUpdate) onUpdate(sessionId, 'GENERATING_QR', 'Scan QR code', qr);
        }

        if (connection === 'connecting') {
            Session.updateStatus(sessionId, 'CONNECTING', 'Connecting...');
            if (onUpdate) onUpdate(sessionId, 'CONNECTING', 'Connecting...', null);
        }

        if (connection === 'open') {
            console.log(`[${sessionId}] ✅ Connected!`);
            retryCounters.delete(sessionId);
            const name = sock.user?.name || 'Unknown';
            Session.updateStatus(sessionId, 'CONNECTED', `Connected as ${name}`);
            if (onUpdate) onUpdate(sessionId, 'CONNECTED', `Connected as ${name}`, null);

            // Sync contacts for Retena
            if (RETENA_MODE) {
                setTimeout(() => {
                    const contacts = sock.store?.contacts || {};
                    getRetena().syncContacts(contacts, sessionId).catch(() => {});
                }, 5000);
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const reason = lastDisconnect?.error?.output?.payload?.message || 'Connection closed';

            console.log(`[${sessionId}] Disconnected: ${statusCode} - ${reason}`);
            Session.updateStatus(sessionId, 'DISCONNECTED', reason);
            if (onUpdate) onUpdate(sessionId, 'DISCONNECTED', reason, null);

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut
                && statusCode !== 401
                && statusCode !== 403;

            if (shouldReconnect) {
                const retryCount = (retryCounters.get(sessionId) || 0) + 1;
                retryCounters.set(sessionId, retryCount);
                if (retryCount <= 5) {
                    console.log(`[${sessionId}] Reconnecting... (attempt ${retryCount})`);
                    setTimeout(() => connect(sessionId, onUpdate, onMessage), 5000);
                } else {
                    console.log(`[${sessionId}] Max retries reached`);
                    retryCounters.delete(sessionId);
                }
            } else {
                if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                    console.log(`[${sessionId}] Logged out`);
                    if (!RETENA_MODE) {
                        const sessionDir = path.join(AUTH_DIR, sessionId);
                        if (fs.existsSync(sessionDir)) {
                            fs.rmSync(sessionDir, { recursive: true, force: true });
                        }
                    }
                    // In Retena mode: Supabase auth cleaned up separately if needed
                }
            }

            activeSockets.delete(sessionId);
        }
    });

    // ── Incoming messages ─────────────────────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message) continue;

            if (RETENA_MODE) {
                // Route to Retena multi-tenant handler
                const tenantId      = Session.getTenantId(sessionId) || sessionId;
                const ownerNumber   = process.env.OWNER_NUMBER || '';
                const autoTranscribe = process.env.AUTO_TRANSCRIBE !== 'false';
                const ownerMode     = process.env.OWNER_MODE === 'true';

                getRetena().handleMessage(sessionId, tenantId, msg, sock, {
                    ownerNumber,
                    autoTranscribe,
                    ownerMode,
                }).catch(e => console.error(`[retena/${sessionId}] message handler error:`, e.message));

            } else if (onMessage && !msg.key.fromMe) {
                // Standard mode: deliver to caller's callback
                onMessage(sessionId, msg);
            }
        }
    });

    // ── Contacts (Retena) ─────────────────────────────────────────────────────
    if (RETENA_MODE) {
        sock.ev.on('contacts.upsert', (contacts) => {
            const map = {};
            for (const c of contacts) {
                if (c.id && (c.name || c.notify)) map[c.id] = c;
            }
            if (Object.keys(map).length) {
                getRetena().syncContacts(map, sessionId).catch(() => {});
            }
        });

        sock.ev.on('contacts.update', (updates) => {
            const map = {};
            for (const c of updates) {
                if (c.id && (c.name || c.notify)) map[c.id] = c;
            }
            if (Object.keys(map).length) {
                getRetena().syncContacts(map, sessionId).catch(() => {});
            }
        });
    }

    return sock;
}

/**
 * Disconnect a session
 */
function disconnect(sessionId) {
    const sock = activeSockets.get(sessionId);
    if (sock) { sock.end(); activeSockets.delete(sessionId); }
    retryCounters.delete(sessionId);
}

/**
 * Get socket for a session
 */
function getSocket(sessionId) {
    return activeSockets.get(sessionId) || null;
}

/**
 * Check if session is connected
 */
function isConnected(sessionId) {
    const sock = activeSockets.get(sessionId);
    return sock?.user != null;
}

/**
 * Delete session data (disk + SQLite; Supabase auth cleaned separately)
 */
function deleteSessionData(sessionId) {
    if (!require('../utils/validation').isValidId(sessionId)) return;
    disconnect(sessionId);
    if (!RETENA_MODE) {
        const sessionDir = path.join(AUTH_DIR, sessionId);
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
    }
    Session.delete(sessionId);
}

/**
 * Get all active sessions
 */
function getActiveSessions() {
    return activeSockets;
}

module.exports = {
    connect,
    disconnect,
    getSocket,
    isConnected,
    deleteSessionData,
    getActiveSessions,
    AUTH_DIR,
    RETENA_MODE,
};
