/**
 * retena.js — Retena multi-tenant message capture + transcription
 *
 * Replaces the logic from the old single-session vozclara-baileys/index.js.
 * Every call receives a sessionId which maps 1:1 to a tenant_id.
 * The tenant_id is stored in SQLite (whatsapp_sessions.tenant_id) and used
 * on every Supabase write.
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');
const {
    downloadMediaMessage,
    isJidGroup,
    isJidStatusBroadcast,
    getContentType,
} = require('@whiskeysockets/baileys');
const Groq = require('groq-sdk');
const fs   = require('fs');
const path = require('path');

// ── Supabase ─────────────────────────────────────────────────────────────────
const RETENA_URL = process.env.SUPABASE_URL || 'https://mfhdoiddbgpjqjukacnc.supabase.co';
const RETENA_KEY = process.env.SUPABASE_KEY ||
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1maGRvaWRkYmdwanFqdWthY25jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4NjEyNTIsImV4cCI6MjA4ODQzNzI1Mn0.fSL2d0gFjqyFLEPwCrzFI-r49oqCZNJiq4LJS3C0m50';
const RETENA_SVC_KEY = process.env.SUPABASE_SERVICE_KEY ||
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1maGRvaWRkYmdwanFqdWthY25jIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Mjg2MTI1MiwiZXhwIjoyMDg4NDM3MjUyfQ.moNSXuGoEwNEoFtaNPJ9BuGGAAeva6w7O8KoNTtYBMc';

const supabase    = createClient(RETENA_URL, RETENA_KEY);
const supabaseSvc = createClient(RETENA_URL, RETENA_SVC_KEY);

// ── Groq ─────────────────────────────────────────────────────────────────────
const GROQ_API_KEY = process.env.GROQ_API_KEY;
let groq = null;
if (GROQ_API_KEY) {
    groq = new Groq({ apiKey: GROQ_API_KEY });
} else {
    console.warn('[retena] GROQ_API_KEY not set — transcription disabled');
}

// ── Temp dir ──────────────────────────────────────────────────────────────────
const TEMP_DIR = path.join('/tmp', 'retena-audio');
fs.mkdirSync(TEMP_DIR, { recursive: true });

// ── Per-session contact name cache ────────────────────────────────────────────
const _contactNames = {}; // phone → name (in-memory, reloaded on restart)

function getContactName(phone, fallback) {
    return _contactNames[phone] || fallback || phone || 'Unknown';
}

async function syncContacts(contactsMap, tenantId) {
    const names = {};
    for (const [jid, contact] of Object.entries(contactsMap || {})) {
        const phone = jid.split('@')[0];
        const name  = contact.name || contact.notify || contact.verifiedName || null;
        if (name) { names[phone] = name; }
    }
    Object.assign(_contactNames, names);

    const rows = Object.entries(names).map(([phone, display_name]) => ({
        phone,
        display_name,
        tenant_id:  tenantId || null,
        updated_at: new Date().toISOString(),
    }));

    for (let i = 0; i < rows.length; i += 50) {
        const { error } = await supabase
            .from('retena_contacts')
            .upsert(rows.slice(i, i + 50), { onConflict: 'phone,tenant_id' });
        if (error) console.error('[retena] contact upsert error:', error.message);
    }
}

// ── Capture config cache (per tenant) ────────────────────────────────────────
const _captureCache    = {};
const _captureCacheTs  = {};

async function getCaptureConfig(tenantId) {
    const now = Date.now();
    if (_captureCache[tenantId] && now - (_captureCacheTs[tenantId] || 0) < 15000) {
        return _captureCache[tenantId];
    }
    try {
        const { data } = await supabase
            .from('retena_group_config')
            .select('chat_id,capture_enabled')
            .eq('tenant_id', tenantId);
        const map = {};
        (data || []).forEach(c => { map[c.chat_id] = c.capture_enabled; });
        _captureCache[tenantId]   = map;
        _captureCacheTs[tenantId] = now;
        return map;
    } catch (e) {
        console.error('[retena] getCaptureConfig error:', e.message);
        return _captureCache[tenantId] || {};
    }
}

// ── Parse Baileys message ─────────────────────────────────────────────────────
function parseBaileysMsg(msg, ownerNumber) {
    const jid      = msg.key.remoteJid || '';
    const fromMe   = msg.key.fromMe || false;
    const isGroup  = isJidGroup(jid);
    const isStatus = isJidStatusBroadcast(jid) || jid === 'status@broadcast';

    const content    = msg.message || {};
    const contentKey = getContentType(content);
    const inner      = content[contentKey] || {};

    const isVoice = contentKey === 'audioMessage' || contentKey === 'pttMessage';
    const isMedia = ['imageMessage', 'videoMessage', 'documentMessage', 'stickerMessage'].includes(contentKey);
    const bodyText = content.conversation
        || inner.caption
        || content.extendedTextMessage?.text
        || '';

    const senderJid   = isGroup ? (msg.key.participant || '') : jid;
    const senderPhone = senderJid.split('@')[0];
    const senderName  = fromMe
        ? 'Jeffrey'
        : getContactName(senderPhone, msg.pushName || senderPhone);

    const durationSec = isVoice ? (inner.seconds || 0) : 0;
    const waId        = msg.key.id || `${jid}_${msg.messageTimestamp}`;
    const timestamp   = new Date((msg.messageTimestamp || 0) * 1000).toISOString();

    return {
        jid, fromMe, isGroup, isStatus,
        contentKey, isVoice, isMedia, bodyText,
        senderJid, senderPhone, senderName,
        durationSec, waId, timestamp,
    };
}

// ── Capture message to retena_messages ──────────────────────────────────────
async function captureMessage(msg, sock, tenantId, ownerNumber) {
    try {
        const p = parseBaileysMsg(msg, ownerNumber);
        if (p.isStatus) return;
        if (!p.contentKey
            || p.contentKey === 'senderKeyDistributionMessage'
            || p.contentKey === 'protocolMessage') return;

        const chatId   = p.jid;
        const chatName = p.isGroup
            ? (chatId.split('@')[0]) // group JID prefix as fallback
            : (p.fromMe ? null : p.senderName);

        if (p.isGroup) {
            const config = await getCaptureConfig(tenantId);
            if (config[chatId] === false) return;

            // Auto-create group config if new
            if (!(chatId in config)) {
                await supabase.from('retena_group_config').upsert({
                    chat_id:         chatId,
                    display_name:    chatName || chatId,
                    capture_enabled: true,
                    tenant_id:       tenantId,
                }, { onConflict: 'chat_id,tenant_id' });
                _captureCacheTs[tenantId] = 0; // bust cache
            }
        }

        const messageType = p.isVoice ? 'voice' : p.isMedia ? 'media' : 'text';

        const record = {
            tenant_id:        tenantId,
            chat_id:          chatId,
            chat_name:        chatName,
            is_group:         p.isGroup,
            sender_phone:     p.senderPhone,
            sender_name:      p.senderName,
            sender_id:        p.senderPhone,
            message_type:     messageType,
            text_content:     p.bodyText,
            body:             p.bodyText,
            from_me:          p.fromMe,
            has_media:        p.isVoice || p.isMedia,
            wa_message_id:    p.waId,
            wa_type:          p.contentKey,
            timestamp:        p.timestamp,
            duration_seconds: p.durationSec || null,
        };

        // Download + store voice notes immediately (for retry transcription)
        if (p.isVoice) {
            try {
                const audioBuffer = await downloadMediaMessage(
                    msg, 'buffer', {},
                    { reuploadRequest: sock?.updateMediaMessage }
                );
                if (audioBuffer?.length) {
                    const content   = msg.message[p.contentKey];
                    const mimeType  = content?.mimetype || 'audio/ogg; codecs=opus';
                    const ext       = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('webm') ? 'webm' : 'ogg';
                    const storagePath = `${tenantId}/${p.timestamp.slice(0, 10)}/${p.waId}.${ext}`;

                    const { error: storageErr } = await supabaseSvc.storage
                        .from('voice-notes')
                        .upload(storagePath, audioBuffer, { contentType: mimeType, upsert: true });

                    if (!storageErr) {
                        record.audio_storage_path = storagePath;
                    } else {
                        console.error('[retena] audio storage error:', storageErr.message);
                    }
                }
            } catch (dlErr) {
                console.error('[retena] audio download failed:', dlErr.message);
            }
        }

        const { error } = await supabase.from('retena_messages').insert(record);
        if (error) console.error('[retena] insert error:', error.message);

        // Group member stats
        if (p.isGroup && p.senderPhone) {
            supabase.from('rt_group_members').upsert({
                chat_id:         chatId,
                phone:           p.senderPhone,
                display_name:    p.senderName,
                tenant_id:       tenantId,
                last_message_at: p.timestamp,
                updated_at:      new Date().toISOString(),
            }, { onConflict: 'chat_id,phone,tenant_id' }).catch(() => {});

            supabase.rpc('increment_member_stat', {
                p_chat_id: chatId,
                p_phone:   p.senderPhone,
                p_col:     p.isVoice ? 'voice_count' : 'message_count',
            }).catch(() => {});
        }

        return p; // return parsed msg for transcription step
    } catch (e) {
        console.error('[retena] captureMessage error:', e.message);
        return null;
    }
}

// ── Transcribe (Groq Whisper) ─────────────────────────────────────────────────
async function transcribe(audioBuffer, mimetype) {
    if (!groq) throw new Error('Groq not configured');
    const ext      = mimetype.includes('ogg') ? 'ogg' : mimetype.includes('mp4') ? 'mp4' : 'webm';
    const filePath = path.join(TEMP_DIR, `audio_${Date.now()}.${ext}`);
    try {
        fs.writeFileSync(filePath, audioBuffer);
        const result = await groq.audio.transcriptions.create({
            file:            fs.createReadStream(filePath),
            model:           'whisper-large-v3-turbo',
            response_format: 'verbose_json',
            prompt:          'Puntuación correcta, mayúsculas y párrafos. Proper punctuation, capitalization and paragraphs. Ponctuation correcte, majuscules et paragraphes.',
        });
        let text = result.text || '';
        const FRAGS = [
            'Puntuación correcta, mayúsculas y párrafos.',
            'Proper punctuation, capitalization and paragraphs.',
            'Ponctuation correcte, majuscules et paragraphes.',
        ];
        for (const f of FRAGS) text = text.replace(f, '');
        text = text.replace(/\s{2,}/g, ' ').trim();
        return { text, language: result.language, duration: result.duration };
    } finally {
        fs.unlink(filePath, () => {});
    }
}

// ── Summarize ─────────────────────────────────────────────────────────────────
async function summarize(text, lang, durationSec) {
    if (!groq || !text || text.length < 80) return null;
    const spanishWords = (text.match(/\b(que|con|por|está|una|para|esto|como|pero|hay|tengo)\b/gi) || []).length;
    const frenchWords  = (text.match(/\b(que|avec|pour|est|une|dans|nous|vous|mais|pas|je)\b/gi) || []).length;
    const dominant     = spanishWords > 3 ? 'spanish' : frenchWords > 3 ? 'french' : lang;
    const langInstr    = { spanish: 'Responde en español.', french: 'Réponds en français.', english: 'Respond in English.' };
    const instruction  = langInstr[dominant] || langInstr.english;
    const dur          = durationSec || 0;
    const bulletCount  = dur < 30 ? 1 : dur < 120 ? '2-3' : dur < 300 ? '3-5' : '4-6';
    const maxTokens    = dur < 30 ? 100 : dur < 120 ? 200 : dur < 300 ? 350 : 500;

    const r = await groq.chat.completions.create({
        model:    'llama-3.1-8b-instant',
        messages: [
            { role: 'system', content: `Summarize this voice note in ${bulletCount} bullet points using • prefix. ${instruction} Just the bullets, no intro.` },
            { role: 'user',   content: text },
        ],
        temperature: 0.3,
        max_tokens:  maxTokens,
    });
    return r.choices[0]?.message?.content?.trim() || null;
}

// ── Text formatting helpers ───────────────────────────────────────────────────
function parseSummaryBullets(text) {
    if (!text) return text;
    const norm      = text.trim().replace(/ \* /g, '\n* ');
    const hasBullets = /(?:^|\n)\s*[•\-\*]\s/m.test(norm);
    if (hasBullets) {
        return norm.split('\n')
            .map(l => l.replace(/^\s*[•\-\*]\s*/, '').trim())
            .filter(l => l.length > 2)
            .map(l => '• ' + l)
            .join('\n');
    }
    const sentences = (text.match(/[^.!?]+[.!?]+/g) || [text]).map(s => s.trim()).filter(s => s.length > 3);
    const count     = text.length < 80 ? 1 : Math.min(3, sentences.length);
    return sentences.slice(0, count).map(s => '• ' + s).join('\n');
}

