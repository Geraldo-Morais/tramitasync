-- =====================================================
-- MIGRATION 012: SISTEMA DE RESPONSÁVEIS + ETIQUETAS
-- =====================================================

-- 1. Adicionar campos de responsáveis específicos por papel
ALTER TABLE processos 
ADD COLUMN IF NOT EXISTS responsavel_atual_id UUID REFERENCES usuarios(id),
ADD COLUMN IF NOT EXISTS resp_exigencia_id UUID REFERENCES usuarios(id),
ADD COLUMN IF NOT EXISTS resp_administrativo_id UUID REFERENCES usuarios(id),
ADD COLUMN IF NOT EXISTS resp_judicial_id UUID REFERENCES usuarios(id),
ADD COLUMN IF NOT EXISTS fase VARCHAR(20) DEFAULT 'ADMINISTRATIVO' CHECK (fase IN ('ADMINISTRATIVO', 'JUDICIAL')),
ADD COLUMN IF NOT EXISTS etiquetas TEXT[] DEFAULT '{}';

-- Index para buscar por etiquetas
CREATE INDEX IF NOT EXISTS idx_processos_etiquetas ON processos USING GIN(etiquetas);

-- 2. Mapear IDs dos usuários (pegar dinamicamente)
DO $$
DECLARE
  v_geraldo_id UUID;
  v_julia_id UUID;
  v_ellen_id UUID;
  v_ian_id UUID;
BEGIN
  -- Buscar IDs dos usuários
  SELECT id INTO v_geraldo_id FROM usuarios WHERE email = 'geraldo@escritorio.com';
  SELECT id INTO v_julia_id FROM usuarios WHERE email = 'julia@escritorio.com';
  SELECT id INTO v_ellen_id FROM usuarios WHERE email = 'ellen@escritorio.com';
  SELECT id INTO v_ian_id FROM usuarios WHERE email = 'ian@escritorio.com';

  -- Criar configuração de responsáveis (se não existir)
  CREATE TABLE IF NOT EXISTS config_responsaveis (
    id SERIAL PRIMARY KEY,
    papel VARCHAR(50) NOT NULL UNIQUE,
    usuario_id UUID REFERENCES usuarios(id),
    descricao TEXT,
    ativo BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW()
  );

  -- Inserir configurações
  INSERT INTO config_responsaveis (papel, usuario_id, descricao) VALUES
    ('EXIGENCIAS', v_geraldo_id, 'Responsável por todas as exigências (cumprimento no PAT)'),
    ('ADM_BPC_BI', v_julia_id, 'Administrativo: BPC + Benefício Incapacidade'),
    ('ADM_OUTROS', v_ellen_id, 'Administrativo: Aposentadorias, Pensão, Aux Reclusão, Salário Maternidade'),
    ('JUDICIAL_BPC_BI', v_ian_id, 'Judicial: BPC + Benefício Incapacidade'),
    ('JUDICIAL_OUTROS', v_ellen_id, 'Judicial: Todos os demais benefícios')
  ON CONFLICT (papel) DO UPDATE 
    SET usuario_id = EXCLUDED.usuario_id, 
        descricao = EXCLUDED.descricao;
END $$;

-- 3. Função para determinar responsável baseado em tipo benefício + fase
CREATE OR REPLACE FUNCTION obter_responsavel_por_regra(
  p_tipo_beneficio VARCHAR,
  p_fase VARCHAR
) RETURNS UUID AS $$
DECLARE
  v_responsavel_id UUID;
  v_papel VARCHAR;
BEGIN
  -- Determinar papel baseado em benefício + fase
  IF p_tipo_beneficio IN ('BPC', 'AUX DOENÇA', 'BENEFICIO INCAPACIDADE') THEN
    -- BPC ou Benefício Incapacidade
    IF p_fase = 'ADMINISTRATIVO' THEN
      v_papel := 'ADM_BPC_BI';
    ELSE
      v_papel := 'JUDICIAL_BPC_BI';
    END IF;
  ELSE
    -- Outros benefícios
    IF p_fase = 'ADMINISTRATIVO' THEN
      v_papel := 'ADM_OUTROS';
    ELSE
      v_papel := 'JUDICIAL_OUTROS';
    END IF;
  END IF;

  -- Buscar responsável configurado
  SELECT usuario_id INTO v_responsavel_id
  FROM config_responsaveis
  WHERE papel = v_papel AND ativo = true;

  RETURN v_responsavel_id;
