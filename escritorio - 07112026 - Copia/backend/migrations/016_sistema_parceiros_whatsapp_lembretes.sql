-- =====================================================
-- MIGRATION 016: Sistema de Parceiros WhatsApp + Lembretes
-- =====================================================

-- 1. Adicionar campo api_key_callmebot na tabela parceiros
ALTER TABLE parceiros 
ADD COLUMN IF NOT EXISTS api_key_callmebot VARCHAR(50);

-- 2. Adicionar campo para rastrear quando exigência foi cumprida
ALTER TABLE exigencias
ADD COLUMN IF NOT EXISTS data_cumprimento TIMESTAMP,
ADD COLUMN IF NOT EXISTS cumprida_por_id UUID REFERENCES usuarios(id);

-- 3. Adicionar campo para rastrear última notificação de lembrete enviada
ALTER TABLE exigencias
ADD COLUMN IF NOT EXISTS ultimo_lembrete_enviado TIMESTAMP;

-- 4. Criar índice para buscar exigências que precisam de lembrete
CREATE INDEX IF NOT EXISTS idx_exigencias_lembrete 
ON exigencias(processo_id, prazo, status, ultimo_lembrete_enviado) 
WHERE status = 'PENDENTE' AND data_cumprimento IS NULL;

-- 5. Comentários
COMMENT ON COLUMN parceiros.api_key_callmebot IS 'API Key do CallMeBot para este parceiro';
COMMENT ON COLUMN exigencias.data_cumprimento IS 'Data em que a exigência foi cumprida (protocolada no PAT)';
COMMENT ON COLUMN exigencias.cumprida_por_id IS 'Usuário que marcou a exigência como cumprida';
COMMENT ON COLUMN exigencias.ultimo_lembrete_enviado IS 'Data do último lembrete enviado (para evitar spam)';

