-- Script para corrigir brecha de segurança no sistema de gamificação
-- Problema: Usuários conseguiam subir para nível 2 imediatamente ao fazer o primeiro pagamento de R$ 50

-- 1. Corrigir a função de verificação de upgrade de reputação
CREATE OR REPLACE FUNCTION check_reputation_upgrade(p_user_id BIGINT)
RETURNS TABLE(
    upgraded BOOLEAN,
    new_level INTEGER,
    new_limit DECIMAL(10,2),
    message TEXT
) AS $$
DECLARE
    v_user RECORD;
    v_new_level INTEGER;
    v_new_limit DECIMAL(10,2);
    v_hours_remaining INTEGER;
BEGIN
    SELECT * INTO v_user
    FROM users
    WHERE telegram_user_id = p_user_id;
    
    -- Verificar se o usuário existe e está verificado
    IF NOT FOUND OR NOT v_user.is_verified THEN
        RETURN QUERY SELECT FALSE, 0, 0::DECIMAL(10,2), 'Usuário não encontrado ou não verificado';
        RETURN;
    END IF;
    
    -- Verificar se já está no nível máximo
    IF v_user.reputation_level >= 10 THEN
        RETURN QUERY SELECT FALSE, v_user.reputation_level, v_user.daily_limit_brl, 'Já está no nível máximo';
        RETURN;
    END IF;
    
    -- Verificar se atingiu o limite diário
    IF v_user.daily_used_brl < v_user.daily_limit_brl THEN
        RETURN QUERY SELECT FALSE, v_user.reputation_level, v_user.daily_limit_brl, 
            FORMAT('Precisa usar R$ %s para subir de nível', 
                   (v_user.daily_limit_brl - v_user.daily_used_brl)::DECIMAL(10,2));
        RETURN;
    END IF;
    
    -- CORREÇÃO CRÍTICA: Se atingiu 100% do limite mas next_level_available_at é NULL
    -- ou foi resetado (após reset diário), definir o timer de 24h e NÃO fazer upgrade
    IF v_user.next_level_available_at IS NULL OR v_user.next_level_available_at < v_user.last_limit_reset THEN
        -- Definir quando o próximo nível estará disponível
        UPDATE users
        SET next_level_available_at = CURRENT_TIMESTAMP + INTERVAL '24 hours',
            updated_at = CURRENT_TIMESTAMP
        WHERE telegram_user_id = p_user_id;
        
        RETURN QUERY SELECT FALSE, v_user.reputation_level, v_user.daily_limit_brl,
            'Limite diário atingido! Aguarde 24 horas para subir para o próximo nível';
        RETURN;
    END IF;
    
    -- Verificar se já passou 24h desde que atingiu 100% do limite
    IF v_user.next_level_available_at > CURRENT_TIMESTAMP THEN
        -- Calcular horas restantes
        v_hours_remaining := EXTRACT(EPOCH FROM (v_user.next_level_available_at - CURRENT_TIMESTAMP)) / 3600;
        
        RETURN QUERY SELECT FALSE, v_user.reputation_level, v_user.daily_limit_brl,
            FORMAT('Próximo nível disponível em %s horas', 
                   GREATEST(1, v_hours_remaining)::INTEGER);
        RETURN;
    END IF;
    
    -- Fazer o upgrade apenas se passou 24h
    v_new_level := v_user.reputation_level + 1;
    
    SELECT daily_limit_brl INTO v_new_limit
    FROM reputation_levels_config
    WHERE level = v_new_level;
    
    -- Atualizar usuário
    UPDATE users
    SET reputation_level = v_new_level,
        daily_limit_brl = v_new_limit,
        last_level_upgrade = CURRENT_TIMESTAMP,
        next_level_available_at = NULL, -- Resetar para o próximo ciclo
        daily_used_brl = 0, -- Resetar uso diário ao subir de nível
        last_limit_reset = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE telegram_user_id = p_user_id;
    
    -- Registrar no histórico
    INSERT INTO reputation_level_history 
        (telegram_user_id, old_level, new_level, old_limit, new_limit, reason)
    VALUES 
        (p_user_id, v_user.reputation_level, v_new_level, v_user.daily_limit_brl, v_new_limit, 'daily_limit_reached');
    
    RETURN QUERY SELECT TRUE, v_new_level, v_new_limit,
        FORMAT('Parabéns! Você subiu para o nível %s. Novo limite diário: R$ %s', 
               v_new_level, v_new_limit);
END;
$$ LANGUAGE plpgsql;

-- 2. Adicionar validação adicional na função can_user_transact para garantir consistência
CREATE OR REPLACE FUNCTION can_user_transact(
    p_telegram_user_id BIGINT,
    p_amount DECIMAL(10,2)
)
RETURNS TABLE(
    can_transact BOOLEAN,
    reason TEXT,
    available_limit DECIMAL(10,2)
) AS $$
DECLARE
    v_user RECORD;
    v_max_per_transaction DECIMAL(10,2);
