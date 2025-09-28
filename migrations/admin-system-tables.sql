-- Migration: Admin System Tables and Columns
-- Date: 2025-09-28
-- Description: Adds missing tables and columns for admin system functionality

-- Add missing columns to users table
ALTER TABLE users
ADD COLUMN IF NOT EXISTS bot_blocked BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS chat_invalid BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS is_merchant BOOLEAN DEFAULT FALSE;

-- Create admin_audit_log table for tracking admin actions
CREATE TABLE IF NOT EXISTS admin_audit_log (
    id SERIAL PRIMARY KEY,
    admin_id BIGINT NOT NULL,
    admin_username VARCHAR(255),
    action_type VARCHAR(100) NOT NULL,
    target_user_id BIGINT,
    target_username VARCHAR(255),
    details JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ip_address INET,
    user_agent TEXT
);

-- Create indexes for admin_audit_log
CREATE INDEX IF NOT EXISTS idx_audit_admin_id ON admin_audit_log(admin_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON admin_audit_log(action_type);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON admin_audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_target_user ON admin_audit_log(target_user_id);

-- Create broadcast_history table for tracking broadcast messages
CREATE TABLE IF NOT EXISTS broadcast_history (
    id SERIAL PRIMARY KEY,
    message_preview VARCHAR(255),
    total_count INTEGER DEFAULT 0,
    sent_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    blocked_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by BIGINT,
    status VARCHAR(50) DEFAULT 'pending',
    filter_type VARCHAR(50),
    filter_value JSONB
);

-- Create index for broadcast_history
CREATE INDEX IF NOT EXISTS idx_broadcast_created_at ON broadcast_history(created_at DESC);

-- Add column for action_description if needed (for compatibility)
ALTER TABLE admin_audit_log
ADD COLUMN IF NOT EXISTS action_description TEXT;