-- Migration: Sistema de Exigências Avançado + Email Único
-- Data: 2025-11-06

-- =====================================================
-- 1. Adicionar colunas nas tabelas existentes
-- =====================================================

-- Tabela processos: adicionar email único e complexidade
ALTER TABLE processos ADD COLUMN IF NOT EXISTS email_unico VARCHAR(100) UNIQUE;
ALTER TABLE processos ADD COLUMN IF NOT EXISTS complexidade_exigencia VARCHAR(20); -- 'SIMPLES', 'MEDIA', 'COMPLEXA'
ALTER TABLE processos ADD COLUMN IF NOT EXISTS exigencia_cumprida_em TIMESTAMP;
ALTER TABLE processos ADD COLUMN IF NOT EXISTS geraldo_removido_automaticamente BOOLEAN DEFAULT false;

COMMENT ON COLUMN processos.email_unico IS 'Email único para cliente enviar documentos automaticamente';
COMMENT ON COLUMN processos.complexidade_exigencia IS 'Complexidade da exigência atual: SIMPLES, MEDIA, COMPLEXA';
COMMENT ON COLUMN processos.exigencia_cumprida_em IS 'Timestamp de quando exigência foi cumprida';
COMMENT ON COLUMN processos.geraldo_removido_automaticamente IS 'Flag se GERALDO foi removido automaticamente às 17:30';

-- Criar índices para performance
CREATE INDEX IF NOT EXISTS idx_processos_email_unico ON processos(email_unico);
CREATE INDEX IF NOT EXISTS idx_processos_complexidade ON processos(complexidade_exigencia);
CREATE INDEX IF NOT EXISTS idx_exigencias_prazo ON exigencias(prazo_final) WHERE prazo_final IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_exigencias_status ON exigencias(status);

-- =====================================================
-- 2. Função: Gerar Email Único
-- =====================================================

CREATE OR REPLACE FUNCTION gerar_email_unico()
RETURNS TRIGGER AS $$
DECLARE
    base_email TEXT;
    random_suffix TEXT;
    novo_email TEXT;
    tentativas INT := 0;
    email_existe BOOLEAN := true;
BEGIN
    -- Se já tem email único, não fazer nada
    IF NEW.email_unico IS NOT NULL THEN
        RETURN NEW;
    END IF;

    -- Gerar base do email (primeiros 3 chars do CPF + 4 random)
    random_suffix := LPAD(FLOOR(RANDOM() * 10000)::TEXT, 4, '0');
    
    -- Loop até achar email único
    WHILE email_existe AND tentativas < 10 LOOP
        novo_email := 'docs.' || SUBSTRING(NEW.cpf FROM 1 FOR 3) || random_suffix || '@tramitacao.inss.app';
        
        -- Verificar se existe
        SELECT EXISTS(SELECT 1 FROM processos WHERE email_unico = novo_email) INTO email_existe;
        
        IF email_existe THEN
            tentativas := tentativas + 1;
            random_suffix := LPAD(FLOOR(RANDOM() * 10000)::TEXT, 4, '0');
        END IF;
    END LOOP;
    
    NEW.email_unico := novo_email;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger para gerar email único automaticamente
DROP TRIGGER IF EXISTS trigger_gerar_email_unico ON processos;
CREATE TRIGGER trigger_gerar_email_unico
    BEFORE INSERT ON processos
    FOR EACH ROW
    EXECUTE FUNCTION gerar_email_unico();

-- =====================================================
-- 3. Função: Auto-remover GERALDO às 17:30
-- =====================================================

CREATE OR REPLACE FUNCTION remover_geraldo_exigencias_cumpridas()
RETURNS TABLE(
    processo_id INTEGER,
    protocolo VARCHAR(50),
    tags_antigas TEXT[],
    tags_novas TEXT[]
) AS $$
DECLARE
    processo RECORD;
    novas_tags TEXT[];
