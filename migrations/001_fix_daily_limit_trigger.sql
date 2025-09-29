-- Migration: Fix daily limit trigger to prevent duplications and ensure proper daily reset
-- Date: 2025-09-29
-- Issue: Users were getting their daily_used_brl incorrectly incremented
-- Fixed user CPF 03022763603 who had 750.00 instead of 500.00

CREATE OR REPLACE FUNCTION process_transaction_status()
RETURNS TRIGGER AS $$
DECLARE
    v_next_level RECORD;
    v_user RECORD;
BEGIN
    -- Update user stats when payment is confirmed or paid
    IF (NEW.payment_status IN ('PAID', 'CONFIRMED')) AND
       (OLD.payment_status IS NULL OR OLD.payment_status NOT IN ('PAID', 'CONFIRMED')) THEN

        -- Get user data
        SELECT * INTO v_user FROM users WHERE telegram_user_id = NEW.user_id;

        -- Check if daily limit needs reset before adding
        IF v_user.last_limit_reset < CURRENT_DATE THEN
            -- Reset daily limit
            UPDATE users
            SET daily_used_brl = NEW.requested_brl_amount,
                last_limit_reset = CURRENT_TIMESTAMP,
                completed_transactions = COALESCE(completed_transactions, 0) + 1,
                total_volume_brl = COALESCE(total_volume_brl, 0) + NEW.requested_brl_amount,
                total_transactions = COALESCE(total_transactions, 0) + 1,
                updated_at = NOW()
            WHERE telegram_user_id = NEW.user_id;

            RAISE NOTICE 'Reset daily limit and added R$ % for user %', NEW.requested_brl_amount, NEW.user_id;
        ELSE
            -- Add to existing daily usage
            UPDATE users
            SET completed_transactions = COALESCE(completed_transactions, 0) + 1,
                total_volume_brl = COALESCE(total_volume_brl, 0) + NEW.requested_brl_amount,
                total_transactions = COALESCE(total_transactions, 0) + 1,
                daily_used_brl = COALESCE(daily_used_brl, 0) + NEW.requested_brl_amount,
                updated_at = NOW()
            WHERE telegram_user_id = NEW.user_id;

            RAISE NOTICE 'Added R$ % to daily usage for user %', NEW.requested_brl_amount, NEW.user_id;
        END IF;

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
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;