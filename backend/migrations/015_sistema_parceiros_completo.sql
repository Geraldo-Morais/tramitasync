-- Migration 015: Ajustes no Sistema de Parceiros
-- A tabela parceiros já existe (migration 011) com estrutura diferente
-- Vamos apenas adicionar o parceiro de teste e melhorar queries

-- =====================================================
-- Inserir parceiro de teste (Cândido Sales)
-- =====================================================
DO $$
DECLARE
    v_parceiro_id INTEGER;
BEGIN
    -- Inserir parceiro se não existir
    INSERT INTO parceiros (nome, cidade, telefone_whatsapp, email, ativo)
    VALUES ('Colaborador Teste', 'Cândido Sales', '+5577988682628', 'colaborador.teste@gmail.com', true)
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_parceiro_id;
    
    IF v_parceiro_id IS NOT NULL THEN
        RAISE NOTICE 'Parceiro % cadastrado para Cândido Sales', v_parceiro_id;
    ELSE
        RAISE NOTICE 'Parceiro já existia no banco';
    END IF;
END $$;

-- =====================================================
-- ALTERAR TABELA: processos
-- Adicionar campos que estavam faltando
-- =====================================================

-- Adicionar coluna de tags (array para múltiplas tags)
ALTER TABLE processos 
ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';

-- Adicionar responsável de entrada (quem protocolou)
ALTER TABLE processos 
ADD COLUMN IF NOT EXISTS responsavel_entrada_id UUID REFERENCES usuarios(id);

-- Adicionar data de entrada do requerimento
ALTER TABLE processos 
ADD COLUMN IF NOT EXISTS data_entrada TIMESTAMP;

-- Adicionar numero do processo (diferente de protocolo)
ALTER TABLE processos 
ADD COLUMN IF NOT EXISTS numero_processo VARCHAR(50);

-- Adicionar beneficio (tipo textual)
ALTER TABLE processos 
ADD COLUMN IF NOT EXISTS beneficio VARCHAR(100);

-- Adicionar cidade (renomear cidade_parceiro para cidade)
DO $$ 
BEGIN
    -- Se cidade_parceiro existe e cidade não, renomear
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='processos' AND column_name='cidade_parceiro')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='processos' AND column_name='cidade') THEN
        ALTER TABLE processos RENAME COLUMN cidade_parceiro TO cidade;
    -- Se cidade não existe, criar
    ELSIF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='processos' AND column_name='cidade') THEN
        ALTER TABLE processos ADD COLUMN cidade VARCHAR(200);
    END IF;
    
    -- Se email_unico_tramitacao existe, renomear para email_exclusivo_tramitacao
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='processos' AND column_name='email_unico_tramitacao')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='processos' AND column_name='email_exclusivo_tramitacao') THEN
        ALTER TABLE processos RENAME COLUMN email_unico_tramitacao TO email_exclusivo_tramitacao;
    -- Se email_exclusivo_tramitacao não existe, criar
    ELSIF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='processos' AND column_name='email_exclusivo_tramitacao') THEN
        ALTER TABLE processos ADD COLUMN email_exclusivo_tramitacao VARCHAR(255);
    END IF;
END $$;

-- Criar índices
CREATE INDEX IF NOT EXISTS idx_processos_email_tramitacao ON processos(email_exclusivo_tramitacao);
CREATE INDEX IF NOT EXISTS idx_processos_tags ON processos USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_processos_cidade ON processos(cidade);
CREATE INDEX IF NOT EXISTS idx_processos_responsavel_entrada ON processos(responsavel_entrada_id);
CREATE INDEX IF NOT EXISTS idx_processos_numero ON processos(numero_processo);

-- =====================================================
-- ALTERAR TABELA: notificacoes_whatsapp
-- Adicionar campos de confirmação
-- =====================================================

-- Status de confirmação de envio pelo parceiro
ALTER TABLE notificacoes_whatsapp 
ADD COLUMN IF NOT EXISTS confirmacao_parceiro BOOLEAN DEFAULT false;

ALTER TABLE notificacoes_whatsapp 
ADD COLUMN IF NOT EXISTS data_confirmacao_parceiro TIMESTAMP;

-- Identificar qual parceiro confirmou
ALTER TABLE notificacoes_whatsapp 
ADD COLUMN IF NOT EXISTS parceiro_id INTEGER REFERENCES parceiros(id);

-- Mensagem de confirmação recebida
ALTER TABLE notificacoes_whatsapp 
ADD COLUMN IF NOT EXISTS mensagem_confirmacao TEXT;

-- Criar índices
CREATE INDEX IF NOT EXISTS idx_notif_confirmacao ON notificacoes_whatsapp(confirmacao_parceiro);
CREATE INDEX IF NOT EXISTS idx_notif_parceiro ON notificacoes_whatsapp(parceiro_id);

-- =====================================================
-- FUNÇÃO: Buscar parceiros de uma cidade (usa estrutura atual)
-- =====================================================
CREATE OR REPLACE FUNCTION buscar_parceiros_cidade(p_cidade VARCHAR)
RETURNS TABLE (
    parceiro_id INTEGER,
    nome VARCHAR,
    telefone VARCHAR,
    email VARCHAR
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        p.id,
        p.nome::VARCHAR,
        p.telefone_whatsapp::VARCHAR,
        p.email::VARCHAR
    FROM parceiros p
    WHERE p.cidade ILIKE p_cidade
    AND p.ativo = true;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- Log de sucesso
-- =====================================================
DO $$
BEGIN
    RAISE NOTICE 'Migration 015 executada com sucesso!';
    RAISE NOTICE 'Tabelas: parceiros, parceiros_cidades';
    RAISE NOTICE 'Alterações: processos (email, tags, cidade), notificacoes_whatsapp (confirmação)';
    RAISE NOTICE 'Views: v_parceiros_por_cidade';
    RAISE NOTICE 'Funções: buscar_parceiros_cidade()';
END $$;
