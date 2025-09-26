-- ============================================
-- Atlas Bridge Reputation System Fix Migration - PRODUCTION READY
-- Date: 2025-01-26
-- Description: Fixes reputation system tracking and upgrade logic
--
-- This migration will:
-- 1. Fix database triggers to update user stats on confirmed transactions
-- 2. Recalculate all user statistics from transaction history
-- 3. Apply appropriate reputation level upgrades based on actual data
-- ============================================
--
-- TO EXECUTE:
-- psql -d your_database -1 -f 2025-01-26-reputation-fix-FINAL.sql
--
-- The -1 flag ensures it runs in a single transaction (auto rollback on error)
-- ============================================

BEGIN;

-- ============================================
-- 0. PRE-MIGRATION VALIDATION
-- ============================================

DO $$
DECLARE
    v_table_exists BOOLEAN;
    v_column_exists BOOLEAN;
    v_user_count INTEGER;
    v_tx_count INTEGER;
BEGIN
    -- Check if required tables exist
    SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'pix_transactions'
    ) INTO v_table_exists;

    IF NOT v_table_exists THEN
        RAISE EXCEPTION 'Table pix_transactions does not exist. Cannot proceed with migration.';
    END IF;

    -- Check if users table has required columns
    SELECT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_schema = 'public'
        AND table_name = 'users'
        AND column_name = 'completed_transactions'
    ) INTO v_column_exists;

    IF NOT v_column_exists THEN
        RAISE EXCEPTION 'Column completed_transactions does not exist in users table.';
    END IF;

    -- Get current counts for logging
    SELECT COUNT(*) INTO v_user_count FROM users;
    SELECT COUNT(*) INTO v_tx_count FROM pix_transactions WHERE payment_status = 'CONFIRMED';

    RAISE NOTICE '=== Pre-migration Status ===';
    RAISE NOTICE 'Total users: %', v_user_count;
    RAISE NOTICE 'Confirmed transactions: %', v_tx_count;
    RAISE NOTICE 'Pre-migration validation passed ✓';
END;
$$;

-- ============================================
-- 1. Add missing column if needed
-- ============================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_schema = 'public'
        AND table_name = 'users'
        AND column_name = 'total_transactions'
    ) THEN
        ALTER TABLE users ADD COLUMN total_transactions INTEGER DEFAULT 0;
        RAISE NOTICE 'Added column total_transactions to users table';
    END IF;
END;
$$;

-- ============================================
-- 2. Fix process_transaction_status trigger function
-- ============================================

CREATE OR REPLACE FUNCTION process_transaction_status()
RETURNS TRIGGER AS $$
DECLARE
    v_user_record RECORD;
    v_transaction_amount DECIMAL(15,2);
BEGIN
    -- Only process when status changes to CONFIRMED
    IF NEW.payment_status = 'CONFIRMED' AND (OLD.payment_status IS NULL OR OLD.payment_status != 'CONFIRMED') THEN

        -- Get user data and transaction amount
        SELECT u.telegram_user_id, u.completed_transactions, u.total_volume_brl
        INTO v_user_record
        FROM users u
        WHERE u.telegram_user_id = NEW.user_id;

        IF FOUND THEN
            v_transaction_amount := COALESCE(NEW.requested_brl_amount, 0);

            -- Update user statistics
            UPDATE users
            SET completed_transactions = COALESCE(completed_transactions, 0) + 1,
                total_transactions = COALESCE(total_transactions, 0) + 1,
                total_volume_brl = COALESCE(total_volume_brl, 0) + v_transaction_amount,
                daily_used_brl = COALESCE(daily_used_brl, 0) + v_transaction_amount
            WHERE telegram_user_id = v_user_record.telegram_user_id;

            -- Log to daily limits
            INSERT INTO daily_limits_log (telegram_user_id, date, total_used_brl, transaction_count)
            VALUES (v_user_record.telegram_user_id, CURRENT_DATE, v_transaction_amount, 1)
            ON CONFLICT (telegram_user_id, date)
            DO UPDATE SET
                total_used_brl = daily_limits_log.total_used_brl + v_transaction_amount,
                transaction_count = daily_limits_log.transaction_count + 1;

            RAISE NOTICE 'Updated stats for user %: tx=%, vol=R$%',
                v_user_record.telegram_user_id,
                COALESCE(v_user_record.completed_transactions, 0) + 1,
                COALESCE(v_user_record.total_volume_brl, 0) + v_transaction_amount;
        ELSE
            RAISE WARNING 'User not found for transaction %', NEW.transaction_id;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Recreate the trigger