function fmtDuration(s) {
    if (!s) return '';
    const m = Math.floor(s / 60), sec = Math.round(s % 60);
    return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

function getLangFlag(lang) {
    const flags = { english: '🇬🇧', spanish: '🇪🇸', french: '🇫🇷', portuguese: '🇧🇷', german: '🇩🇪', arabic: '🇸🇦' };
    return flags[lang] || '🌐';
}

function formatTranscript(text, dur) {
    if (!text) return text;
    const raw = text.trim().replace(/\s+/g, ' ');
    if (dur < 30 && raw.length < 200) return raw;
    const sentences = [];
    const regex = /[^.!?]*[.!?]+[\s]*/g;
    let match;
    while ((match = regex.exec(raw)) !== null) {
        const s = match[0].trim();
        if (s.length > 3) sentences.push(s);
    }
    const covered = sentences.join(' ').length;
    if (covered < raw.length - 10) {
        const r = raw.slice(covered).trim();
        if (r.length > 3) sentences.push(r);
    }
    if (sentences.length <= 2) return raw;
    const targetLen = dur < 60 ? 250 : dur < 120 ? 200 : dur < 300 ? 160 : 140;
    const paras = [], cur = [];
    let curLen = 0;
    for (const s of sentences) {
        cur.push(s); curLen += s.length;
        if (curLen >= targetLen && cur.length >= 2) {
            paras.push(cur.join(' ')); cur.length = 0; curLen = 0;
        }
    }
    if (cur.length) paras.push(cur.join(' '));
    return paras.length === 1 && sentences.length > 5
        ? Array.from({ length: Math.ceil(sentences.length / 3) }, (_, i) => sentences.slice(i * 3, i * 3 + 3).join(' ')).join('\n\n')
        : paras.join('\n\n');
}

// ── Save transcription + delete audio ────────────────────────────────────────
async function saveTranscription(p, result, waId, summary) {
    const formattedText = formatTranscript(result.text, result.duration || p.durationSec || 0);
    const dur = result.duration || p.durationSec || 0;

    const { data: upd } = await supabase
        .from('retena_messages')
        .update({
            transcription:    formattedText,
            language:         result.language || null,
            duration_seconds: dur ? Math.round(dur) : null,
            summary:          summary || null,
        })
        .eq('wa_message_id', waId)
        .select('id');

    if (!upd?.length) {
        // Row may not have been inserted yet — upsert as fallback
        await supabase.from('retena_messages').upsert({
            chat_id:          p.jid,
            chat_name:        p.isGroup ? p.jid : p.senderName,
            is_group:         p.isGroup,
            sender_phone:     p.senderPhone,
            sender_name:      p.senderName,
            sender_id:        p.senderPhone,
            message_type:     'voice',
            text_content:     '',
            body:             '',
            from_me:          p.fromMe,
            has_media:        true,
            wa_message_id:    waId,
            timestamp:        p.timestamp,
            transcription:    formattedText,
            language:         result.language || null,
            duration_seconds: dur ? Math.round(dur) : null,
            summary:          summary || null,
        }, { onConflict: 'wa_message_id' });
    }
}

async function deleteStoredAudio(waMessageId) {
    try {
        const { data } = await supabase
            .from('retena_messages')
            .select('audio_storage_path')
            .eq('wa_message_id', waMessageId)
            .single();
        if (!data?.audio_storage_path) return;
        await supabaseSvc.storage.from('voice-notes').remove([data.audio_storage_path]);
        await supabase.from('retena_messages').update({ audio_storage_path: null }).eq('wa_message_id', waMessageId);
    } catch (e) {
        console.error('[retena] deleteStoredAudio error:', e.message);
    }
}

// ── Main message handler (called from whatsapp.js onMessage) ─────────────────
/**
 * Handle incoming WhatsApp message for a tenant.
 * @param {string} sessionId  — super-light session ID
 * @param {string} tenantId   — Retena tenant UUID (may equal sessionId for now)
 * @param {object} msg        — raw Baileys WAMessage
 * @param {object} sock       — Baileys socket (for download + reply)
 * @param {object} opts       — { ownerNumber, autoTranscribe, ownerMode }
 */
async function handleMessage(sessionId, tenantId, msg, sock, opts = {}) {
    const { ownerNumber = '', autoTranscribe = true, ownerMode = false } = opts;

    if (!msg.message) return;

    const p = parseBaileysMsg(msg, ownerNumber);
    if (p.isStatus) return;

    console.log(`[retena/${tenantId}] ${p.fromMe ? '→' : '←'} ${p.contentKey} from ${p.senderName}`);

    // Capture everything to Supabase (non-blocking)
    captureMessage(msg, sock, tenantId, ownerNumber).catch(e => console.error('[retena] capture:', e.message));

    if (!autoTranscribe || !p.isVoice) return;

    const startTime = Date.now();
    let audioBuffer = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            audioBuffer = await downloadMediaMessage(
                msg, 'buffer', {},
                { reuploadRequest: sock?.updateMediaMessage }
            );
            if (audioBuffer?.length) break;
        } catch (dlErr) {
            console.error(`[retena] download attempt ${attempt} failed:`, dlErr.message);
        }
        if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
    }
    if (!audioBuffer?.length) {
        console.error('[retena] no audio data after 3 attempts');
        return;
    }

    const content  = msg.message[p.contentKey];
    const mimeType = content?.mimetype || 'audio/ogg; codecs=opus';

    let result;
    try {
        result = await transcribe(audioBuffer, mimeType);
    } catch (txErr) {
        console.error('[retena] transcription attempt 1 failed:', txErr.message, '— retrying');
        await new Promise(r => setTimeout(r, 3000));
        result = await transcribe(audioBuffer, mimeType);
    }

    if (!result.text?.trim()) {
        console.log('[retena] empty transcription — skipping');
        return;
    }

    const dur     = result.duration || p.durationSec || 0;
    const summary = result.text.length > 80 ? await summarize(result.text, result.language, dur) : null;

    await saveTranscription(p, result, p.waId, summary);
    await deleteStoredAudio(p.waId);

    const elapsed   = ((Date.now() - startTime) / 1000).toFixed(1);
    const langFlag  = getLangFlag(result.language);
    const label     = p.isGroup ? `👥 ${p.jid} › ${p.senderName}` : `👤 ${p.senderName}`;
    let response    = `📍 *${label}*\n${langFlag} _${fmtDuration(dur)} · ${elapsed}s_\n\n`;
    if (summary) response += `💡 *Summary*\n${parseSummaryBullets(summary)}\n\n`;
    response += `📝 *Transcription*\n\n${formatTranscript(result.text, dur)}`;

    if (p.fromMe) {
        console.log(`[retena] own voice note (${elapsed}s) — saved to dashboard only`);
    } else if (ownerMode && ownerNumber) {
        const ownerJid = `${ownerNumber.replace(/\D/g, '')}@s.whatsapp.net`;
        await sock.sendMessage(ownerJid, { text: response });
    } else {
        await sock.sendMessage(p.jid, { text: response }, { quoted: msg });
    }

    console.log(`[retena/${tenantId}] ✅ transcribed in ${elapsed}s — ${p.senderName}`);
}

