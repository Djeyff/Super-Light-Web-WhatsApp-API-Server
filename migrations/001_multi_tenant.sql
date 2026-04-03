-- Migration 001: Multi-tenant support for Retena
-- Run against: mfhdoiddbgpjqjukacnc (Supabase)
-- Date: 2026-04-03

-- ── Tenants ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS retena_tenants (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                TEXT NOT NULL,
    phone               TEXT,
    baileys_session_id  TEXT UNIQUE,
    status              TEXT DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ── Add tenant_id to existing tables ─────────────────────────────────────────

-- rewa_messages
ALTER TABLE rewa_messages
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES retena_tenants(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_rewa_messages_tenant_id ON rewa_messages(tenant_id);
CREATE INDEX IF NOT EXISTS idx_rewa_messages_tenant_timestamp ON rewa_messages(tenant_id, timestamp DESC);

-- retena_contacts
ALTER TABLE retena_contacts
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES retena_tenants(id) ON DELETE SET NULL;

-- Drop old PK on phone alone if it exists, replace with compound
-- (only if constraint doesn't already include tenant_id)
-- NOTE: run manually if this fails due to existing data
-- ALTER TABLE retena_contacts DROP CONSTRAINT IF EXISTS retena_contacts_pkey;
-- ALTER TABLE retena_contacts ADD PRIMARY KEY (phone, tenant_id);

-- retena_group_config
ALTER TABLE retena_group_config
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES retena_tenants(id) ON DELETE SET NULL;

-- rt_group_members
ALTER TABLE rt_group_members
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES retena_tenants(id) ON DELETE SET NULL;

-- ── Backfill existing data as tenant #1 ──────────────────────────────────────
-- Run AFTER creating the first tenant via API and getting its UUID:
--
--   UPDATE rewa_messages     SET tenant_id = '<YOUR_TENANT_UUID>' WHERE tenant_id IS NULL;
--   UPDATE retena_contacts   SET tenant_id = '<YOUR_TENANT_UUID>' WHERE tenant_id IS NULL;
--   UPDATE retena_group_config SET tenant_id = '<YOUR_TENANT_UUID>' WHERE tenant_id IS NULL;
--   UPDATE rt_group_members  SET tenant_id = '<YOUR_TENANT_UUID>' WHERE tenant_id IS NULL;

-- ── RLS (enable after verifying backfill) ────────────────────────────────────
-- ALTER TABLE rewa_messages ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "tenant isolation" ON rewa_messages
--     USING (tenant_id = current_setting('app.tenant_id')::uuid);
