-- Migration 014: Sistema de Cidades e Parceiros
-- Gerencia cidades atendidas e parceiros locais para distribuição de processos

-- =====================================================
-- TABELA: cidades
-- =====================================================
CREATE TABLE IF NOT EXISTS cidades (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(200) NOT NULL,
    uf VARCHAR(2) NOT NULL,
    ativo BOOLEAN DEFAULT true,
    criado_em TIMESTAMP DEFAULT NOW(),
    atualizado_em TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cidades_nome ON cidades(nome);
CREATE INDEX IF NOT EXISTS idx_cidades_uf ON cidades(uf);
CREATE INDEX IF NOT EXISTS idx_cidades_ativo ON cidades(ativo);

-- Inserir cidades principais da Bahia (região de atuação)
INSERT INTO cidades (nome, uf) VALUES
    ('Cândido Sales', 'BA'),
    ('Vitória da Conquista', 'BA'),
    ('Itapetinga', 'BA'),
    ('Barra do Choça', 'BA'),
    ('Poções', 'BA'),
    ('Planalto', 'BA'),
    ('Ribeirão do Largo', 'BA'),
    ('Maetinga', 'BA'),
    ('Tremedal', 'BA'),
    ('Belo Campo', 'BA')
ON CONFLICT DO NOTHING;

-- =====================================================
-- Log de sucesso
-- =====================================================
DO $$
BEGIN
    RAISE NOTICE 'Migration 014 executada com sucesso!';
    RAISE NOTICE 'Tabela: cidades';
    RAISE NOTICE '% cidades inseridas', (SELECT COUNT(*) FROM cidades);
END $$;