DROP TRIGGER IF EXISTS trg_process_transaction_status ON pix_transactions;
CREATE TRIGGER trg_process_transaction_status
    AFTER INSERT OR UPDATE ON pix_transactions
    FOR EACH ROW
    EXECUTE FUNCTION process_transaction_status();

DO $$ BEGIN RAISE NOTICE 'Trigger process_transaction_status recreated ✓'; END; $$;

-- ============================================
-- 3. Fix check_reputation_upgrade function
-- ============================================

CREATE OR REPLACE FUNCTION check_reputation_upgrade(p_telegram_user_id BIGINT)
RETURNS TABLE (
    upgraded BOOLEAN,
    new_level INTEGER,
    new_limit DECIMAL(10,2),
    message TEXT
) AS $$
DECLARE
    v_user_record RECORD;
    v_next_level_config RECORD;
    v_current_level_config RECORD;
    v_user_transactions INTEGER;
    v_user_volume DECIMAL(15,2);
BEGIN
    -- Get user current data
    SELECT u.reputation_level, u.daily_limit_brl, u.telegram_user_id,
           COALESCE(u.completed_transactions, 0) as completed_transactions,
           COALESCE(u.total_volume_brl, 0) as total_volume_brl
    INTO v_user_record
    FROM users u
    WHERE u.telegram_user_id = p_telegram_user_id;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 0, 0.00::DECIMAL(10,2), 'Usuário não encontrado'::TEXT;
        RETURN;
    END IF;

    v_user_transactions := v_user_record.completed_transactions;
    v_user_volume := v_user_record.total_volume_brl;

    -- Get current level config
    SELECT *
    INTO v_current_level_config
    FROM reputation_levels_config
    WHERE level = v_user_record.reputation_level;

    -- Get next level config
    SELECT *
    INTO v_next_level_config
    FROM reputation_levels_config
    WHERE level = v_user_record.reputation_level + 1;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, v_user_record.reputation_level, v_user_record.daily_limit_brl,
            'Nível máximo atingido'::TEXT;
        RETURN;
    END IF;

    -- Check if user qualifies for upgrade
    IF v_user_transactions >= v_next_level_config.min_transactions_for_upgrade
       AND v_user_volume >= v_next_level_config.min_volume_for_upgrade THEN

        -- Upgrade user
        UPDATE users
        SET reputation_level = v_next_level_config.level,
            daily_limit_brl = v_next_level_config.daily_limit_brl,
            last_level_upgrade = NOW()
        WHERE telegram_user_id = p_telegram_user_id;

        -- Log the upgrade
        INSERT INTO reputation_level_history
        (telegram_user_id, old_level, new_level, old_limit, new_limit, reason)
        VALUES (
            v_user_record.telegram_user_id,
            v_user_record.reputation_level,
            v_next_level_config.level,
            v_user_record.daily_limit_brl,
            v_next_level_config.daily_limit_brl,
            format('Upgrade: %s tx, R$%.2f vol', v_user_transactions, v_user_volume)
        );

        RETURN QUERY SELECT
            TRUE,
            v_next_level_config.level,
            v_next_level_config.daily_limit_brl,
            format('Parabéns! Nível %s (%s) - Limite: R$%s',
                   v_next_level_config.level,
                   v_next_level_config.description,
                   v_next_level_config.daily_limit_brl)::TEXT;
    ELSE
        -- Calculate what's missing
        DECLARE
            v_missing_transactions INTEGER;
            v_missing_volume DECIMAL(15,2);
            v_message TEXT;
        BEGIN
            v_missing_transactions := GREATEST(0, v_next_level_config.min_transactions_for_upgrade - v_user_transactions);
            v_missing_volume := GREATEST(0, v_next_level_config.min_volume_for_upgrade - v_user_volume);

            v_message := format('Para nível %s (%s): ',
                               v_next_level_config.level,
                               v_next_level_config.description);

            IF v_missing_transactions > 0 AND v_missing_volume > 0 THEN
                v_message := v_message || format('Faltam %s transações e R$%.2f em volume',
                                                v_missing_transactions, v_missing_volume);
            ELSIF v_missing_transactions > 0 THEN
                v_message := v_message || format('Faltam %s transações', v_missing_transactions);
            ELSIF v_missing_volume > 0 THEN
                v_message := v_message || format('Falta R$%.2f em volume', v_missing_volume);
            END IF;

            RETURN QUERY SELECT
                FALSE,
                v_user_record.reputation_level,
                v_user_record.daily_limit_brl,
                v_message::TEXT;
        END;
    END IF;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN RAISE NOTICE 'Function check_reputation_upgrade updated ✓'; END; $$;