END;
$$ LANGUAGE plpgsql;

-- 4. Função para gerar etiquetas automaticamente
CREATE OR REPLACE FUNCTION gerar_etiquetas_processo(
  p_tipo_beneficio VARCHAR,
  p_status_fluxo VARCHAR,
  p_fase VARCHAR,
  p_classe_final VARCHAR DEFAULT NULL
) RETURNS TEXT[] AS $$
DECLARE
  v_etiquetas TEXT[] := '{}';
  v_tag_beneficio TEXT;
BEGIN
  -- Etiqueta de benefício (normalizada)
  v_tag_beneficio := CASE 
    WHEN p_tipo_beneficio = 'BPC' THEN 'BPC'
    WHEN p_tipo_beneficio ILIKE '%SALÁRIO MATERNIDADE%' AND p_tipo_beneficio ILIKE '%RURAL%' THEN 'SALÁRIO MATERNIDADE RURAL'
    WHEN p_tipo_beneficio ILIKE '%SALÁRIO MATERNIDADE%' AND p_tipo_beneficio ILIKE '%URBANO%' THEN 'SALÁRIO MATERNIDADE URBANO'
    WHEN p_tipo_beneficio ILIKE '%SALÁRIO MATERNIDADE%' THEN 'SALÁRIO MATERNIDADE'
    WHEN p_tipo_beneficio ILIKE '%APOSENTADORIA%' AND p_tipo_beneficio ILIKE '%RURAL%' THEN 'APOSENTADORIA RURAL'
    WHEN p_tipo_beneficio ILIKE '%APOSENTADORIA%' AND p_tipo_beneficio ILIKE '%URBANA%' THEN 'APOSENTADORIA URBANA'
    WHEN p_tipo_beneficio ILIKE '%APOSENTADORIA%' AND p_tipo_beneficio ILIKE '%ESPECIAL%' THEN 'APOSENTADORIA ESPECIAL'
    WHEN p_tipo_beneficio ILIKE '%APOSENTADORIA%' THEN 'APOSENTADORIA'
    WHEN p_tipo_beneficio ILIKE '%PENSÃO%' THEN 'PENSÃO'
    WHEN p_tipo_beneficio ILIKE '%AUX%DOENÇA%' OR p_tipo_beneficio ILIKE '%INCAPACIDADE%' THEN 'BENEFÍCIO INCAPACIDADE'
    WHEN p_tipo_beneficio ILIKE '%RECLUSÃO%' THEN 'AUXÍLIO RECLUSÃO'
    ELSE UPPER(p_tipo_beneficio)
  END;
  
  v_etiquetas := array_append(v_etiquetas, v_tag_beneficio);

  -- Etiqueta de fase
  v_etiquetas := array_append(v_etiquetas, p_fase);

  -- Etiquetas de status
  IF p_status_fluxo = 'EXIGENCIA_DETECTADA' OR p_status_fluxo LIKE '%EXIGENCIA%' THEN
    v_etiquetas := array_append(v_etiquetas, 'EXIGÊNCIA');
  END IF;

  IF p_status_fluxo = 'DOCUMENTO_RECEBIDO' THEN
    v_etiquetas := array_append(v_etiquetas, 'DOCUMENTOS ENTREGUES');
  END IF;

  IF p_status_fluxo ILIKE '%ANALISE%' THEN
    v_etiquetas := array_append(v_etiquetas, 'EM ANÁLISE');
  END IF;

  -- Etiquetas de resultado
  IF p_classe_final = 'DEFERIDO' THEN
    v_etiquetas := array_append(v_etiquetas, 'DEFERIDO');
  ELSIF p_classe_final = 'INDEFERIDO' THEN
    v_etiquetas := array_append(v_etiquetas, 'INDEFERIDO');
  END IF;

  RETURN v_etiquetas;
