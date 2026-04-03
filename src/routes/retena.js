/**
 * retena.js — Retena-specific API routes
 *
 * Mounted at /api/retena when RETENA_MODE=true
 *
 * Routes:
 *   GET  /api/retena/sessions           — list all tenant sessions
 *   POST /api/retena/sessions           — create session + register tenant
 *   GET  /api/retena/sessions/:id/qr    — get QR (JSON + dataURL)
 *   GET  /api/retena/sessions/:id/status — connection status
 *   POST /api/retena/sessions/:id/start  — start/reconnect session
 *   POST /api/retena/sessions/:id/stop   — stop session
 *   DELETE /api/retena/sessions/:id      — delete session + tenant
 *
 * Auth: X-Retena-Key header must match RETENA_API_KEY env var
 */

'use strict';

const express = require('express');
const QRCode  = require('qrcode');
const { randomUUID } = require('crypto');

const Session = require('../models/Session');
const { supabase } = require('../services/retena');

const router = express.Router();

// ── Auth middleware ───────────────────────────────────────────────────────────
const RETENA_API_KEY = process.env.RETENA_API_KEY || '';

router.use((req, res, next) => {
    if (!RETENA_API_KEY) return next(); // no key configured = open (dev only)
    const provided = req.headers['x-retena-key'] || req.query.key;
    if (provided !== RETENA_API_KEY) {
        return res.status(401).json({ error: 'unauthorized' });
    }
    next();
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function getWA() {
    return require('../services/whatsapp');
}

// In-memory QR store (set by connection.update in whatsapp.js via onUpdate callback)
// Keyed by sessionId → { qr, qrImage, generatedAt }
const _qrStore = new Map();

/**
 * Register onUpdate callback so we can capture QR codes.
 * Called from the main app when creating sessions.
 */
function onSessionUpdate(sessionId, status, detail, qr) {
    if (qr) {
        QRCode.toDataURL(qr, { width: 400, margin: 2 })
            .then(img => _qrStore.set(sessionId, { qr, qrImage: img, generatedAt: Date.now() }))
            .catch(() => _qrStore.set(sessionId, { qr, qrImage: null, generatedAt: Date.now() }));
    } else if (status === 'CONNECTED') {
        _qrStore.delete(sessionId);
    }
}

// ── Ensure tenant exists in Supabase ─────────────────────────────────────────
async function ensureTenant(sessionId, tenantId, name, phone) {
    const { error } = await supabase.from('retena_tenants').upsert({
        id:                tenantId,
        name:              name || sessionId,
        baileys_session_id: sessionId,
        status:            'active',
        updated_at:        new Date().toISOString(),
    }, { onConflict: 'id' });
    if (error) console.error('[retena-route] ensureTenant error:', error.message);
}

// ── GET /api/retena/sessions ──────────────────────────────────────────────────
router.get('/sessions', (req, res) => {
    const sessions = Session.getAll(null, true);
    const wa       = getWA();
    const result   = sessions.map(s => ({
        id:        s.id,
        tenant_id: s.tenant_id,
        status:    s.status,
        detail:    s.detail,
        connected: wa.isConnected(s.id),
        createdAt: s.created_at,
    }));
    res.json({ sessions: result });
});

// ── POST /api/retena/sessions ─────────────────────────────────────────────────
router.post('/sessions', async (req, res) => {
    try {
        const { sessionId, tenantId, name, phone, ownerEmail } = req.body;

        if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

        const resolvedTenantId = tenantId || randomUUID();

        // Create in SQLite
        let session;
        try {
            session = Session.create(sessionId, ownerEmail || 'retena@localhost');
        } catch (e) {
            if (e.message.includes('already exists')) {
                session = Session.findById(sessionId);
            } else throw e;
        }

        // Stamp tenant_id
        Session.setTenantId(sessionId, resolvedTenantId);

        // Ensure tenant row in Supabase
        await ensureTenant(sessionId, resolvedTenantId, name, phone);

        // Start connection (non-blocking)
        const wa = getWA();
        wa.connect(sessionId, onSessionUpdate, null).catch(e =>
            console.error(`[retena] connect error for ${sessionId}:`, e.message)
        );

        res.json({
            ok:        true,
            sessionId,
            tenantId:  resolvedTenantId,
            token:     session.token,
            message:   'Session created — scan QR at /api/retena/sessions/:id/qr',
        });
    } catch (e) {
        console.error('[retena-route] POST /sessions error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── GET /api/retena/sessions/:id/qr ──────────────────────────────────────────
router.get('/sessions/:id/qr', async (req, res) => {
    const { id } = req.params;
    const wa     = getWA();

    if (wa.isConnected(id)) {
        return res.json({ connected: true, qrImage: null });
    }

    const stored = _qrStore.get(id);
    if (!stored) {
        return res.json({ connected: false, qrImage: null, message: 'No QR yet — session may still be initializing' });
    }

    const ageMs = Date.now() - stored.generatedAt;
    if (req.query.html !== undefined) {
        // Return a scannable HTML page
        res.setHeader('Content-Type', 'text/html');
        return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Retena QR — ${id}</title>
<style>body{background:#111;color:#fff;font-family:sans-serif;text-align:center;padding:40px}img{border:8px solid #fff;border-radius:8px;max-width:380px}</style>
</head><body>
<h2>📱 Scan with WhatsApp — ${id}</h2>
<p>Settings → Linked Devices → Link a Device</p>
${stored.qrImage ? `<img src="${stored.qrImage}" />` : '<p>⏳ Generating QR…</p>'}
<p style="color:#888;font-size:12px">Generated ${Math.round(ageMs / 1000)}s ago</p>
<script>setTimeout(()=>location.reload(),5000)</script>
</body></html>`);
    }

    res.json({
        connected:   false,
        qrImage:     stored.qrImage,
        qr:          stored.qr,
        generatedAt: stored.generatedAt,
        ageMs,
    });
});

// ── GET /api/retena/sessions/:id/status ──────────────────────────────────────
router.get('/sessions/:id/status', (req, res) => {
    const { id } = req.params;
    const wa      = getWA();
    const session = Session.findById(id);

    if (!session) return res.status(404).json({ error: 'session not found' });

    const sock = wa.getSocket(id);
    res.json({
        sessionId:  id,
        tenantId:   session.tenant_id,
        status:     session.status,
        detail:     session.detail,
        connected:  wa.isConnected(id),
        phone:      sock?.user?.id?.split(':')[0] || null,
        name:       sock?.user?.name || null,
    });
});

// ── POST /api/retena/sessions/:id/start ──────────────────────────────────────
router.post('/sessions/:id/start', async (req, res) => {
    const { id } = req.params;
    const wa     = getWA();

    if (wa.isConnected(id)) {
        return res.json({ ok: true, message: 'already connected' });
    }

    try {
        await wa.connect(id, onSessionUpdate, null);
        res.json({ ok: true, message: 'connecting — check /qr to scan' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── POST /api/retena/sessions/:id/stop ───────────────────────────────────────
router.post('/sessions/:id/stop', (req, res) => {
    const { id } = req.params;
    getWA().disconnect(id);
    _qrStore.delete(id);
    res.json({ ok: true });
});

// ── DELETE /api/retena/sessions/:id ──────────────────────────────────────────
router.delete('/sessions/:id', async (req, res) => {
    const { id } = req.params;
    const session = Session.findById(id);
    getWA().deleteSessionData(id);
    _qrStore.delete(id);

    if (session?.tenant_id) {
        await supabase
            .from('retena_tenants')
            .update({ status: 'deleted', updated_at: new Date().toISOString() })
            .eq('id', session.tenant_id)
            .catch(() => {});
    }

    res.json({ ok: true });
});

module.exports = { router, onSessionUpdate };