BEGIN
    SELECT u.*, rlc.max_per_transaction_brl
    INTO v_user
    FROM users u
    LEFT JOIN reputation_levels_config rlc ON u.reputation_level = rlc.level
    WHERE u.telegram_user_id = p_telegram_user_id;
    
    -- Verificar se usuário existe
    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'Usuário não encontrado', 0::DECIMAL(10,2);
        RETURN;
    END IF;
    
    -- Verificar se está banido
    IF v_user.is_banned THEN
        RETURN QUERY SELECT FALSE, 'Usuário banido. Entre em contato com o suporte.', 0::DECIMAL(10,2);
        RETURN;
    END IF;
    
    -- Verificar se está verificado
    IF NOT v_user.is_verified THEN
        RETURN QUERY SELECT FALSE, 'Conta não verificada. Complete o processo de verificação primeiro.', 0::DECIMAL(10,2);
        RETURN;
    END IF;
    
    -- Resetar limite diário se necessário (com sincronização)
    IF v_user.last_limit_reset < CURRENT_DATE THEN
        UPDATE users
        SET daily_used_brl = 0,
            last_limit_reset = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE telegram_user_id = p_telegram_user_id
        RETURNING daily_used_brl INTO v_user.daily_used_brl;
    END IF;
    
    -- Verificar limite diário
    IF (v_user.daily_used_brl + p_amount) > v_user.daily_limit_brl THEN
        RETURN QUERY SELECT FALSE, 
            FORMAT('Limite diário excedido. Disponível: R$ %s', 
                   (v_user.daily_limit_brl - v_user.daily_used_brl)::DECIMAL(10,2)),
            (v_user.daily_limit_brl - v_user.daily_used_brl)::DECIMAL(10,2);
        RETURN;
    END IF;
    
    -- Verificar limite por transação (especialmente para nível 10)
    SELECT max_per_transaction_brl INTO v_max_per_transaction
    FROM reputation_levels_config
    WHERE level = v_user.reputation_level;
    
    IF v_max_per_transaction IS NOT NULL AND p_amount > v_max_per_transaction THEN
        RETURN QUERY SELECT FALSE, 
            FORMAT('Limite máximo por transação: R$ %s', v_max_per_transaction),
            (v_user.daily_limit_brl - v_user.daily_used_brl)::DECIMAL(10,2);
        RETURN;
    END IF;
    
    -- Tudo ok
    RETURN QUERY SELECT TRUE, 
        'Transação autorizada', 
        (v_user.daily_limit_brl - v_user.daily_used_brl)::DECIMAL(10,2);
END;
$$ LANGUAGE plpgsql;

-- 3. Corrigir usuários que possam ter sido afetados pela brecha
-- Resetar usuários de nível 2 que subiram muito rapidamente (menos de 24h após validação)
UPDATE users
SET reputation_level = 1,
    daily_limit_brl = 50,
    next_level_available_at = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE reputation_level = 2
  AND is_verified = TRUE
  AND verification_payment_date IS NOT NULL
  AND last_level_upgrade IS NOT NULL
  AND last_level_upgrade < (verification_payment_date + INTERVAL '24 hours');

-- Registrar a correção no histórico
INSERT INTO reputation_level_history (telegram_user_id, old_level, new_level, old_limit, new_limit, reason)
SELECT telegram_user_id, 2, 1, 100, 50, 'breach_correction'
FROM users
WHERE reputation_level = 1
  AND is_verified = TRUE
  AND verification_payment_date IS NOT NULL
  AND last_level_upgrade IS NOT NULL
  AND last_level_upgrade < (verification_payment_date + INTERVAL '24 hours');

-- 4. Adicionar função para monitoramento de upgrades suspeitos
CREATE OR REPLACE FUNCTION monitor_suspicious_upgrades()
RETURNS TABLE(
    user_id BIGINT,
    username VARCHAR(255),
    current_level INTEGER,
    verification_date TIMESTAMP,
    first_upgrade_date TIMESTAMP,
    hours_to_first_upgrade NUMERIC
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        u.telegram_user_id,
        u.telegram_username,
        u.reputation_level,
        u.verification_payment_date,
        u.last_level_upgrade,
        EXTRACT(EPOCH FROM (u.last_level_upgrade - u.verification_payment_date)) / 3600 as hours_diff
    FROM users u
    WHERE u.is_verified = TRUE
      AND u.reputation_level > 1
      AND u.verification_payment_date IS NOT NULL
      AND u.last_level_upgrade IS NOT NULL
      AND u.last_level_upgrade < (u.verification_payment_date + INTERVAL '24 hours')
    ORDER BY hours_diff ASC;
END;
$$ LANGUAGE plpgsql;

-- Executar monitoramento para verificar usuários afetados
SELECT * FROM monitor_suspicious_upgrades();

-- Mensagem de conclusão
DO $$
BEGIN
    RAISE NOTICE 'Correções aplicadas com sucesso!';
    RAISE NOTICE 'A brecha que permitia upgrade imediato para nível 2 foi corrigida.';
    RAISE NOTICE 'Usuários afetados foram revertidos para nível 1.';
END $$;