// ── Retry untranscribed voice notes (background job) ─────────────────────────
async function retryUntranscribed(tenantId) {
    try {
        let query = supabase
            .from('retena_messages')
            .select('id,audio_storage_path,duration_seconds,wa_message_id')
            .eq('message_type', 'voice')
            .not('audio_storage_path', 'is', null)
            .is('transcription', null)
            .order('created_at', { ascending: true })
            .limit(5);

        if (tenantId) query = query.eq('tenant_id', tenantId);

        const { data: pending } = await query;
        if (!pending?.length) return;
        console.log(`[retena] retry: ${pending.length} untranscribed`);

        for (const m of pending) {
            try {
                const { data: audioData } = await supabaseSvc.storage
                    .from('voice-notes')
                    .download(m.audio_storage_path);
                if (!audioData) continue;
                const buf  = Buffer.from(await audioData.arrayBuffer());
                const ext  = m.audio_storage_path.split('.').pop() || 'ogg';
                const mime = ext === 'mp4' ? 'audio/mp4' : ext === 'webm' ? 'audio/webm' : 'audio/ogg';
                const result = await transcribe(buf, mime);
                if (!result.text?.trim()) continue;
                const dur     = result.duration || m.duration_seconds || 0;
                const summary = result.text.length > 80 ? await summarize(result.text, result.language, dur) : null;
                await supabase.from('retena_messages').update({
                    transcription:    formatTranscript(result.text, dur),
                    language:         result.language || null,
                    duration_seconds: dur ? Math.round(dur) : m.duration_seconds,
                    summary:          summary || null,
                }).eq('id', m.id);
                await supabaseSvc.storage.from('voice-notes').remove([m.audio_storage_path]);
                await supabase.from('retena_messages').update({ audio_storage_path: null }).eq('id', m.id);
                console.log(`[retena] retry ✅ ${m.id}`);
            } catch (e) {
                console.error(`[retena] retry error ${m.id}:`, e.message);
            }
        }
    } catch (e) {
        console.error('[retena] retryUntranscribed error:', e.message);
    }
}

module.exports = {
    handleMessage,
    syncContacts,
    retryUntranscribed,
    supabase,
    supabaseSvc,
};
