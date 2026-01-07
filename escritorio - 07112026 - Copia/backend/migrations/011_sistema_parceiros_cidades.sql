-- =====================================================
-- SISTEMA DE PARCEIROS POR CIDADE
-- =====================================================

-- Tabela de Parceiros (por cidade)
CREATE TABLE IF NOT EXISTS parceiros (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    cidade VARCHAR(100) NOT NULL,
    telefone_whatsapp VARCHAR(20) NOT NULL,
    email VARCHAR(255),
    ativo BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Index para buscar por cidade rapidamente
CREATE INDEX IF NOT EXISTS idx_parceiros_cidade ON parceiros(cidade) WHERE ativo = true;

-- Adicionar campos em processos para integração
ALTER TABLE processos 
ADD COLUMN IF NOT EXISTS cidade_parceiro VARCHAR(100),
ADD COLUMN IF NOT EXISTS email_unico_tramitacao VARCHAR(255),
ADD COLUMN IF NOT EXISTS tramitacao_email_gerado BOOLEAN DEFAULT false;

-- Tabela de notificações WhatsApp (para N8N consumir)
CREATE TABLE IF NOT EXISTS notificacoes_whatsapp (
    id SERIAL PRIMARY KEY,
    processo_id UUID REFERENCES processos(id) ON DELETE CASCADE,
    exigencia_id UUID REFERENCES exigencias(id) ON DELETE CASCADE,
    tipo VARCHAR(50) NOT NULL, -- 'EXIGENCIA_DETECTADA', 'LEMBRETE_PRAZO', 'RESULTADO'
    telefone_destino VARCHAR(20) NOT NULL,
    cidade VARCHAR(100) NOT NULL,
    mensagem TEXT NOT NULL,
    enviada BOOLEAN DEFAULT false,
    data_envio TIMESTAMP,
    resposta TEXT,
    confirmacao_recebida BOOLEAN DEFAULT false,
    data_confirmacao TIMESTAMP,
    tentativas INTEGER DEFAULT 0,
    erro TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Index para N8N pegar notificações pendentes
CREATE INDEX IF NOT EXISTS idx_notificacoes_pendentes 
ON notificacoes_whatsapp(enviada, created_at) 
WHERE enviada = false;

-- Tabela de sincronização com Tramitação
CREATE TABLE IF NOT EXISTS tramitacao_sync_log (
    id SERIAL PRIMARY KEY,
    processo_id UUID REFERENCES processos(id) ON DELETE CASCADE,
    acao VARCHAR(100) NOT NULL, -- 'CRIAR_CLIENTE', 'GERAR_EMAIL', 'ADICIONAR_TAG', 'ADICIONAR_NOTA', etc
    sucesso BOOLEAN NOT NULL,
    detalhes JSONB,
    erro TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Index para auditar falhas
CREATE INDEX IF NOT EXISTS idx_sync_falhas 
ON tramitacao_sync_log(sucesso, created_at) 
WHERE sucesso = false;

-- Tabela para rastrear confirmações de documentos
CREATE TABLE IF NOT EXISTS confirmacoes_documentos (
    id SERIAL PRIMARY KEY,
    exigencia_id UUID REFERENCES exigencias(id) ON DELETE CASCADE,
    parceiro_enviou BOOLEAN DEFAULT false,
    data_envio_parceiro TIMESTAMP,
    documentos_recebidos BOOLEAN DEFAULT false,
    data_recebimento TIMESTAMP,
    verificado_por_id UUID REFERENCES usuarios(id),
    data_verificacao TIMESTAMP,
    observacao TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- =====================================================
-- VIEWS ÚTEIS
-- =====================================================

-- View: Processos com informações completas de parceiro
CREATE OR REPLACE VIEW v_processos_parceiros AS
SELECT 
    p.id,
    p.protocolo_inss,
    p.nome_segurado,
    p.cpf_segurado,
    p.tipo_beneficio,
    p.status_inss,
    p.status_fluxo,
    p.cidade_parceiro,
    p.email_unico_tramitacao,
    STRING_AGG(DISTINCT parc.nome, ', ') as parceiros_cidade,
    STRING_AGG(DISTINCT parc.telefone_whatsapp, ', ') as telefones_parceiros,
    COUNT(DISTINCT e.id) as total_exigencias,
    COUNT(DISTINCT e.id) FILTER (WHERE e.status = 'PENDENTE') as exigencias_pendentes
FROM processos p
LEFT JOIN parceiros parc ON parc.cidade = p.cidade_parceiro AND parc.ativo = true
LEFT JOIN exigencias e ON e.processo_id = p.id
GROUP BY p.id;

-- View: Notificações WhatsApp pendentes com informações completas
CREATE OR REPLACE VIEW v_notificacoes_pendentes AS
SELECT 
    nw.id,
    nw.tipo,
    nw.telefone_destino,
    nw.cidade,
    nw.mensagem,
    nw.tentativas,
    p.protocolo_inss,
    p.nome_segurado,
    p.cpf_segurado,
    e.prazo as prazo_exigencia,
    e.resumo_exigencia,
    nw.created_at
FROM notificacoes_whatsapp nw
JOIN processos p ON p.id = nw.processo_id
LEFT JOIN exigencias e ON e.id = nw.exigencia_id
WHERE nw.enviada = false 
  AND nw.tentativas < 3
ORDER BY nw.created_at ASC;

-- =====================================================
-- FUNÇÕES AUXILIARES
-- =====================================================

-- Função: Obter telefones de parceiros por cidade
CREATE OR REPLACE FUNCTION get_telefones_parceiros(p_cidade VARCHAR)
RETURNS TABLE(telefone VARCHAR, nome VARCHAR) AS $$
BEGIN
    RETURN QUERY
    SELECT telefone_whatsapp, nome
    FROM parceiros
    WHERE cidade = p_cidade 
      AND ativo = true
    ORDER BY nome;
END;
$$ LANGUAGE plpgsql;

-- Função: Criar notificação WhatsApp para exigência
CREATE OR REPLACE FUNCTION criar_notificacao_exigencia(
    p_processo_id UUID,
    p_exigencia_id UUID
) RETURNS INTEGER AS $$
DECLARE
    v_cidade VARCHAR;
    v_telefone VARCHAR;
    v_nome_segurado VARCHAR;
    v_protocolo VARCHAR;
    v_prazo DATE;
    v_dias_restantes INTEGER;
    v_resumo TEXT;
    v_email_unico VARCHAR;
    v_mensagem TEXT;
    v_notif_id INTEGER;
    parceiro RECORD;
BEGIN
    -- Buscar informações do processo
    SELECT 
        p.cidade_parceiro,
        p.nome_segurado,
        p.protocolo_inss,
        p.email_unico_tramitacao,
        e.prazo,
        e.resumo_exigencia,
        (e.prazo - CURRENT_DATE) as dias_restantes
    INTO 
        v_cidade, v_nome_segurado, v_protocolo, v_email_unico,
        v_prazo, v_resumo, v_dias_restantes
    FROM processos p
    JOIN exigencias e ON e.id = p_exigencia_id
    WHERE p.id = p_processo_id;

    -- Se não tem cidade, não cria notificação
    IF v_cidade IS NULL THEN
        RAISE NOTICE 'Processo sem cidade de parceiro definida';
        RETURN 0;
    END IF;

    -- Montar mensagem
    v_mensagem := '🔔 EXIGÊNCIA DETECTADA' || E'\n\n';
    v_mensagem := v_mensagem || 'Cliente: ' || v_nome_segurado || E'\n';
    v_mensagem := v_mensagem || 'Protocolo: ' || v_protocolo || E'\n\n';
    v_mensagem := v_mensagem || '⚠️ Prazo: ' || TO_CHAR(v_prazo, 'DD/MM/YYYY') || ' (' || v_dias_restantes || ' dias)' || E'\n\n';
    v_mensagem := v_mensagem || '📋 Exigência:' || E'\n' || v_resumo || E'\n\n';
    
    IF v_email_unico IS NOT NULL THEN
        v_mensagem := v_mensagem || '📧 ENVIE OS DOCUMENTOS PARA:' || E'\n';
        v_mensagem := v_mensagem || v_email_unico || E'\n\n';
    END IF;
    
    v_mensagem := v_mensagem || '⚠️ IMPORTANTE: Confirme o envio respondendo "ENVIADO"';

    -- Criar notificação para cada parceiro da cidade
    FOR parceiro IN 
        SELECT telefone_whatsapp, nome 
        FROM parceiros 
        WHERE cidade = v_cidade AND ativo = true
    LOOP
        INSERT INTO notificacoes_whatsapp (
            processo_id,
            exigencia_id,
            tipo,
            telefone_destino,
            cidade,
            mensagem
        ) VALUES (
            p_processo_id,
            p_exigencia_id,
            'EXIGENCIA_DETECTADA',
            parceiro.telefone_whatsapp,
            v_cidade,
            v_mensagem
        ) RETURNING id INTO v_notif_id;
        
        RAISE NOTICE 'Notificação criada para % (%) - ID: %', parceiro.nome, parceiro.telefone_whatsapp, v_notif_id;
    END LOOP;

    RETURN v_notif_id;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- DADOS INICIAIS (EXEMPLO - AJUSTAR CONFORME NECESSÁRIO)
-- =====================================================

-- Parceiros de exemplo (substituir pelos reais)
INSERT INTO parceiros (nome, cidade, telefone_whatsapp, email, ativo) VALUES
('Parceiro Cândido Sales 1', 'CANDIDO SALES', '77999999999', 'parceiro1@exemplo.com', true),
('Parceiro Cândido Sales 2', 'CANDIDO SALES', '77988888888', 'parceiro2@exemplo.com', true),
('Parceiro Vitória da Conquista', 'VITORIA DA CONQUISTA', '77977777777', 'parceiro3@exemplo.com', true)
ON CONFLICT DO NOTHING;

-- =====================================================
-- COMENTÁRIOS E DOCUMENTAÇÃO
-- =====================================================

COMMENT ON TABLE parceiros IS 'Parceiros/colaboradores organizados por cidade';
COMMENT ON TABLE notificacoes_whatsapp IS 'Fila de mensagens WhatsApp para N8N consumir via API';
COMMENT ON TABLE tramitacao_sync_log IS 'Log de sincronização com Tramitação Inteligente';
COMMENT ON TABLE confirmacoes_documentos IS 'Rastreamento de envio e recebimento de documentos';

COMMENT ON COLUMN processos.cidade_parceiro IS 'Cidade do parceiro (usado como etiqueta no Tramitação)';
COMMENT ON COLUMN processos.email_unico_tramitacao IS 'Email exclusivo gerado pelo Tramitação (ex: nome@timail.com.br)';

COMMENT ON FUNCTION criar_notificacao_exigencia IS 'Cria notificação WhatsApp para todos os parceiros de uma cidade quando exigência é detectada';
