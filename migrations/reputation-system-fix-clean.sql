-- ============================================
-- Atlas Bridge Reputation System Fix
-- PRODUCTION READY - CLEAN VERSION
-- ============================================

BEGIN;

-- 1. Drop and recreate check_reputation_upgrade function
DROP FUNCTION IF EXISTS check_reputation_upgrade(INTEGER);
DROP FUNCTION IF EXISTS check_reputation_upgrade(BIGINT);

CREATE FUNCTION check_reputation_upgrade(p_telegram_user_id BIGINT)
RETURNS TABLE (
    upgraded BOOLEAN,
    new_level INTEGER,
    new_limit DECIMAL(10,2),
    message TEXT
) AS $$
DECLARE
    v_user RECORD;
    v_next_level RECORD;
    v_missing_tx INTEGER;
    v_missing_vol DECIMAL(15,2);
BEGIN
    -- Get user data
    SELECT * INTO v_user FROM users WHERE telegram_user_id = p_telegram_user_id;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 0, 0.00::DECIMAL(10,2), 'Usuário não encontrado'::TEXT;
        RETURN;
    END IF;

    -- Get next level requirements
    SELECT * INTO v_next_level FROM reputation_levels_config
    WHERE level = v_user.reputation_level + 1;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, v_user.reputation_level, v_user.daily_limit_brl, 'Nível máximo'::TEXT;
        RETURN;
    END IF;

    -- Check upgrade eligibility
    IF COALESCE(v_user.completed_transactions, 0) >= v_next_level.min_transactions_for_upgrade
       AND COALESCE(v_user.total_volume_brl, 0) >= v_next_level.min_volume_for_upgrade THEN

        -- Upgrade user
        UPDATE users
        SET reputation_level = v_next_level.level,
            daily_limit_brl = v_next_level.daily_limit_brl,
            last_level_upgrade = NOW()
        WHERE telegram_user_id = p_telegram_user_id;

        -- Log upgrade
        INSERT INTO reputation_level_history
        (telegram_user_id, old_level, new_level, old_limit, new_limit, reason)
        VALUES (p_telegram_user_id, v_user.reputation_level, v_next_level.level,
                v_user.daily_limit_brl, v_next_level.daily_limit_brl, 'Auto upgrade');

        RETURN QUERY SELECT TRUE, v_next_level.level, v_next_level.daily_limit_brl,
                           format('Nível %s (%s)', v_next_level.level, v_next_level.description)::TEXT;
    ELSE
        -- Calculate missing requirements
        v_missing_tx := GREATEST(0, v_next_level.min_transactions_for_upgrade - COALESCE(v_user.completed_transactions, 0));
        v_missing_vol := GREATEST(0, v_next_level.min_volume_for_upgrade - COALESCE(v_user.total_volume_brl, 0));

        RETURN QUERY SELECT FALSE, v_user.reputation_level, v_user.daily_limit_brl,
                           format('Faltam %s tx e R$%s', v_missing_tx, v_missing_vol)::TEXT;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- 2. Fix transaction status trigger
CREATE OR REPLACE FUNCTION process_transaction_status()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.payment_status = 'CONFIRMED' AND (OLD.payment_status IS NULL OR OLD.payment_status != 'CONFIRMED') THEN
        UPDATE users
        SET completed_transactions = COALESCE(completed_transactions, 0) + 1,
            total_volume_brl = COALESCE(total_volume_brl, 0) + NEW.requested_brl_amount,
            daily_used_brl = COALESCE(daily_used_brl, 0) + NEW.requested_brl_amount
        WHERE telegram_user_id = NEW.user_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_process_transaction_status ON pix_transactions;
CREATE TRIGGER trg_process_transaction_status
    AFTER INSERT OR UPDATE ON pix_transactions
    FOR EACH ROW
    EXECUTE FUNCTION process_transaction_status();

-- 3. Add missing column if needed
ALTER TABLE users ADD COLUMN IF NOT EXISTS total_transactions INTEGER DEFAULT 0;

-- 4. Reset and recalculate all user statistics
UPDATE users SET
    completed_transactions = 0,
    total_transactions = 0,
    total_volume_brl = 0;

UPDATE users u
SET completed_transactions = stats.tx_count,
    total_transactions = stats.tx_count,
    total_volume_brl = stats.total_vol
FROM (
    SELECT user_id, COUNT(*) as tx_count, SUM(requested_brl_amount) as total_vol
    FROM pix_transactions
    WHERE payment_status = 'CONFIRMED'
    GROUP BY user_id
) stats
WHERE u.telegram_user_id = stats.user_id;

-- 5. Update user level requirements
UPDATE users u
SET min_transactions_for_upgrade = r.min_transactions_for_upgrade,
    min_volume_for_upgrade = r.min_volume_for_upgrade
FROM reputation_levels_config r
WHERE r.level = u.reputation_level + 1;

-- 6. Apply reputation upgrades
DO $$
DECLARE
    v_user RECORD;
    v_result RECORD;
    v_count INTEGER := 0;
BEGIN
    FOR v_user IN SELECT telegram_user_id FROM users WHERE telegram_user_id IS NOT NULL
    LOOP
        LOOP
            SELECT * INTO v_result FROM check_reputation_upgrade(v_user.telegram_user_id);
            EXIT WHEN NOT v_result.upgraded;
            v_count := v_count + 1;
        END LOOP;
    END LOOP;
    RAISE NOTICE 'Upgraded % users', v_count;
END;
$$;

-- 7. Show results
DO $$
DECLARE
    v_stats RECORD;
BEGIN
    RAISE NOTICE '=== Migration Complete ===';

    FOR v_stats IN
        SELECT r.level, r.description, COUNT(u.*) as users,
               AVG(u.completed_transactions)::INT as avg_tx,
               AVG(u.total_volume_brl)::DECIMAL(10,2) as avg_vol
        FROM reputation_levels_config r
        LEFT JOIN users u ON u.reputation_level = r.level
        GROUP BY r.level, r.description
        HAVING COUNT(u.*) > 0
        ORDER BY r.level
    LOOP
        RAISE NOTICE 'Level % (%): % users, % tx, R$%',
                     v_stats.level, v_stats.description, v_stats.users,
                     v_stats.avg_tx, v_stats.avg_vol;
    END LOOP;
END;
$$;

COMMIT;