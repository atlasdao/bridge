-- Migration: Fix webhook processing and missing tables
-- Date: 2025-09-28
-- Description: Fixes transaction processing errors and missing database objects

-- Create transaction_processing_log table for webhook error logging
CREATE TABLE IF NOT EXISTS transaction_processing_log (
    id SERIAL PRIMARY KEY,
    transaction_id VARCHAR(255) NOT NULL,
    processing_stage VARCHAR(100),
    status VARCHAR(50),
    error_message TEXT,
    payload JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_transaction_processing_log_txid ON transaction_processing_log(transaction_id);
CREATE INDEX IF NOT EXISTS idx_transaction_processing_log_created ON transaction_processing_log(created_at);

-- Create batch_recalculate_user_stats function for scheduled jobs
CREATE OR REPLACE FUNCTION batch_recalculate_user_stats(user_ids TEXT[])
RETURNS TABLE(
    user_id BIGINT,
    old_volume NUMERIC,
    new_volume NUMERIC,
    old_transactions INTEGER,
    new_transactions INTEGER
) AS $$
BEGIN
    RETURN QUERY
    WITH recalc AS (
        SELECT
            u.telegram_user_id,
            u.total_volume_brl as old_volume,
            u.completed_transactions as old_transactions,
            COALESCE(SUM(pt.requested_brl_amount), 0) as calculated_volume,
            COALESCE(COUNT(pt.transaction_id), 0) as calculated_transactions
        FROM users u
        LEFT JOIN pix_transactions pt ON pt.user_id = u.telegram_user_id
            AND pt.payment_status IN ('PAID', 'CONFIRMED')
        WHERE u.telegram_user_id = ANY(user_ids::BIGINT[])
        GROUP BY u.telegram_user_id, u.total_volume_brl, u.completed_transactions
    )
    UPDATE users u
    SET
        total_volume_brl = recalc.calculated_volume,
        completed_transactions = recalc.calculated_transactions::INTEGER,
        updated_at = NOW()
    FROM recalc
    WHERE u.telegram_user_id = recalc.telegram_user_id
        AND (u.total_volume_brl != recalc.calculated_volume
             OR u.completed_transactions != recalc.calculated_transactions)
    RETURNING
        u.telegram_user_id,
        recalc.old_volume,
        u.total_volume_brl,
        recalc.old_transactions,
        u.completed_transactions;
END;
$$ LANGUAGE plpgsql;

-- Note: The webhook processing code was also updated to handle missing payer data in verification webhooks
-- The changes are in /opt/bridge_app/main/src/routes/webhookRoutes.js