/**
 * supabase-auth-state.js
 *
 * Baileys auth state backed by Supabase Storage.
 * Each session gets its own file: wa-sessions/baileys/{sessionId}/auth-state.json
 *
 * Drop-in replacement for useMultiFileAuthState with Supabase persistence.
 * Uses the SERVICE-ROLE client (supabaseSvc) for storage writes.
 */

'use strict';

const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const { supabaseSvc } = require('./retena');

const BUCKET = 'wa-sessions';

/**
 * Returns a file path in the bucket scoped to a sessionId.
 */
function authPath(sessionId) {
    return `baileys/${sessionId}/auth-state.json`;
}

/**
 * Load auth state from Supabase, or create fresh credentials.
 * @param {string} sessionId
 * @returns {{ state, saveCreds }}
 */
async function useSupabaseAuthState(sessionId) {
    let creds;
    let keys = {};

    try {
        const { data, error } = await supabaseSvc.storage
            .from(BUCKET)
            .download(authPath(sessionId));

        if (!error && data) {
            const text   = await data.text();
            const parsed = JSON.parse(text, BufferJSON.reviver);
            creds = parsed.creds;
            keys  = parsed.keys || {};
            console.log(`[auth/${sessionId}] Restored auth state ✅`);
        } else {
            console.log(`[auth/${sessionId}] No saved state — fresh QR needed`);
            creds = initAuthCreds();
        }
    } catch (e) {
        console.warn(`[auth/${sessionId}] Restore error: ${e.message} — starting fresh`);
        creds = initAuthCreds();
    }

    const state = {
        creds,
        keys: {
            get: (type, ids) => {
                const result = {};
                for (const id of ids) {
                    const v = keys[`${type}-${id}`];
                    if (v !== undefined) result[id] = v;
                }
                return result;
            },
            set: (data) => {
                for (const [category, items] of Object.entries(data)) {
                    for (const [id, value] of Object.entries(items)) {
                        if (value) keys[`${category}-${id}`] = value;
                        else delete keys[`${category}-${id}`];
                    }
                }
            },
        },
    };

    const saveCreds = async () => {
        try {
            const payload = JSON.stringify({ creds, keys }, BufferJSON.replacer);
            const blob    = Buffer.from(payload, 'utf-8');

            const { error } = await supabaseSvc.storage
                .from(BUCKET)
                .upload(authPath(sessionId), blob, {
                    contentType: 'application/json',
                    upsert:      true,
                });

            if (error) console.error(`[auth/${sessionId}] Save error:`, error.message);
        } catch (e) {
            console.error(`[auth/${sessionId}] saveCreds error:`, e.message);
        }
    };

    return { state, saveCreds };
}

module.exports = { useSupabaseAuthState };