BEGIN
    -- Buscar processos com:
    -- 1. Tag GERALDO presente
    -- 2. Tag EXIGÊNCIA ausente (foi cumprida)
    -- 3. Ainda não foi removido automaticamente hoje
    FOR processo IN
        SELECT p.id, p.protocolo, p.tags
        FROM processos p
        WHERE 'GERALDO' = ANY(p.tags)
          AND NOT ('EXIGÊNCIA' = ANY(p.tags))
          AND (p.geraldo_removido_automaticamente = false OR p.geraldo_removido_automaticamente IS NULL)
          AND p.updated_at::date = CURRENT_DATE
    LOOP
        -- Remover GERALDO das tags
        SELECT ARRAY_AGG(t) INTO novas_tags
        FROM UNNEST(processo.tags) AS t
        WHERE t != 'GERALDO';
        
        -- Atualizar processo
        UPDATE processos
        SET tags = novas_tags,
            geraldo_removido_automaticamente = true,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = processo.id;
        
        -- Retornar resultado
        processo_id := processo.id;
        protocolo := processo.protocolo;
        tags_antigas := processo.tags;
        tags_novas := novas_tags;
        
        RETURN NEXT;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION remover_geraldo_exigencias_cumpridas IS 'Remove tag GERALDO de processos onde exigência foi cumprida (rodar às 17:30)';

-- =====================================================
-- 4. Views: Dashboard de Alertas
-- =====================================================

-- View: Exigências vencendo por período
CREATE OR REPLACE VIEW vw_exigencias_vencendo AS
SELECT 
    e.id,
    e.processo_id,
    p.protocolo,
    p.nome_cliente,
    p.cpf,
    p.servico,
    p.status,
    p.tags,
    p.email_unico,
    p.complexidade_exigencia,
    e.tipo,
    e.descricao,
    e.prazo_final,
    e.status as exigencia_status,
    -- Calcular dias restantes
    (e.prazo_final::date - CURRENT_DATE) as dias_restantes,
    -- Classificar urgência
    CASE
        WHEN e.prazo_final::date < CURRENT_DATE THEN 'VENCIDA'
        WHEN e.prazo_final::date = CURRENT_DATE THEN 'HOJE'
        WHEN (e.prazo_final::date - CURRENT_DATE) <= 3 THEN 'URGENTE (3 dias)'
        WHEN (e.prazo_final::date - CURRENT_DATE) <= 5 THEN 'ALTA (5 dias)'
        WHEN (e.prazo_final::date - CURRENT_DATE) <= 10 THEN 'MEDIA (10 dias)'
        WHEN (e.prazo_final::date - CURRENT_DATE) <= 15 THEN 'NORMAL (15 dias)'
        WHEN (e.prazo_final::date - CURRENT_DATE) <= 30 THEN 'BAIXA (30 dias)'
        ELSE 'PRAZO_LONGO'
    END as urgencia,
    e.created_at,
    e.updated_at
FROM exigencias e
JOIN processos p ON e.processo_id = p.id
WHERE e.status = 'pendente'
  AND e.prazo_final IS NOT NULL
  AND e.prazo_final::date <= CURRENT_DATE + INTERVAL '30 days'
ORDER BY e.prazo_final ASC;

COMMENT ON VIEW vw_exigencias_vencendo IS 'Dashboard de exigências com urgência calculada';

-- View: Benefícios concedidos (últimos 30 dias)
CREATE OR REPLACE VIEW vw_beneficios_concedidos AS
SELECT 
    p.id,
    p.protocolo,
    p.nome_cliente,
    p.cpf,
    p.servico,
    p.status,
    p.tags,
    p.tramitacao_cliente_id,
    p.updated_at as data_concessao
FROM processos p
WHERE (p.status ILIKE '%defer%' AND p.status NOT ILIKE '%indefer%')
   OR 'DEFERIDO' = ANY(p.tags)
   OR 'CONCLUÍDO' = ANY(p.tags)
ORDER BY p.updated_at DESC
LIMIT 100;

COMMENT ON VIEW vw_beneficios_concedidos IS 'Benefícios concedidos recentemente';

-- View: Benefícios indeferidos (últimos 30 dias)
CREATE OR REPLACE VIEW vw_beneficios_indeferidos AS
SELECT 
    p.id,
    p.protocolo,
    p.nome_cliente,
    p.cpf,
    p.servico,
    p.status,
    p.tags,
    p.tramitacao_cliente_id,
    -- Classificar tipo de indeferimento
    CASE
        WHEN 'INDEFERIDO (DAR ENTRADA NOVAMENTE)' = ANY(p.tags) THEN 'CLIENTE'
        WHEN 'INDEFERIDO (DAR ENTRADA JUDICIAL)' = ANY(p.tags) THEN 'CRITERIO_INSS'
        WHEN p.status ILIKE '%indefer%' THEN 'NAO_CLASSIFICADO'
        ELSE 'OUTRO'
    END as tipo_indeferimento,
    p.updated_at as data_indeferimento
