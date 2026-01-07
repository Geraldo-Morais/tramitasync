-- Migration 018: Adicionar credenciais do Tramitação para usuários da extensão
-- Permite que cada usuário tenha suas próprias credenciais do Tramitação

-- Adicionar colunas para email e senha do Tramitação
ALTER TABLE usuarios_extensao 
ADD COLUMN IF NOT EXISTS tramitacao_email VARCHAR(255),
ADD COLUMN IF NOT EXISTS tramitacao_senha VARCHAR(255);

-- Criar índice para busca por email do Tramitação (opcional, mas útil)
CREATE INDEX IF NOT EXISTS idx_usuarios_extensao_tramitacao_email 
ON usuarios_extensao(tramitacao_email) 
WHERE tramitacao_email IS NOT NULL;

-- Comentários nas colunas
COMMENT ON COLUMN usuarios_extensao.tramitacao_email IS 'Email de login do usuário no Tramitação Inteligente';
COMMENT ON COLUMN usuarios_extensao.tramitacao_senha IS 'Senha de login do usuário no Tramitação Inteligente (criptografada)';
