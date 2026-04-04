/**
 * compat.js — Backward-compatible routes for vozclara-api / retena-whatsapp contract
 *
 * Mounted at /session/:id/...
 * Mirrors the old retena-whatsapp API shape so vozclara-api needs zero changes.
 *
 * Routes consumed by vozclara-api:
 *   GET  /session/:id/status           → { status, number, session_id }
 *   POST /session/:id/start            → trigger connect (non-blocking)
 *   POST /session/:id/reset            → disconnect + clear auth
 *   GET  /session/:id/qr-data          → { qr, status }
 *   POST /session/:id/request-code     → pairing code (phone in body)
 *   GET  /session/:id/profile-pic/:phone → proxy profile picture
 *   POST /session/:id/group-invite/:jid → group invite link
 *   POST /session/:id/refresh-invite-codes → refresh group invites
 *
 * Auth: x-admin-key header (RETENA_WA_ADMIN_KEY env) or x-password (RETENA_WA_PASSWORD env)
 *       If neither env is set, the routes are open (dev mode).
 */

'use strict';

const express = require('express');
const router  = express.Router({ mergeParams: true });

const ADMIN_KEY = process.env.RETENA_WA_ADMIN_KEY  || '';
const PASSWORD  = process.env.RETENA_WA_PASSWORD   || process.env.PASSWORD || '';

