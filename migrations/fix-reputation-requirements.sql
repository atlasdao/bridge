-- Migration: Fix reputation level requirements tracking
-- Date: 2025-09-28
-- Description: Fixes min_volume_for_upgrade and min_transactions_for_upgrade to show requirements for NEXT level

-- Step 1: Fix existing user data - set correct requirements for next level
UPDATE users u
SET
    min_volume_for_upgrade = COALESCE(rlc.min_volume_for_upgrade, 0),
    min_transactions_for_upgrade = COALESCE(rlc.min_transactions_for_upgrade, 0)
FROM reputation_levels_config rlc
WHERE rlc.level = u.reputation_level + 1;

-- For users at max level, set to 0
UPDATE users
SET
    min_volume_for_upgrade = 0,
    min_transactions_for_upgrade = 0
WHERE reputation_level >= 10;

-- Step 2: Update the transaction processing trigger to maintain these fields
CREATE OR REPLACE FUNCTION process_transaction_status()
RETURNS TRIGGER AS $$
DECLARE
    v_next_level RECORD;
BEGIN
    -- Update user stats when payment is confirmed or paid
    IF (NEW.payment_status IN ('PAID', 'CONFIRMED')) AND
       (OLD.payment_status IS NULL OR OLD.payment_status NOT IN ('PAID', 'CONFIRMED')) THEN

        -- Update basic stats
        UPDATE users
        SET completed_transactions = COALESCE(completed_transactions, 0) + 1,
            total_volume_brl = COALESCE(total_volume_brl, 0) + NEW.requested_brl_amount,
            total_transactions = COALESCE(total_transactions, 0) + 1,
            daily_used_brl = COALESCE(daily_used_brl, 0) + NEW.requested_brl_amount,
            updated_at = NOW()
        WHERE telegram_user_id = NEW.user_id;

        -- Get next level requirements and update
        SELECT * INTO v_next_level
        FROM reputation_levels_config
        WHERE level = (
            SELECT reputation_level + 1
            FROM users
            WHERE telegram_user_id = NEW.user_id
        );

        IF FOUND THEN
            UPDATE users
            SET min_volume_for_upgrade = v_next_level.min_volume_for_upgrade,
                min_transactions_for_upgrade = v_next_level.min_transactions_for_upgrade
            WHERE telegram_user_id = NEW.user_id;
        END IF;

        RAISE NOTICE 'Updated user % stats: added %.2f BRL', NEW.user_id, NEW.requested_brl_amount;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Step 3: Create function to update requirements when reputation level changes
CREATE OR REPLACE FUNCTION update_next_level_requirements()
RETURNS TRIGGER AS $$
DECLARE
    v_next_level RECORD;
BEGIN
    -- When reputation level changes, update the requirements for next level
    IF NEW.reputation_level != OLD.reputation_level THEN
        SELECT * INTO v_next_level
        FROM reputation_levels_config
        WHERE level = NEW.reputation_level + 1;

        IF FOUND THEN
            NEW.min_volume_for_upgrade := v_next_level.min_volume_for_upgrade;
            NEW.min_transactions_for_upgrade := v_next_level.min_transactions_for_upgrade;
        ELSE
            -- User is at max level
            NEW.min_volume_for_upgrade := 0;
            NEW.min_transactions_for_upgrade := 0;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Step 4: Create trigger for reputation level changes
DROP TRIGGER IF EXISTS trg_update_next_level_requirements ON users;
CREATE TRIGGER trg_update_next_level_requirements
BEFORE UPDATE OF reputation_level ON users
FOR EACH ROW
EXECUTE FUNCTION update_next_level_requirements();

-- Verification query to check if fix was applied correctly
-- Run this to verify:
-- SELECT
--     telegram_username,
--     reputation_level,
--     total_volume_brl,
--     completed_transactions,
--     min_volume_for_upgrade,
--     min_transactions_for_upgrade
-- FROM users
-- WHERE is_verified = true
-- ORDER BY reputation_level DESC
-- LIMIT 10;