FROM processos p
WHERE p.status ILIKE '%indefer%'
   OR 'INDEFERIDO' = ANY(p.tags)
ORDER BY p.updated_at DESC
LIMIT 100;

COMMENT ON VIEW vw_beneficios_indeferidos IS 'Benefícios indeferidos com tipo classificado';

-- View: Resumo do Dashboard
CREATE OR REPLACE VIEW vw_dashboard_resumo AS
SELECT
    (SELECT COUNT(*) FROM vw_exigencias_vencendo WHERE urgencia = 'VENCIDA') as exigencias_vencidas,
    (SELECT COUNT(*) FROM vw_exigencias_vencendo WHERE urgencia = 'HOJE') as exigencias_hoje,
    (SELECT COUNT(*) FROM vw_exigencias_vencendo WHERE urgencia LIKE 'URGENTE%') as exigencias_3_dias,
    (SELECT COUNT(*) FROM vw_exigencias_vencendo WHERE urgencia LIKE 'ALTA%') as exigencias_5_dias,
    (SELECT COUNT(*) FROM vw_exigencias_vencendo WHERE urgencia LIKE 'MEDIA%') as exigencias_10_dias,
    (SELECT COUNT(*) FROM vw_exigencias_vencendo WHERE urgencia LIKE 'NORMAL%') as exigencias_15_dias,
    (SELECT COUNT(*) FROM vw_exigencias_vencendo WHERE urgencia LIKE 'BAIXA%') as exigencias_30_dias,
    (SELECT COUNT(*) FROM vw_beneficios_concedidos) as total_concedidos,
    (SELECT COUNT(*) FROM vw_beneficios_indeferidos) as total_indeferidos,
    (SELECT COUNT(*) FROM processos WHERE 'GERALDO' = ANY(tags) AND 'EXIGÊNCIA' = ANY(tags)) as exigencias_pendentes_geraldo;

COMMENT ON VIEW vw_dashboard_resumo IS 'Resumo executivo do dashboard';

-- =====================================================
-- 5. Função: Classificar Complexidade de Exigência (IA)
-- =====================================================

CREATE OR REPLACE FUNCTION classificar_complexidade_exigencia(descricao_exigencia TEXT)
RETURNS VARCHAR(20) AS $$
DECLARE
    palavras_simples TEXT[] := ARRAY[
        'autodeclaração', 'autodeclaracao', 
        'assinar', 'preencher formulário', 'preencher formulario',
        'comparecer', 'agendar', 'confirmar'
    ];
    palavras_complexas TEXT[] := ARRAY[
        'documento', 'certidão', 'certidao', 'atestado',
        'laudo', 'perícia', 'pericia', 'atualizar cad único', 'atualizar cad unico',
        'registro civil', 'cartório', 'cartorio', 'junta comercial'
    ];
    palavras_multiplas TEXT[] := ARRAY['e ', ', ', ';', 'também', 'tambem', 'além', 'alem'];
    
    contagem_simples INT := 0;
    contagem_complexas INT := 0;
    contagem_multiplas INT := 0;
    palavra TEXT;
BEGIN
    IF descricao_exigencia IS NULL OR LENGTH(TRIM(descricao_exigencia)) < 10 THEN
        RETURN 'SIMPLES';
    END IF;
    
    -- Contar palavras-chave
    FOREACH palavra IN ARRAY palavras_simples LOOP
        IF LOWER(descricao_exigencia) LIKE '%' || palavra || '%' THEN
            contagem_simples := contagem_simples + 1;
        END IF;
    END LOOP;
    
    FOREACH palavra IN ARRAY palavras_complexas LOOP
        IF LOWER(descricao_exigencia) LIKE '%' || palavra || '%' THEN
            contagem_complexas := contagem_complexas + 1;
        END IF;
    END LOOP;
    
    FOREACH palavra IN ARRAY palavras_multiplas LOOP
        IF LOWER(descricao_exigencia) LIKE '%' || palavra || '%' THEN
            contagem_multiplas := contagem_multiplas + 1;
        END IF;
    END LOOP;
    
    -- Classificar
    IF contagem_complexas >= 3 OR contagem_multiplas >= 2 THEN
        RETURN 'COMPLEXA';
    ELSIF contagem_complexas >= 1 OR contagem_multiplas = 1 THEN
        RETURN 'MEDIA';
    ELSE
        RETURN 'SIMPLES';
    END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMENT ON FUNCTION classificar_complexidade_exigencia IS 'Classifica complexidade baseado em palavras-chave';