END;
$$ LANGUAGE plpgsql;

-- 5. Trigger para atualizar responsáveis automaticamente
CREATE OR REPLACE FUNCTION trigger_atualizar_responsaveis()
RETURNS TRIGGER AS $$
DECLARE
  v_geraldo_id UUID;
BEGIN
  -- Buscar Geraldo (responsável exigências)
  SELECT usuario_id INTO v_geraldo_id 
  FROM config_responsaveis 
  WHERE papel = 'EXIGENCIAS' AND ativo = true;

  -- Se entrou em exigência, Geraldo assume
  IF NEW.status_fluxo IN ('EXIGENCIA_DETECTADA', 'CUMPRIMENTO_DE_EXIGENCIA', 
                          'SOLICITADO_CINTIA', 'CONTATO_COLABORADOR') THEN
    NEW.responsavel_atual_id := v_geraldo_id;
    NEW.resp_exigencia_id := v_geraldo_id;
  ELSE
    -- Caso contrário, atribuir baseado em fase + benefício
    IF NEW.fase = 'ADMINISTRATIVO' THEN
      NEW.resp_administrativo_id := obter_responsavel_por_regra(NEW.tipo_beneficio, 'ADMINISTRATIVO');
      NEW.responsavel_atual_id := NEW.resp_administrativo_id;
    ELSE
      NEW.resp_judicial_id := obter_responsavel_por_regra(NEW.tipo_beneficio, 'JUDICIAL');
      NEW.responsavel_atual_id := NEW.resp_judicial_id;
    END IF;
  END IF;

  -- Gerar etiquetas automaticamente
  NEW.etiquetas := gerar_etiquetas_processo(
    NEW.tipo_beneficio, 
    NEW.status_fluxo, 
    NEW.fase, 
    NEW.classe_final
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Criar trigger
DROP TRIGGER IF EXISTS trg_atualizar_responsaveis ON processos;
CREATE TRIGGER trg_atualizar_responsaveis
  BEFORE INSERT OR UPDATE OF status_fluxo, fase, tipo_beneficio, classe_final
  ON processos
  FOR EACH ROW
  EXECUTE FUNCTION trigger_atualizar_responsaveis();

-- 6. Atualizar processos existentes
UPDATE processos
SET 
  fase = CASE 
    WHEN status_fluxo = 'ENCAMINHADO_JUDICIAL' THEN 'JUDICIAL'
    ELSE 'ADMINISTRATIVO'
  END,
  responsavel_atual_id = responsavel_id
WHERE responsavel_atual_id IS NULL;

-- Aplicar trigger em processos existentes
UPDATE processos SET updated_at = NOW();

-- =====================================================
-- COMENTÁRIOS
-- =====================================================

COMMENT ON COLUMN processos.responsavel_atual_id IS 'Responsável ativo atual (muda conforme status/fase)';
COMMENT ON COLUMN processos.resp_exigencia_id IS 'Responsável por exigências (sempre Geraldo)';
COMMENT ON COLUMN processos.resp_administrativo_id IS 'Responsável na fase administrativa';
COMMENT ON COLUMN processos.resp_judicial_id IS 'Responsável na fase judicial';
COMMENT ON COLUMN processos.fase IS 'Fase atual: ADMINISTRATIVO ou JUDICIAL';
COMMENT ON COLUMN processos.etiquetas IS 'Array de etiquetas sincronizadas com Tramitação';

COMMENT ON FUNCTION obter_responsavel_por_regra IS 'Retorna UUID do responsável baseado em tipo benefício + fase';
COMMENT ON FUNCTION gerar_etiquetas_processo IS 'Gera array de etiquetas padronizadas para sincronização';
COMMENT ON TABLE config_responsaveis IS 'Configuração centralizada de responsáveis por papel/benefício';
