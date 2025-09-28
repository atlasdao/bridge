-- =====================================================
-- Atlas Bridge Admin System Complete Migration
-- Version: 1.0.0
-- Date: 2025-01-26
-- Description: Complete admin system with audit, permissions, and enhanced features
-- =====================================================

-- Start transaction
BEGIN;

-- =====================================================
-- 1. Add missing columns to users table
-- =====================================================

-- Check and add bot_blocked columns
ALTER TABLE users
ADD COLUMN IF NOT EXISTS bot_blocked BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS bot_blocked_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS chat_invalid BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS chat_invalid_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- Add indexes for better performance
CREATE INDEX IF NOT EXISTS idx_users_bot_blocked ON users(bot_blocked);
CREATE INDEX IF NOT EXISTS idx_users_chat_invalid ON users(chat_invalid);
CREATE INDEX IF NOT EXISTS idx_users_last_activity ON users(last_activity);
CREATE INDEX IF NOT EXISTS idx_users_reputation ON users(reputation_level);
CREATE INDEX IF NOT EXISTS idx_users_volume ON users(total_volume_brl);

-- =====================================================
-- 2. Admin Audit Log Table
-- =====================================================

CREATE TABLE IF NOT EXISTS admin_audit_log (
    id SERIAL PRIMARY KEY,
    admin_id BIGINT NOT NULL,
    admin_username VARCHAR(255),
    action_type VARCHAR(50) NOT NULL,
    action_description TEXT NOT NULL,
    target_user_id BIGINT,
    target_username VARCHAR(255),
    metadata JSONB,
    ip_address VARCHAR(45),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for admin_audit_log
CREATE INDEX IF NOT EXISTS idx_audit_admin_id ON admin_audit_log(admin_id);
CREATE INDEX IF NOT EXISTS idx_audit_action_type ON admin_audit_log(action_type);
CREATE INDEX IF NOT EXISTS idx_audit_target_user ON admin_audit_log(target_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON admin_audit_log(created_at);

-- =====================================================
-- 3. Admin Roles and Permissions
-- =====================================================

-- Admin roles table
CREATE TABLE IF NOT EXISTS admin_roles (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,
    description TEXT,
    permissions JSONB NOT NULL DEFAULT '{}',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Admin users table
CREATE TABLE IF NOT EXISTS admin_users (
    telegram_user_id BIGINT PRIMARY KEY,
    telegram_username VARCHAR(255),
    full_name VARCHAR(255),
    role_id INTEGER REFERENCES admin_roles(id),
    is_active BOOLEAN DEFAULT TRUE,
    two_fa_enabled BOOLEAN DEFAULT FALSE,
    two_fa_secret VARCHAR(255),
    last_login TIMESTAMP,
    login_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default roles
INSERT INTO admin_roles (name, description, permissions)
VALUES
    ('super_admin', 'Super Administrator with all permissions',
     '{"broadcasts": true, "user_management": true, "system_management": true, "view_audit": true, "manage_admins": true, "backups": true, "maintenance": true}'),
    ('moderator', 'Moderator with user management permissions',
     '{"broadcasts": false, "user_management": true, "system_management": false, "view_audit": true, "manage_admins": false, "backups": false, "maintenance": false}'),
    ('support', 'Support staff with read-only access',
     '{"broadcasts": false, "user_management": false, "system_management": false, "view_audit": true, "manage_admins": false, "backups": false, "maintenance": false}')
ON CONFLICT (name) DO NOTHING;

-- =====================================================
-- 4. Broadcast History Table
-- =====================================================

CREATE TABLE IF NOT EXISTS broadcast_history (
    id SERIAL PRIMARY KEY,
    admin_id BIGINT NOT NULL,
    admin_username VARCHAR(255),
    message TEXT NOT NULL,
    message_type VARCHAR(50) DEFAULT 'text',
    filters JSONB,
    stats JSONB,
    scheduled_at TIMESTAMP,
    sent_at TIMESTAMP,
    status VARCHAR(20) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for broadcast_history
CREATE INDEX IF NOT EXISTS idx_broadcast_admin_id ON broadcast_history(admin_id);
CREATE INDEX IF NOT EXISTS idx_broadcast_status ON broadcast_history(status);
CREATE INDEX IF NOT EXISTS idx_broadcast_created_at ON broadcast_history(created_at);

-- =====================================================
-- 5. System Configuration Table
-- =====================================================

CREATE TABLE IF NOT EXISTS system_config (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT,
    category VARCHAR(50),
    is_sensitive BOOLEAN DEFAULT FALSE,
    updated_by BIGINT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default configurations
INSERT INTO system_config (key, value, description, category, is_sensitive)
VALUES
    ('maintenance_mode', 'false', 'Sistema em manutenção', 'system', false),
    ('maintenance_message', 'Sistema em manutenção. Voltaremos em breve.', 'Mensagem de manutenção', 'system', false),
    ('broadcast_batch_size', '30', 'Tamanho do lote para broadcasts', 'broadcast', false),
    ('broadcast_delay_ms', '1000', 'Delay entre lotes em milliseconds', 'broadcast', false),
    ('max_daily_broadcasts', '10', 'Máximo de broadcasts por dia', 'broadcast', false),
    ('user_verification_required', 'false', 'Requer verificação para usar o bot', 'user', false),
    ('min_reputation_to_use', '0', 'Reputação mínima para usar o bot', 'user', false),
    ('rate_limit_requests', '60', 'Limite de requisições por minuto', 'security', false),
    ('enable_2fa_for_admins', 'false', 'Habilitar 2FA para admins', 'security', false),
    ('backup_retention_days', '30', 'Dias para manter backups', 'backup', false)
ON CONFLICT (key) DO NOTHING;

-- =====================================================
-- 6. Rate Limiting Table
-- =====================================================

CREATE TABLE IF NOT EXISTS rate_limits (
    id SERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    action_type VARCHAR(50) NOT NULL,
    count INTEGER DEFAULT 1,
    window_start TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    blocked_until TIMESTAMP,

    -- Unique constraint for user + action
    UNIQUE(user_id, action_type)
);

-- Create indexes for rate_limits
CREATE INDEX IF NOT EXISTS idx_rate_limit_user ON rate_limits(user_id);
CREATE INDEX IF NOT EXISTS idx_rate_limit_action ON rate_limits(action_type);
CREATE INDEX IF NOT EXISTS idx_rate_limit_window ON rate_limits(window_start);

-- =====================================================
-- 7. Admin Sessions Table (for 2FA and security)
-- =====================================================

CREATE TABLE IF NOT EXISTS admin_sessions (
    id SERIAL PRIMARY KEY,
    admin_id BIGINT NOT NULL,
    session_token VARCHAR(255) UNIQUE NOT NULL,
    ip_address VARCHAR(45),
    user_agent TEXT,
    two_fa_verified BOOLEAN DEFAULT FALSE,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for admin_sessions
CREATE INDEX IF NOT EXISTS idx_session_admin ON admin_sessions(admin_id);
CREATE INDEX IF NOT EXISTS idx_session_token ON admin_sessions(session_token);
CREATE INDEX IF NOT EXISTS idx_session_expires ON admin_sessions(expires_at);

-- =====================================================
-- 8. System Metrics Table
-- =====================================================

CREATE TABLE IF NOT EXISTS system_metrics (
    id SERIAL PRIMARY KEY,
    metric_type VARCHAR(50) NOT NULL,
    metric_name VARCHAR(100) NOT NULL,
    value NUMERIC,
    metadata JSONB,
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for system_metrics
CREATE INDEX IF NOT EXISTS idx_metrics_type ON system_metrics(metric_type);
CREATE INDEX IF NOT EXISTS idx_metrics_name ON system_metrics(metric_name);
CREATE INDEX IF NOT EXISTS idx_metrics_recorded ON system_metrics(recorded_at);

-- =====================================================
-- 9. Scheduled Tasks Table
-- =====================================================

CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id SERIAL PRIMARY KEY,
    task_type VARCHAR(50) NOT NULL,
    task_data JSONB NOT NULL,
    scheduled_for TIMESTAMP NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    executed_at TIMESTAMP,
    result JSONB,
    created_by BIGINT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for scheduled_tasks
CREATE INDEX IF NOT EXISTS idx_tasks_type ON scheduled_tasks(task_type);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON scheduled_tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_scheduled ON scheduled_tasks(scheduled_for);

-- =====================================================
-- 10. Add missing columns to ban_history if not exists
-- =====================================================

-- Check if ban_history table exists, if not create it
CREATE TABLE IF NOT EXISTS ban_history (
    id SERIAL PRIMARY KEY,
    telegram_user_id BIGINT NOT NULL REFERENCES users(telegram_user_id),
    action VARCHAR(20) NOT NULL, -- 'ban' or 'unban'
    reason TEXT,
    admin_id BIGINT,
    admin_username VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for ban_history
CREATE INDEX IF NOT EXISTS idx_ban_history_user ON ban_history(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_ban_history_admin ON ban_history(admin_id);
CREATE INDEX IF NOT EXISTS idx_ban_history_created ON ban_history(created_at);

-- =====================================================
-- 11. Add missing columns to reputation_level_history
-- =====================================================

-- Check if table exists, if not create it
CREATE TABLE IF NOT EXISTS reputation_level_history (
    id SERIAL PRIMARY KEY,
    telegram_user_id BIGINT NOT NULL REFERENCES users(telegram_user_id),
    old_level INTEGER,
    new_level INTEGER,
    reason TEXT,
    admin_id BIGINT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for reputation_level_history
CREATE INDEX IF NOT EXISTS idx_rep_history_user ON reputation_level_history(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_rep_history_created ON reputation_level_history(created_at);

-- =====================================================
-- 12. Create Views for Admin Dashboard
-- =====================================================

-- User statistics view
CREATE OR REPLACE VIEW admin_user_stats AS
SELECT
    COUNT(*) as total_users,
    COUNT(CASE WHEN is_verified = true THEN 1 END) as verified_users,
    COUNT(CASE WHEN is_banned = true THEN 1 END) as banned_users,
    COUNT(CASE WHEN is_merchant = true THEN 1 END) as merchants,
    COUNT(CASE WHEN liquid_address IS NOT NULL THEN 1 END) as with_wallet,
    COUNT(CASE WHEN bot_blocked = true THEN 1 END) as bot_blocked,
    COUNT(CASE WHEN created_at > NOW() - INTERVAL '24 hours' THEN 1 END) as new_today,
    COUNT(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN 1 END) as new_week,
    COUNT(CASE WHEN created_at > NOW() - INTERVAL '30 days' THEN 1 END) as new_month,
    COALESCE(SUM(total_volume_brl), 0) as total_volume,
    COALESCE(AVG(reputation_level), 0) as avg_reputation
FROM users;

-- Transaction statistics view
CREATE OR REPLACE VIEW admin_transaction_stats AS
SELECT
    COUNT(*) as total_transactions,
    COUNT(CASE WHEN status = 'CONFIRMED' THEN 1 END) as confirmed,
    COUNT(CASE WHEN status = 'PENDING' THEN 1 END) as pending,
    COUNT(CASE WHEN status = 'EXPIRED' THEN 1 END) as expired,
    COUNT(CASE WHEN created_at > NOW() - INTERVAL '24 hours' THEN 1 END) as today,
    COUNT(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN 1 END) as this_week,
    COUNT(CASE WHEN created_at > NOW() - INTERVAL '30 days' THEN 1 END) as this_month,
    COALESCE(SUM(amount), 0) as total_volume,
    COALESCE(AVG(amount), 0) as avg_amount,
    COALESCE(MAX(amount), 0) as max_amount,
    COALESCE(MIN(CASE WHEN amount > 0 THEN amount END), 0) as min_amount
FROM pix_transactions;

-- =====================================================
-- 13. Create Functions for Admin Operations
-- =====================================================

-- Function to get user activity summary
CREATE OR REPLACE FUNCTION get_user_activity_summary(user_id BIGINT, days INTEGER DEFAULT 30)
RETURNS TABLE (
    transaction_count INTEGER,
    total_volume NUMERIC,
    last_transaction TIMESTAMP,
    avg_transaction NUMERIC,
    status_distribution JSONB
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        COUNT(*)::INTEGER as transaction_count,
        COALESCE(SUM(amount), 0) as total_volume,
        MAX(created_at) as last_transaction,
        COALESCE(AVG(amount), 0) as avg_transaction,
        jsonb_object_agg(status, count) as status_distribution
    FROM (
        SELECT
            amount,
            created_at,
            status,
            COUNT(*) OVER (PARTITION BY status) as count
        FROM pix_transactions
        WHERE user_id = $1
        AND created_at > NOW() - INTERVAL '1 day' * $2
    ) t
    GROUP BY status, count;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- 14. Create Triggers for Audit and Updates
-- =====================================================

-- Trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to relevant tables
CREATE TRIGGER update_admin_users_updated_at
    BEFORE UPDATE ON admin_users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_admin_roles_updated_at
    BEFORE UPDATE ON admin_roles
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- 15. Grant Permissions (adjust as needed)
-- =====================================================

-- Grant necessary permissions to application user
-- (Adjust the username as per your setup)
-- GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO your_app_user;
-- GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO your_app_user;

-- =====================================================
-- Commit transaction
-- =====================================================

COMMIT;

-- =====================================================
-- Post-migration verification
-- =====================================================

DO $$
BEGIN
    RAISE NOTICE 'Admin system migration completed successfully';
    RAISE NOTICE 'Tables created: admin_audit_log, admin_roles, admin_users, broadcast_history, system_config, rate_limits, admin_sessions, system_metrics, scheduled_tasks';
    RAISE NOTICE 'Views created: admin_user_stats, admin_transaction_stats';
    RAISE NOTICE 'Default roles inserted: super_admin, moderator, support';
    RAISE NOTICE 'System configurations initialized';
END $$;