-- Trigger para classificar automaticamente ao inserir exigência
CREATE OR REPLACE FUNCTION trigger_classificar_complexidade()
RETURNS TRIGGER AS $$
BEGIN
    -- Atualizar complexidade no processo
    UPDATE processos
    SET complexidade_exigencia = classificar_complexidade_exigencia(NEW.descricao)
    WHERE id = NEW.processo_id;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_auto_classificar_complexidade ON exigencias;
CREATE TRIGGER trigger_auto_classificar_complexidade
    AFTER INSERT OR UPDATE ON exigencias
    FOR EACH ROW
    WHEN (NEW.tipo = 'exigencia')
    EXECUTE FUNCTION trigger_classificar_complexidade();

-- =====================================================
-- 6. Função: Sincronizar Tags com Tramitação
-- =====================================================

CREATE OR REPLACE FUNCTION sincronizar_tags_tramitacao(
    p_processo_id INTEGER,
    p_novas_tags TEXT[]
)
RETURNS JSONB AS $$
DECLARE
    processo RECORD;
    tags_adicionadas TEXT[];
    tags_removidas TEXT[];
    resultado JSONB;
BEGIN
    -- Buscar processo atual
    SELECT * INTO processo FROM processos WHERE id = p_processo_id;
    
    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Processo não encontrado'
        );
    END IF;
    
    -- Calcular diferenças
    SELECT ARRAY_AGG(t) INTO tags_adicionadas
    FROM UNNEST(p_novas_tags) AS t
    WHERE NOT (t = ANY(processo.tags));
    
    SELECT ARRAY_AGG(t) INTO tags_removidas
    FROM UNNEST(processo.tags) AS t
    WHERE NOT (t = ANY(p_novas_tags));
    
    -- Atualizar processo
    UPDATE processos
    SET tags = p_novas_tags,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = p_processo_id;
    
    -- Retornar resultado
    RETURN jsonb_build_object(
        'success', true,
        'processo_id', p_processo_id,
        'protocolo', processo.protocolo,
        'tags_antigas', processo.tags,
        'tags_novas', p_novas_tags,
        'tags_adicionadas', tags_adicionadas,
        'tags_removidas', tags_removidas
    );
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION sincronizar_tags_tramitacao IS 'Sincroniza tags entre sistema e Tramitação Inteligente';

-- =====================================================
-- 7. Criar tabela de logs de sincronização
-- =====================================================

CREATE TABLE IF NOT EXISTS logs_sincronizacao_tags (
    id SERIAL PRIMARY KEY,
    processo_id INTEGER REFERENCES processos(id),
    protocolo VARCHAR(50),
    tags_antigas TEXT[],
    tags_novas TEXT[],
    origem VARCHAR(50), -- 'INSS', 'TRAMITACAO', 'AUTO_GERALDO', 'MANUAL'
    usuario_id INTEGER REFERENCES usuarios(id),
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_logs_sincronizacao_processo ON logs_sincronizacao_tags(processo_id);
CREATE INDEX idx_logs_sincronizacao_timestamp ON logs_sincronizacao_tags(timestamp);

COMMENT ON TABLE logs_sincronizacao_tags IS 'Histórico de todas as mudanças de tags';

-- =====================================================
-- FINALIZADO
-- =====================================================

-- Testar views
SELECT 'Dashboard de Exigências:' as info;
SELECT urgencia, COUNT(*) as total FROM vw_exigencias_vencendo GROUP BY urgencia;

SELECT 'Resumo Executivo:' as info;
SELECT * FROM vw_dashboard_resumo;

SELECT 'Teste de Complexidade:' as info;
SELECT 
    classificar_complexidade_exigencia('Preencher autodeclaração rural') as simples,
    classificar_complexidade_exigencia('Atualizar certidão de casamento e documento de identidade') as media,
    classificar_complexidade_exigencia('Providenciar laudo médico, atualizar CAD Único, certidão de casamento, documento de identidade e comprovante de residência') as complexa;
