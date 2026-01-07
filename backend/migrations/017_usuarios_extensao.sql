-- Migration: Tabela de usuários da extensão INSS
-- Descrição: Armazena usuários, credenciais e configurações da extensão

CREATE TABLE IF NOT EXISTS usuarios_extensao (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL UNIQUE,
    nome VARCHAR(255) NOT NULL,
    senha_hash VARCHAR(255) NOT NULL,
    
    -- Configurações do usuário
    gemini_api_key TEXT,
    tramitacao_api_token TEXT,
    pat_token TEXT,
    pat_token_timestamp TIMESTAMP,
    
    -- Licença (lifetime = 100 anos)
    licenca_valida_ate TIMESTAMP NOT NULL DEFAULT (NOW() + INTERVAL '100 years'),
    
    -- Timestamps
    criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
    atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_usuarios_extensao_email ON usuarios_extensao(email);
CREATE INDEX IF NOT EXISTS idx_usuarios_extensao_licenca ON usuarios_extensao(licenca_valida_ate);

-- Comentários
COMMENT ON TABLE usuarios_extensao IS 'Usuários da extensão INSS com suas configurações e credenciais';
COMMENT ON COLUMN usuarios_extensao.gemini_api_key IS 'API Key do Gemini do usuário';
COMMENT ON COLUMN usuarios_extensao.tramitacao_api_token IS 'Token da API do Tramitação Inteligente do usuário';
COMMENT ON COLUMN usuarios_extensao.pat_token IS 'Token PAT capturado automaticamente (válido por 2 horas)';
COMMENT ON COLUMN usuarios_extensao.pat_token_timestamp IS 'Timestamp de quando o token PAT foi capturado';
COMMENT ON COLUMN usuarios_extensao.licenca_valida_ate IS 'Data de expiração da licença (lifetime = 100 anos)';