// ── Auth middleware ───────────────────────────────────────────────────────────
router.use((req, res, next) => {
    if (!ADMIN_KEY && !PASSWORD) return next(); // open (dev)
    const provided = req.headers['x-admin-key'] || req.headers['x-password'] || req.query.key;
    if ((ADMIN_KEY && provided === ADMIN_KEY) || (PASSWORD && provided === PASSWORD)) return next();
    return res.status(401).json({ error: 'unauthorized' });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function getWA()     { return require('../services/whatsapp'); }
function getRetena() { return require('../services/retena'); }

// In-memory QR store — populated by connection.update events
// Shared with retena router via module-level singleton
const _qrStore = require('./retena')._qrStore || new Map();

function sessionStatus(sessionId) {
    const wa   = getWA();
    const sock = wa.getSocket(sessionId);
    const connected = wa.isConnected(sessionId);

    // Check in-memory socket first (survives even if SQLite row is missing after redeploy)
    if (connected) {
        return {
            status:     'connected',
            number:     sock?.user?.id?.split(':')[0] || null,
            name:       sock?.user?.name || null,
            session_id: sessionId,
        };
    }

    // QR in store but socket active = qr_ready
    if (_qrStore.has(sessionId)) {
        return { status: 'qr_ready', session_id: sessionId, number: null };
    }

    // Fall back to SQLite
    const sess = require('../models/Session').findById(sessionId);
    if (!sess) return { status: 'not_found', session_id: sessionId };

    // Map SQLite status to old retena-whatsapp status strings
    const statusMap = {
        GENERATING_QR: 'qr_ready',
        CONNECTING:    'connecting',
        DISCONNECTED:  'disconnected',
        CREATING:      'not_found',
        DELETED:       'not_found',
    };
    return {
        status:     statusMap[sess.status] || sess.status?.toLowerCase() || 'disconnected',
        session_id: sessionId,
        number:     null,
    };
}

// ── GET /session/:id/status ───────────────────────────────────────────────────
router.get('/:id/status', (req, res) => {
    res.json(sessionStatus(req.params.id));
});

// ── POST /session/:id/start ───────────────────────────────────────────────────
router.post('/:id/start', async (req, res) => {
    const { id } = req.params;
    const wa = getWA();

    // Create session row if it doesn't exist
    const Session = require('../models/Session');
    if (!Session.findById(id)) {
        try { Session.create(id, 'retena@localhost'); } catch (_) {}
    }

    // Set tenant_id from body if provided
    const body = req.body || {};
    if (body.account_id || body.tenant_id) {
        const tenantId = body.tenant_id || body.account_id;
        Session.setTenantId(id, tenantId);
        // Upsert tenant in Supabase
        getRetena().supabase.from('retena_tenants').upsert({
            id:                 tenantId,
            name:               id,
            baileys_session_id: id,
            status:             'active',
            updated_at:         new Date().toISOString(),
        }, { onConflict: 'id' }).catch(() => {});
    }

    if (wa.isConnected(id)) {
        return res.json({ ok: true, status: 'connected' });
    }

    // Non-blocking connect
    wa.connect(id, (sid, status, detail, qr) => {
        Session.updateStatus(sid, status, detail);
        if (qr) {
            require('qrcode').toDataURL(qr, { width: 400, margin: 2 })
                .then(img => _qrStore.set(sid, { qr, qrImage: img, generatedAt: Date.now() }))
                .catch(() => _qrStore.set(sid, { qr, qrImage: null, generatedAt: Date.now() }));
        } else if (status === 'CONNECTED') {
            _qrStore.delete(sid);
        }
    }, null).catch(e => console.error(`[compat] start error ${id}:`, e.message));

    res.json({ ok: true, status: 'starting', session_id: id });
});

// ── POST /session/:id/reset ───────────────────────────────────────────────────
router.post('/:id/reset', (req, res) => {
    const { id } = req.params;
    getWA().disconnect(id);
    _qrStore.delete(id);
    require('../models/Session').updateStatus(id, 'DISCONNECTED', 'Reset');
    res.json({ ok: true });
});

// ── GET /session/:id/qr-data ──────────────────────────────────────────────────
router.get('/:id/qr-data', (req, res) => {
    const { id } = req.params;
    const stored = _qrStore.get(id);

    if (getWA().isConnected(id)) {
        return res.json({ status: 'connected', qr: null });
    }
    if (!stored) {
        return res.json({ status: 'waiting', qr: null });
    }
    res.json({
        status:      'qr_ready',
        qr:          stored.qr,
        qrImage:     stored.qrImage,
        generatedAt: stored.generatedAt,
    });
});

// ── POST /session/:id/request-code ───────────────────────────────────────────
// Pairing code flow (phone number instead of QR)
router.post('/:id/request-code', async (req, res) => {
    const { id }       = req.params;
    const { phoneNumber } = req.body || {};

    if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber required' });

    const wa   = getWA();
    const sock = wa.getSocket(id);

    if (!sock) return res.status(404).json({ error: 'session not started — call /start first' });

    try {
        const clean = phoneNumber.replace(/\D/g, '');
        const code  = await sock.requestPairingCode(clean);
        res.json({ ok: true, code, session_id: id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── GET /session/:id/profile-pic/:phone ──────────────────────────────────────
router.get('/:id/profile-pic/:phone', async (req, res) => {
    const { id, phone } = req.params;
    const wa   = getWA();
    const sock = wa.getSocket(id);

    if (!sock || !wa.isConnected(id)) {
        return res.status(503).json({ error: 'session not connected' });
    }

    try {
        const jid = `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
        const url = await sock.profilePictureUrl(jid, 'image');
        res.json({ url: url || null });
    } catch {
        res.json({ url: null });
    }
});

// ── POST /session/:id/group-invite/:jid ──────────────────────────────────────
router.get('/:id/group-invite/:jid', async (req, res) => {
    const { id, jid } = req.params;
    const sock = getWA().getSocket(id);
    if (!sock) return res.status(503).json({ error: 'not connected' });
    try {
        const link = await sock.groupInviteCode(jid);
        res.json({ ok: true, link: `https://chat.whatsapp.com/${link}` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── POST /session/:id/refresh-invite-codes ────────────────────────────────────
router.post('/:id/refresh-invite-codes', async (req, res) => {
    // Fire-and-forget background refresh
    const sock = getWA().getSocket(req.params.id);
    if (sock) {
        (async () => {
            try {
                const { data: groups } = await getRetena().supabase
                    .from('retena_group_config')
                    .select('chat_id')
                    .eq('capture_enabled', true);
                for (const g of (groups || [])) {
                    try {
                        const code = await sock.groupInviteCode(g.chat_id);
                        await getRetena().supabase.from('retena_group_config')
                            .update({ invite_code: code })
                            .eq('chat_id', g.chat_id);
                    } catch {}
                    await new Promise(r => setTimeout(r, 500));
                }
            } catch {}
        })();
    }
    res.json({ ok: true, message: 'refresh queued' });
});

// ── GET / (health — root of /session namespace) ───────────────────────────────
router.get('/', (req, res) => {
    const wa       = getWA();
    const sessions = require('../models/Session').getAll(null, true);
    res.json({
        ok:       true,
        engine:   'super-light-retena',
        sessions: sessions.length,
        connected: sessions.filter(() => true).map(s => ({
            id:        s.id,
            connected: wa.isConnected(s.id),
            status:    s.status,
        })),
    });
});

module.exports = router;