-- ============================================
-- 4. Backup current data
-- ============================================

CREATE TEMP TABLE migration_backup AS
SELECT
    telegram_user_id,
    reputation_level,
    completed_transactions,
    total_volume_brl,
    daily_limit_brl
FROM users;

DO $$ BEGIN RAISE NOTICE 'Backup created ✓'; END; $$;

-- ============================================
-- 5. Recalculate all user statistics
-- ============================================

-- Reset statistics
UPDATE users
SET completed_transactions = 0,
    total_transactions = 0,
    total_volume_brl = 0,
    daily_used_brl = 0;

DO $$ BEGIN RAISE NOTICE 'Statistics reset ✓'; END; $$;

-- Recalculate from confirmed transactions
WITH transaction_stats AS (
    SELECT
        user_id,
        COUNT(*) as transaction_count,
        COALESCE(SUM(requested_brl_amount), 0) as total_volume
    FROM pix_transactions
    WHERE payment_status = 'CONFIRMED'
    AND user_id IS NOT NULL
    GROUP BY user_id
)
UPDATE users u
SET completed_transactions = ts.transaction_count,
    total_transactions = ts.transaction_count,
    total_volume_brl = ts.total_volume
FROM transaction_stats ts
WHERE u.telegram_user_id = ts.user_id;

-- Log results
DO $$
DECLARE
    v_updated INTEGER;
    v_total INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_updated FROM users WHERE completed_transactions > 0;
    SELECT COUNT(*) INTO v_total FROM users;
    RAISE NOTICE 'Statistics recalculated: % users with transactions out of % total ✓',
                 v_updated, v_total;
END;
$$;

-- ============================================
-- 6. Apply reputation upgrades
-- ============================================

DO $$
DECLARE
    v_user RECORD;
    v_upgrade_result RECORD;
    v_upgraded_count INTEGER := 0;
    v_checked_count INTEGER := 0;
BEGIN
    -- Check each user for upgrades
    FOR v_user IN
        SELECT telegram_user_id, completed_transactions, total_volume_brl, reputation_level
        FROM users
        WHERE telegram_user_id IS NOT NULL
        ORDER BY completed_transactions DESC, total_volume_brl DESC
    LOOP
        v_checked_count := v_checked_count + 1;

        -- Keep upgrading until no more upgrades possible
        LOOP
            SELECT * INTO v_upgrade_result
            FROM check_reputation_upgrade(v_user.telegram_user_id);

            IF v_upgrade_result.upgraded THEN
                v_upgraded_count := v_upgraded_count + 1;
                RAISE NOTICE 'User % upgraded to level %',
                             v_user.telegram_user_id, v_upgrade_result.new_level;

                -- Get updated level for next iteration
                SELECT reputation_level INTO v_user.reputation_level
                FROM users WHERE telegram_user_id = v_user.telegram_user_id;
            ELSE
                EXIT;
            END IF;
        END LOOP;
    END LOOP;

    RAISE NOTICE 'Reputation upgrades: % users upgraded out of % checked ✓',
                 v_upgraded_count, v_checked_count;
END;
$$;

-- ============================================
-- 7. Update user-specific requirements
-- ============================================

UPDATE users u
SET min_transactions_for_upgrade = rlc.min_transactions_for_upgrade,
    min_volume_for_upgrade = rlc.min_volume_for_upgrade
FROM reputation_levels_config rlc
WHERE rlc.level = u.reputation_level + 1;

DO $$ BEGIN RAISE NOTICE 'User requirements updated ✓'; END; $$;

-- ============================================
-- 8. Rebuild daily limits log
-- ============================================

TRUNCATE TABLE daily_limits_log;

