-- Migration: Criar tabelas para gerenciamento de responsáveis
-- Data: 2025-11-06

-- =====================================================
-- 1. Tabela de Responsáveis (Pessoas do Escritório)
-- =====================================================
CREATE TABLE IF NOT EXISTS responsaveis (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    nome_tag VARCHAR(50) NOT NULL UNIQUE, -- Nome usado nas tags (ex: "JÚLIA", "ELLEN")
    email VARCHAR(255),
    telefone VARCHAR(20),
    ativo BOOLEAN DEFAULT true,
    fase VARCHAR(20) DEFAULT 'ADMINISTRATIVO', -- "ADMINISTRATIVO" ou "JUDICIAL"
    observacoes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE responsaveis IS 'Pessoas do escritório responsáveis por processos';
COMMENT ON COLUMN responsaveis.nome_tag IS 'Nome exato usado nas tags do Tramitação Inteligente';
COMMENT ON COLUMN responsaveis.fase IS 'Fase em que atua: ADMINISTRATIVO ou JUDICIAL';

-- =====================================================
-- 2. Tabela de Funções/Benefícios
-- =====================================================
CREATE TABLE IF NOT EXISTS funcoes_beneficios (
    id SERIAL PRIMARY KEY,
    codigo VARCHAR(50) NOT NULL UNIQUE, -- "bpc_idoso", "aposentadoria_rural"
    nome_exibicao VARCHAR(100) NOT NULL, -- "BPC (Idoso)", "Aposentadoria Rural"
    categoria VARCHAR(50), -- "assistencial", "previdenciario", "incapacidade"
    palavras_chave TEXT[], -- Array de palavras para matching (ex: ['bpc', 'loas', 'benefício assistencial'])
    fase_padrao VARCHAR(20) DEFAULT 'ADMINISTRATIVO',
    ativo BOOLEAN DEFAULT true,
    ordem_exibicao INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE funcoes_beneficios IS 'Tipos de benefícios e suas características';
COMMENT ON COLUMN funcoes_beneficios.palavras_chave IS 'Palavras usadas para identificar benefício no texto do INSS';

-- =====================================================
-- 3. Tabela de Relacionamento (Many-to-Many)
-- =====================================================
CREATE TABLE IF NOT EXISTS responsavel_funcoes (
    id SERIAL PRIMARY KEY,
    responsavel_id INTEGER NOT NULL REFERENCES responsaveis(id) ON DELETE CASCADE,
    funcao_id INTEGER NOT NULL REFERENCES funcoes_beneficios(id) ON DELETE CASCADE,
    fase VARCHAR(20) DEFAULT 'ADMINISTRATIVO', -- Em qual fase essa pessoa é responsável
    prioridade INTEGER DEFAULT 1, -- Se múltiplas pessoas, quem tem prioridade
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(responsavel_id, funcao_id, fase)
);

COMMENT ON TABLE responsavel_funcoes IS 'Define quem é responsável por qual benefício em cada fase';

-- Índices para performance
CREATE INDEX idx_responsaveis_ativo ON responsaveis(ativo);
CREATE INDEX idx_responsaveis_fase ON responsaveis(fase);
CREATE INDEX idx_funcoes_ativo ON funcoes_beneficios(ativo);
CREATE INDEX idx_responsavel_funcoes_lookup ON responsavel_funcoes(funcao_id, fase);

-- =====================================================
-- 4. Inserir Dados Iniciais (Configuração Atual)
-- =====================================================

-- Pessoas do escritório
INSERT INTO responsaveis (nome, nome_tag, fase, observacoes) VALUES
('Júlia', 'JÚLIA', 'ADMINISTRATIVO', 'Responsável por BPC e Incapacidade na fase administrativa'),
('Ellen', 'ELLEN', 'ADMINISTRATIVO', 'Responsável por benefícios previdenciários na fase administrativa'),
('Ian', 'IAN', 'JUDICIAL', 'Responsável por BPC e Incapacidade na fase judicial'),
('Geraldo', 'GERALDO', 'ADMINISTRATIVO', 'Controle de exigências')
ON CONFLICT (nome_tag) DO NOTHING;

-- Funções/Benefícios
INSERT INTO funcoes_beneficios (codigo, nome_exibicao, categoria, palavras_chave, ordem_exibicao) VALUES
('bpc_idoso', 'BPC (Idoso)', 'assistencial', ARRAY['bpc', 'bpc (idoso)', 'benefício assistencial', 'loas'], 1),
('bpc_deficiencia', 'BPC (Deficiência)', 'assistencial', ARRAY['bpc', 'bpc (deficiência)', 'bpc (deficiencia)', 'loas'], 2),
('beneficio_incapacidade', 'B. Incapacidade', 'incapacidade', ARRAY['auxílio doença', 'auxilio doenca', 'benefício por incapacidade', 'beneficio por incapacidade', 'incapacidade'], 3),
('aposentadoria_idade_rural', 'Aposentadoria por Idade Rural', 'previdenciario', ARRAY['aposentadoria por idade rural', 'aposentadoria rural'], 4),
('aposentadoria_idade_urbana', 'Aposentadoria por Idade Urbana', 'previdenciario', ARRAY['aposentadoria por idade urbana', 'aposentadoria urbana'], 5),
('pensao_morte_rural', 'Pensão por Morte Rural', 'previdenciario', ARRAY['pensão por morte rural', 'pensao por morte rural'], 6),
('pensao_morte_urbana', 'Pensão por Morte Urbana', 'previdenciario', ARRAY['pensão por morte urbana', 'pensao por morte urbana'], 7),
('auxilio_reclusao', 'Auxílio Reclusão', 'previdenciario', ARRAY['auxílio reclusão', 'auxilio reclusao'], 8),
('salario_maternidade', 'Salário-Maternidade', 'previdenciario', ARRAY['salário-maternidade', 'salario-maternidade', 'maternidade'], 9)
ON CONFLICT (codigo) DO NOTHING;

-- Relacionamentos (Quem faz o quê)
-- JÚLIA - Administrativo
INSERT INTO responsavel_funcoes (responsavel_id, funcao_id, fase) 
SELECT r.id, f.id, 'ADMINISTRATIVO'
FROM responsaveis r, funcoes_beneficios f
WHERE r.nome_tag = 'JÚLIA' 
AND f.codigo IN ('bpc_idoso', 'bpc_deficiencia', 'beneficio_incapacidade')
ON CONFLICT DO NOTHING;

-- ELLEN - Administrativo
INSERT INTO responsavel_funcoes (responsavel_id, funcao_id, fase)
SELECT r.id, f.id, 'ADMINISTRATIVO'
FROM responsaveis r, funcoes_beneficios f
WHERE r.nome_tag = 'ELLEN'
AND f.codigo IN ('aposentadoria_idade_rural', 'aposentadoria_idade_urbana', 'pensao_morte_rural', 'pensao_morte_urbana', 'auxilio_reclusao', 'salario_maternidade')
ON CONFLICT DO NOTHING;

-- IAN - Judicial
INSERT INTO responsavel_funcoes (responsavel_id, funcao_id, fase)
SELECT r.id, f.id, 'JUDICIAL'
FROM responsaveis r, funcoes_beneficios f
WHERE r.nome_tag = 'IAN'
AND f.codigo IN ('bpc_idoso', 'bpc_deficiencia', 'beneficio_incapacidade')
ON CONFLICT DO NOTHING;

-- ELLEN - Judicial (demais previdenciários)
INSERT INTO responsavel_funcoes (responsavel_id, funcao_id, fase)
SELECT r.id, f.id, 'JUDICIAL'
FROM responsaveis r, funcoes_beneficios f
WHERE r.nome_tag = 'ELLEN'
AND f.codigo IN ('aposentadoria_idade_rural', 'aposentadoria_idade_urbana', 'pensao_morte_rural', 'pensao_morte_urbana', 'auxilio_reclusao', 'salario_maternidade')
ON CONFLICT DO NOTHING;

-- =====================================================
-- 5. Views Úteis
-- =====================================================

-- View: Quem é responsável por quê em cada fase
CREATE OR REPLACE VIEW vw_responsabilidades AS
SELECT 
    r.nome_tag,
    r.nome,
    r.fase as fase_principal,
    f.codigo as funcao_codigo,
    f.nome_exibicao as funcao_nome,
    f.categoria,
    rf.fase as fase_atuacao,
    rf.prioridade,
    r.ativo as responsavel_ativo,
    f.ativo as funcao_ativa
FROM responsavel_funcoes rf
JOIN responsaveis r ON rf.responsavel_id = r.id
JOIN funcoes_beneficios f ON rf.funcao_id = f.id
ORDER BY rf.fase, f.categoria, f.ordem_exibicao, r.nome_tag;

COMMENT ON VIEW vw_responsabilidades IS 'Visão consolidada de responsabilidades por fase';

-- =====================================================
-- 6. Funções Auxiliares
-- =====================================================

-- Função: Buscar responsável por benefício e fase
CREATE OR REPLACE FUNCTION buscar_responsavel(
    p_texto_beneficio TEXT,
    p_fase VARCHAR(20) DEFAULT 'ADMINISTRATIVO'
)
RETURNS TABLE(nome_tag VARCHAR, nome VARCHAR, funcao_nome VARCHAR) AS $$
BEGIN
    RETURN QUERY
    SELECT DISTINCT ON (r.nome_tag)
        r.nome_tag,
        r.nome,
        f.nome_exibicao
    FROM funcoes_beneficios f
    JOIN responsavel_funcoes rf ON f.id = rf.funcao_id AND rf.fase = p_fase
    JOIN responsaveis r ON rf.responsavel_id = r.id
    WHERE r.ativo = true 
      AND f.ativo = true
      AND (
          -- Comparar com palavras-chave
          EXISTS (
              SELECT 1 FROM unnest(f.palavras_chave) palavra
              WHERE LOWER(p_texto_beneficio) LIKE '%' || LOWER(palavra) || '%'
          )
      )
    ORDER BY r.nome_tag, rf.prioridade DESC
    LIMIT 1;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION buscar_responsavel IS 'Retorna responsável baseado no texto do benefício e fase do processo';

-- =====================================================
-- 7. Triggers para Updated_at
-- =====================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_responsaveis_updated_at BEFORE UPDATE ON responsaveis
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- FINALIZADO
-- =====================================================

-- Verificar dados inseridos
SELECT 'Responsáveis cadastrados:' as info;
SELECT id, nome, nome_tag, fase, ativo FROM responsaveis;

SELECT 'Funções/Benefícios cadastrados:' as info;
SELECT id, codigo, nome_exibicao, categoria FROM funcoes_beneficios ORDER BY ordem_exibicao;

SELECT 'Responsabilidades configuradas:' as info;
SELECT * FROM vw_responsabilidades;

-- Testar função de busca
SELECT 'Teste de busca - BPC na fase ADMINISTRATIVO:' as info;
SELECT * FROM buscar_responsavel('BPC (IDOSO)', 'ADMINISTRATIVO');

SELECT 'Teste de busca - BPC na fase JUDICIAL:' as info;
SELECT * FROM buscar_responsavel('BPC (IDOSO)', 'JUDICIAL');

SELECT 'Teste de busca - Aposentadoria Rural na fase ADMINISTRATIVO:' as info;
SELECT * FROM buscar_responsavel('Aposentadoria por Idade Rural', 'ADMINISTRATIVO');
