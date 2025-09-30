-- Fix reputation level requirements - they were set too high
-- This makes the progression more reasonable and consistent

UPDATE reputation_levels_config 
SET min_volume_for_upgrade = CASE 
    WHEN level = 5 THEN 2000.00  -- was 4000, now 2x daily limit
    WHEN level = 6 THEN 5000.00  -- was 10000, now 2.5x daily limit
    WHEN level = 7 THEN 10000.00 -- was 15000, now 3.3x daily limit
    WHEN level = 8 THEN 15000.00 -- was 25000, now 3.75x daily limit
    WHEN level = 9 THEN 30000.00 -- was 50000, now 6x daily limit
    ELSE min_volume_for_upgrade
END
WHERE level IN (5, 6, 7, 8, 9);

-- Update all users' next level requirements
UPDATE users u
SET min_volume_for_upgrade = r.min_volume_for_upgrade,
    min_transactions_for_upgrade = r.min_transactions_for_upgrade
FROM reputation_levels_config r
WHERE r.level = u.reputation_level + 1;

-- Check for users eligible for upgrade
SELECT telegram_user_id, reputation_level, total_volume_brl, completed_transactions
FROM users
WHERE total_volume_brl >= min_volume_for_upgrade
  AND completed_transactions >= min_transactions_for_upgrade
  AND reputation_level < 10;