INSERT INTO daily_limits_log (telegram_user_id, date, total_used_brl, transaction_count)
SELECT
    user_id as telegram_user_id,
    DATE(created_at AT TIME ZONE 'America/Sao_Paulo') as transaction_date,
    SUM(requested_brl_amount) as total_used,
    COUNT(*) as transaction_count
FROM pix_transactions
WHERE payment_status = 'CONFIRMED'
AND user_id IS NOT NULL
GROUP BY user_id, DATE(created_at AT TIME ZONE 'America/Sao_Paulo')
ON CONFLICT (telegram_user_id, date) DO NOTHING;

DO $$ BEGIN RAISE NOTICE 'Daily limits log rebuilt ✓'; END; $$;

-- ============================================
-- 9. Final verification
-- ============================================

DO $$
DECLARE
    v_stats RECORD;
    v_errors INTEGER := 0;
    v_total_tx INTEGER;
    v_total_vol DECIMAL(15,2);
    v_user_tx INTEGER;
    v_user_vol DECIMAL(15,2);
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '========================================';
    RAISE NOTICE '=== MIGRATION RESULTS ===';
    RAISE NOTICE '========================================';

    -- Overall stats
    SELECT
        COUNT(*) as total_users,
        COUNT(CASE WHEN completed_transactions > 0 THEN 1 END) as active_users,
        COALESCE(SUM(completed_transactions), 0) as total_transactions,
        COALESCE(SUM(total_volume_brl), 0) as total_volume
    INTO v_stats
    FROM users;

    RAISE NOTICE 'Total Users: %', v_stats.total_users;
    RAISE NOTICE 'Active Users: %', v_stats.active_users;
    RAISE NOTICE 'Total Transactions: %', v_stats.total_transactions;
    RAISE NOTICE 'Total Volume: R$%', v_stats.total_volume;

    -- Distribution by level
    RAISE NOTICE '';
    RAISE NOTICE 'Users by Reputation Level:';
    FOR v_stats IN
        SELECT
            rlc.level,
            rlc.description,
            COUNT(u.telegram_user_id) as user_count,
            COALESCE(AVG(u.completed_transactions), 0)::INTEGER as avg_tx,
            COALESCE(AVG(u.total_volume_brl), 0)::DECIMAL(10,2) as avg_vol
        FROM reputation_levels_config rlc
        LEFT JOIN users u ON u.reputation_level = rlc.level
        GROUP BY rlc.level, rlc.description
        ORDER BY rlc.level
    LOOP
        IF v_stats.user_count > 0 THEN
            RAISE NOTICE 'Level % (%) - % users, Avg: % tx, R$%',
                v_stats.level, v_stats.description, v_stats.user_count,
                v_stats.avg_tx, v_stats.avg_vol;
        END IF;
    END LOOP;

    -- Verify integrity
    SELECT COUNT(*), COALESCE(SUM(requested_brl_amount), 0)
    INTO v_total_tx, v_total_vol
    FROM pix_transactions
    WHERE payment_status = 'CONFIRMED';

    SELECT COALESCE(SUM(completed_transactions), 0), COALESCE(SUM(total_volume_brl), 0)
    INTO v_user_tx, v_user_vol
    FROM users;

    RAISE NOTICE '';
    IF v_total_tx = v_user_tx AND ABS(v_total_vol - v_user_vol) < 0.01 THEN
        RAISE NOTICE '✓ Data integrity verified';
    ELSE
        RAISE WARNING 'Data mismatch: DB has % tx, R$%, users have % tx, R$%',
                      v_total_tx, v_total_vol, v_user_tx, v_user_vol;
        v_errors := v_errors + 1;
    END IF;

    IF v_errors = 0 THEN
        RAISE NOTICE '========================================';
        RAISE NOTICE 'MIGRATION SUCCESSFUL! ✓';
        RAISE NOTICE '========================================';
    ELSE
        RAISE EXCEPTION 'Migration completed with % errors', v_errors;
    END IF;
END;
$$;

COMMIT;

-- Post-migration message
DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '✅ Migration complete!';
    RAISE NOTICE 'Next steps:';
    RAISE NOTICE '1. Test a transaction to verify triggers work';
    RAISE NOTICE '2. Check user reputation displays in bot';
    RAISE NOTICE '3. Monitor logs for errors';
END;
$$;