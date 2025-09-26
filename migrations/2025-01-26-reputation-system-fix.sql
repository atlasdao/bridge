-- Atlas Bridge Reputation System Fix Migration
-- Date: 2025-01-26
-- Description: Fixes reputation system tracking and upgrade logic
--
-- IMPORTANT: This migration should be run in a transaction
-- Run with: psql -d your_database -f 2025-01-26-reputation-system-fix.sql
--
-- Or manually:
-- BEGIN;
-- [paste content here]
-- COMMIT;

BEGIN;

-- ============================================
-- 1. Fix process_transaction_status trigger function
-- ============================================

CREATE OR REPLACE FUNCTION process_transaction_status()
RETURNS TRIGGER AS $$
DECLARE
    v_user_record RECORD;
    v_transaction_amount DECIMAL(10,2);
BEGIN
    -- Only process when status changes to CONFIRMED (production status)
    IF NEW.payment_status = 'CONFIRMED' AND (OLD.payment_status IS NULL OR OLD.payment_status != 'CONFIRMED') THEN

        -- Get user and transaction amount
        SELECT u.id, u.telegram_user_id, u.total_transactions, u.total_volume_brl,
               pt.requested_brl_amount
        INTO v_user_record
        FROM users u
        JOIN pix_transactions pt ON pt.user_id = u.id
        WHERE pt.id = NEW.id;

        IF FOUND AND v_user_record.telegram_user_id IS NOT NULL THEN
            v_transaction_amount := COALESCE(v_user_record.requested_brl_amount, 0);

            -- Update user statistics
            UPDATE users
            SET total_transactions = COALESCE(total_transactions, 0) + 1,
                total_volume_brl = COALESCE(total_volume_brl, 0) + v_transaction_amount,
                daily_used_brl = COALESCE(daily_used_brl, 0) + v_transaction_amount
            WHERE id = v_user_record.id;

            -- Log to daily limits
            INSERT INTO daily_limits_log (telegram_user_id, date, total_used_brl, transaction_count)
            VALUES (v_user_record.telegram_user_id, CURRENT_DATE, v_transaction_amount, 1)
            ON CONFLICT (telegram_user_id, date)
            DO UPDATE SET
                total_used_brl = daily_limits_log.total_used_brl + v_transaction_amount,
                transaction_count = daily_limits_log.transaction_count + 1;

            RAISE NOTICE 'Updated statistics for user %: transactions=%, volume=%',
                v_user_record.id,
                COALESCE(v_user_record.total_transactions, 0) + 1,
                COALESCE(v_user_record.total_volume_brl, 0) + v_transaction_amount;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Recreate the trigger to ensure it's properly attached
DROP TRIGGER IF EXISTS trg_process_transaction_status ON pix_transactions;
CREATE TRIGGER trg_process_transaction_status
    AFTER INSERT OR UPDATE ON pix_transactions
    FOR EACH ROW
    EXECUTE FUNCTION process_transaction_status();

-- ============================================
-- 2. Fix check_reputation_upgrade function
-- ============================================

CREATE OR REPLACE FUNCTION check_reputation_upgrade(p_user_id INTEGER)
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
BEGIN
    -- Get user current data including transaction stats
    SELECT u.reputation_level, u.daily_limit_brl, u.telegram_user_id,
           COALESCE(u.total_transactions, 0) as total_transactions,
           COALESCE(u.total_volume_brl, 0) as total_volume_brl
    INTO v_user_record
    FROM users u
    WHERE u.id = p_user_id;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 0, 0.00::DECIMAL(10,2), 'Usuário não encontrado'::TEXT;
        RETURN;
    END IF;

    -- Get current level requirements
    SELECT *
    INTO v_current_level_config
    FROM reputation_levels_config
    WHERE level = v_user_record.reputation_level;

    -- Get next level requirements
    SELECT *
    INTO v_next_level_config
    FROM reputation_levels_config
    WHERE level = v_user_record.reputation_level + 1;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, v_user_record.reputation_level, v_user_record.daily_limit_brl,
            'Nível máximo atingido'::TEXT;
        RETURN;
    END IF;

    -- Check if user qualifies for upgrade based on BOTH transactions AND volume
    IF v_user_record.total_transactions >= v_next_level_config.min_transactions_for_upgrade
       AND v_user_record.total_volume_brl >= v_next_level_config.min_volume_for_upgrade THEN

        -- Upgrade user
        UPDATE users
        SET reputation_level = v_next_level_config.level,
            daily_limit_brl = v_next_level_config.daily_limit_brl
        WHERE id = p_user_id;

        -- Log the upgrade
        INSERT INTO reputation_level_history
        (telegram_user_id, old_level, new_level, old_limit, new_limit, reason)
        VALUES (
            v_user_record.telegram_user_id,
            v_user_record.reputation_level,
            v_next_level_config.level,
            v_user_record.daily_limit_brl,
            v_next_level_config.daily_limit_brl,
            'Upgrade automático por transações e volume'
        );

        RETURN QUERY SELECT
            TRUE,
            v_next_level_config.level,
            v_next_level_config.daily_limit_brl,
            format('Parabéns! Você subiu para o nível %s com limite diário de R$ %s',
                   v_next_level_config.level, v_next_level_config.daily_limit_brl)::TEXT;
    ELSE
        -- Calculate what's missing for upgrade
        DECLARE
            v_missing_transactions INTEGER;
            v_missing_volume DECIMAL(10,2);
            v_message TEXT;
        BEGIN
            v_missing_transactions := GREATEST(0, v_next_level_config.min_transactions_for_upgrade - v_user_record.total_transactions);
            v_missing_volume := GREATEST(0, v_next_level_config.min_volume_for_upgrade - v_user_record.total_volume_brl);

            -- Build informative message
            v_message := format('Progresso para nível %s: ', v_next_level_config.level);

            IF v_missing_transactions > 0 THEN
                v_message := v_message || format('Faltam %s transações', v_missing_transactions);
            END IF;

            IF v_missing_volume > 0 THEN
                IF v_missing_transactions > 0 THEN
                    v_message := v_message || ' e ';
                END IF;
                v_message := v_message || format('R$ %.2f em volume', v_missing_volume);
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

-- ============================================
-- 3. Recalculate all user statistics from transaction history
-- ============================================

-- Reset all user statistics
UPDATE users
SET total_transactions = 0,
    total_volume_brl = 0,
    daily_used_brl = 0;

-- Recalculate from confirmed transactions
UPDATE users u
SET total_transactions = stats.transaction_count,
    total_volume_brl = stats.total_volume
FROM (
    SELECT
        pt.user_id,
        COUNT(*) as transaction_count,
        COALESCE(SUM(pt.requested_brl_amount), 0) as total_volume
    FROM pix_transactions pt
    WHERE pt.payment_status = 'CONFIRMED'
    GROUP BY pt.user_id
) stats
WHERE u.id = stats.user_id;

-- ============================================
-- 4. Check and apply reputation upgrades for all users
-- ============================================

DO $$
DECLARE
    v_user RECORD;
    v_upgrade_result RECORD;
    v_upgraded_count INTEGER := 0;
BEGIN
    -- Check each user for possible upgrades
    FOR v_user IN SELECT id FROM users WHERE telegram_user_id IS NOT NULL
    LOOP
        SELECT * INTO v_upgrade_result
        FROM check_reputation_upgrade(v_user.id);

        IF v_upgrade_result.upgraded THEN
            v_upgraded_count := v_upgraded_count + 1;
            RAISE NOTICE 'User % upgraded to level %', v_user.id, v_upgrade_result.new_level;
        END IF;
    END LOOP;

    RAISE NOTICE 'Total users upgraded: %', v_upgraded_count;
END;
$$;

-- ============================================
-- 5. Verify the migration
-- ============================================

-- Show statistics summary
DO $$
DECLARE
    v_stats RECORD;
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '=== Migration Statistics ===';

    FOR v_stats IN
        SELECT
            rlc.level,
            COUNT(u.id) as user_count,
            COALESCE(AVG(u.total_transactions), 0)::INTEGER as avg_transactions,
            COALESCE(AVG(u.total_volume_brl), 0)::DECIMAL(10,2) as avg_volume
        FROM reputation_levels_config rlc
        LEFT JOIN users u ON u.reputation_level = rlc.level
        GROUP BY rlc.level
        HAVING COUNT(u.id) > 0
        ORDER BY rlc.level
    LOOP
        RAISE NOTICE 'Level %: % users, Avg % transactions, Avg R$ % volume',
            v_stats.level, v_stats.user_count, v_stats.avg_transactions, v_stats.avg_volume;
    END LOOP;

    RAISE NOTICE '';
    RAISE NOTICE 'Migration completed successfully!';
END;
$$;

COMMIT;