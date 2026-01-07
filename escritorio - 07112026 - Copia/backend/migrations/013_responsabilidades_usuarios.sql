-- =====================================================
-- MIGRATION 013: RESPONSABILIDADES POR USUÁRIO (CONFIGURÁVEL)
-- =====================================================
-- Remove hardcode de nomes (Geraldo/Ellen/Júlia/Ian)
-- Permite configurar responsabilidades por benefício + fase
-- Transferência de responsabilidades em 1 clique
-- =====================================================

-- 1) Tabela de benefícios padronizados
CREATE TABLE IF NOT EXISTS beneficios (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  nome TEXT NOT NULL,
  ativo BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Índice
CREATE INDEX IF NOT EXISTS idx_beneficios_slug ON beneficios(slug);

-- Popular benefícios padrão
INSERT INTO beneficios (slug, nome) VALUES
  ('bpc', 'BPC'),
  ('beneficio_incapacidade', 'Benefício por Incapacidade'),
  ('salario_maternidade_rural', 'Salário Maternidade Rural'),
  ('salario_maternidade_urbano', 'Salário Maternidade Urbano'),
  ('salario_maternidade', 'Salário Maternidade (Geral)'),
  ('aposentadoria_rural', 'Aposentadoria Rural'),
  ('aposentadoria_urbana', 'Aposentadoria Urbana'),
  ('aposentadoria_especial', 'Aposentadoria Especial'),
  ('aposentadoria', 'Aposentadoria (Geral)'),
  ('pensao', 'Pensão'),
  ('auxilio_reclusao', 'Auxílio Reclusão')
ON CONFLICT (slug) DO NOTHING;

-- 2) Enum de fase (se não existir)
DO $$ BEGIN
  CREATE TYPE fase_processo AS ENUM ('ADMINISTRATIVO','JUDICIAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3) Tabela de responsabilidades por usuário
CREATE TABLE IF NOT EXISTS usuario_responsabilidades (
  id SERIAL PRIMARY KEY,
  usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  
  -- Flags de macro-papel
  pode_administrativo BOOLEAN NOT NULL DEFAULT FALSE,
  pode_judicial BOOLEAN NOT NULL DEFAULT FALSE,
  responsavel_exigencia BOOLEAN NOT NULL DEFAULT FALSE,
  
  -- Escopo por benefício
  beneficio_id INTEGER NOT NULL REFERENCES beneficios(id),
  fase VARCHAR(20) NULL CHECK (fase IN ('ADMINISTRATIVO', 'JUDICIAL')),
  
  -- Ordem de prioridade (para desempate)
  prioridade INTEGER DEFAULT 0,
  
  created_at TIMESTAMP DEFAULT NOW(),
  
  UNIQUE(usuario_id, beneficio_id, fase)
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_ur_usuario ON usuario_responsabilidades(usuario_id);
CREATE INDEX IF NOT EXISTS idx_ur_beneficio ON usuario_responsabilidades(beneficio_id);
CREATE INDEX IF NOT EXISTS idx_ur_exigencia ON usuario_responsabilidades(responsavel_exigencia) WHERE responsavel_exigencia = TRUE;
CREATE INDEX IF NOT EXISTS idx_ur_fase ON usuario_responsabilidades(fase);

-- 4) View de lookup rápido
CREATE OR REPLACE VIEW v_responsavel_regra AS
SELECT
  u.id AS usuario_id,
  u.nome AS usuario_nome,
  u.email AS usuario_email,
  u.perfil AS usuario_perfil,
  ur.responsavel_exigencia,
  ur.pode_administrativo,
  ur.pode_judicial,
  b.slug AS beneficio_slug,
  b.nome AS beneficio_nome,
  ur.fase,
  ur.prioridade
FROM usuario_responsabilidades ur
JOIN usuarios u ON u.id = ur.usuario_id
JOIN beneficios b ON b.id = ur.beneficio_id
WHERE u.ativo = TRUE
ORDER BY ur.prioridade DESC, u.nome;

-- 5) Função para escolher responsável automaticamente
CREATE OR REPLACE FUNCTION escolher_responsavel(
  p_tipo_beneficio VARCHAR,
  p_fase VARCHAR,
  p_em_exigencia BOOLEAN DEFAULT FALSE
) RETURNS UUID AS $$
DECLARE
  v_responsavel_id UUID;
  v_beneficio_slug TEXT;
BEGIN
  -- Se está em exigência, pegar quem é responsável por exigências
  IF p_em_exigencia THEN
    SELECT usuario_id INTO v_responsavel_id
    FROM usuario_responsabilidades
    WHERE responsavel_exigencia = TRUE
    ORDER BY prioridade DESC, usuario_id
    LIMIT 1;
    
    RETURN v_responsavel_id;
  END IF;

  -- Normalizar tipo de benefício para slug
  v_beneficio_slug := CASE
    WHEN p_tipo_beneficio = 'BPC' THEN 'bpc'
    WHEN p_tipo_beneficio ILIKE '%INCAPACIDADE%' OR p_tipo_beneficio ILIKE '%AUX%DOENÇA%' THEN 'beneficio_incapacidade'
    WHEN p_tipo_beneficio ILIKE '%SALÁRIO MATERNIDADE%RURAL%' THEN 'salario_maternidade_rural'
    WHEN p_tipo_beneficio ILIKE '%SALÁRIO MATERNIDADE%URBANO%' THEN 'salario_maternidade_urbano'
    WHEN p_tipo_beneficio ILIKE '%SALÁRIO MATERNIDADE%' THEN 'salario_maternidade'
    WHEN p_tipo_beneficio ILIKE '%APOSENTADORIA%RURAL%' THEN 'aposentadoria_rural'
    WHEN p_tipo_beneficio ILIKE '%APOSENTADORIA%URBANA%' THEN 'aposentadoria_urbana'
    WHEN p_tipo_beneficio ILIKE '%APOSENTADORIA%ESPECIAL%' THEN 'aposentadoria_especial'
    WHEN p_tipo_beneficio ILIKE '%APOSENTADORIA%' THEN 'aposentadoria'
    WHEN p_tipo_beneficio ILIKE '%PENSÃO%' THEN 'pensao'
    WHEN p_tipo_beneficio ILIKE '%RECLUSÃO%' THEN 'auxilio_reclusao'
    ELSE NULL
  END;

  -- Se não mapeou, tentar genérico 'aposentadoria' ou NULL
  IF v_beneficio_slug IS NULL THEN
    RAISE NOTICE 'Benefício não mapeado: %. Tentando fallback.', p_tipo_beneficio;
    v_beneficio_slug := 'aposentadoria';
  END IF;

  -- Buscar responsável baseado em benefício + fase
  SELECT ur.usuario_id INTO v_responsavel_id
  FROM usuario_responsabilidades ur
  JOIN beneficios b ON b.id = ur.beneficio_id
  WHERE b.slug = v_beneficio_slug
    AND (ur.fase IS NULL OR ur.fase = p_fase)
    AND (
      (p_fase = 'ADMINISTRATIVO' AND ur.pode_administrativo = TRUE)
      OR (p_fase = 'JUDICIAL' AND ur.pode_judicial = TRUE)
    )
  ORDER BY ur.prioridade DESC, ur.usuario_id
  LIMIT 1;

  RETURN v_responsavel_id;
END;
$$ LANGUAGE plpgsql;

-- 6) Atualizar trigger de atribuição automática
CREATE OR REPLACE FUNCTION trigger_atualizar_responsaveis()
RETURNS TRIGGER AS $$
DECLARE
  v_em_exigencia BOOLEAN;
BEGIN
  -- Verificar se está em exigência
  v_em_exigencia := NEW.status_fluxo IN (
    'EXIGENCIA_DETECTADA', 
    'CUMPRIMENTO_DE_EXIGENCIA',
    'SOLICITADO_CINTIA', 
    'CONTATO_COLABORADOR'
  );

  -- Escolher responsável baseado em configuração
  IF v_em_exigencia THEN
    -- Exigência: usar responsável configurado para exigências
    NEW.responsavel_atual_id := escolher_responsavel(NEW.tipo_beneficio, NEW.fase, TRUE);
    NEW.resp_exigencia_id := NEW.responsavel_atual_id;
  ELSE
    -- Não é exigência: usar responsável da fase
    IF NEW.fase = 'ADMINISTRATIVO' THEN
      NEW.resp_administrativo_id := escolher_responsavel(NEW.tipo_beneficio, 'ADMINISTRATIVO', FALSE);
      NEW.responsavel_atual_id := NEW.resp_administrativo_id;
    ELSE
      NEW.resp_judicial_id := escolher_responsavel(NEW.tipo_beneficio, 'JUDICIAL', FALSE);
      NEW.responsavel_atual_id := NEW.resp_judicial_id;
    END IF;
  END IF;

  -- Gerar etiquetas (mantém função anterior)
  NEW.etiquetas := gerar_etiquetas_processo(
    NEW.tipo_beneficio,
    NEW.status_fluxo,
    NEW.fase,
    NEW.classe_final
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Recriar trigger
DROP TRIGGER IF EXISTS trg_atualizar_responsaveis ON processos;
CREATE TRIGGER trg_atualizar_responsaveis
  BEFORE INSERT OR UPDATE OF status_fluxo, fase, tipo_beneficio, classe_final
  ON processos
  FOR EACH ROW
  EXECUTE FUNCTION trigger_atualizar_responsaveis();

-- 7) Popular responsabilidades da equipe atual (migração dos dados)
DO $$
DECLARE
  v_geraldo_id UUID;
  v_julia_id UUID;
  v_ellen_id UUID;
  v_ian_id UUID;
  v_bpc_id INT;
  v_bi_id INT;
  v_sm_id INT;
  v_apo_id INT;
  v_pen_id INT;
  v_rec_id INT;
BEGIN
  -- Buscar IDs dos usuários
  SELECT id INTO v_geraldo_id FROM usuarios WHERE email = 'geraldo@escritorio.com';
  SELECT id INTO v_julia_id FROM usuarios WHERE email = 'julia@escritorio.com';
  SELECT id INTO v_ellen_id FROM usuarios WHERE email = 'ellen@escritorio.com';
  SELECT id INTO v_ian_id FROM usuarios WHERE email = 'ian@escritorio.com';

  -- Buscar IDs dos benefícios
  SELECT id INTO v_bpc_id FROM beneficios WHERE slug = 'bpc';
  SELECT id INTO v_bi_id FROM beneficios WHERE slug = 'beneficio_incapacidade';
  SELECT id INTO v_sm_id FROM beneficios WHERE slug = 'salario_maternidade';
  SELECT id INTO v_apo_id FROM beneficios WHERE slug = 'aposentadoria';
  SELECT id INTO v_pen_id FROM beneficios WHERE slug = 'pensao';
  SELECT id INTO v_rec_id FROM beneficios WHERE slug = 'auxilio_reclusao';

  -- Geraldo: Responsável por exigências
  IF v_geraldo_id IS NOT NULL THEN
    INSERT INTO usuario_responsabilidades (usuario_id, beneficio_id, responsavel_exigencia, pode_administrativo, fase, prioridade)
    SELECT v_geraldo_id, id, TRUE, TRUE, 'ADMINISTRATIVO', 100
    FROM beneficios
    ON CONFLICT (usuario_id, beneficio_id, fase) DO UPDATE 
      SET responsavel_exigencia = TRUE, prioridade = 100;
  END IF;

  -- Júlia: BPC + BI (Administrativo)
  IF v_julia_id IS NOT NULL THEN
    INSERT INTO usuario_responsabilidades (usuario_id, beneficio_id, pode_administrativo, fase, prioridade) VALUES
      (v_julia_id, v_bpc_id, TRUE, 'ADMINISTRATIVO', 90),
      (v_julia_id, v_bi_id, TRUE, 'ADMINISTRATIVO', 90)
    ON CONFLICT (usuario_id, beneficio_id, fase) DO UPDATE SET prioridade = 90;
  END IF;

  -- Ellen: Outros benefícios (Administrativo) + Todos (Judicial)
  IF v_ellen_id IS NOT NULL THEN
    -- Administrativo: SM, Apo, Pensão, Reclusão
    INSERT INTO usuario_responsabilidades (usuario_id, beneficio_id, pode_administrativo, fase, prioridade) VALUES
      (v_ellen_id, v_sm_id, TRUE, 'ADMINISTRATIVO', 80),
      (v_ellen_id, v_apo_id, TRUE, 'ADMINISTRATIVO', 80),
      (v_ellen_id, v_pen_id, TRUE, 'ADMINISTRATIVO', 80),
      (v_ellen_id, v_rec_id, TRUE, 'ADMINISTRATIVO', 80)
    ON CONFLICT (usuario_id, beneficio_id, fase) DO UPDATE SET prioridade = 80;
    
    -- Judicial: Todos exceto BPC/BI (Ian pega esses)
    INSERT INTO usuario_responsabilidades (usuario_id, beneficio_id, pode_judicial, fase, prioridade)
    SELECT v_ellen_id, id, TRUE, 'JUDICIAL', 70
    FROM beneficios
    WHERE slug NOT IN ('bpc', 'beneficio_incapacidade')
    ON CONFLICT (usuario_id, beneficio_id, fase) DO UPDATE SET prioridade = 70;
  END IF;

  -- Ian: BPC + BI (Judicial)
  IF v_ian_id IS NOT NULL THEN
    INSERT INTO usuario_responsabilidades (usuario_id, beneficio_id, pode_judicial, fase, prioridade) VALUES
      (v_ian_id, v_bpc_id, TRUE, 'JUDICIAL', 90),
      (v_ian_id, v_bi_id, TRUE, 'JUDICIAL', 90)
    ON CONFLICT (usuario_id, beneficio_id, fase) DO UPDATE SET prioridade = 90;
  END IF;

  RAISE NOTICE 'Responsabilidades migradas com sucesso!';
END $$;

-- 8) Tabela de histórico de transferências
CREATE TABLE IF NOT EXISTS historico_transferencias (
  id SERIAL PRIMARY KEY,
  de_usuario_id UUID REFERENCES usuarios(id),
  para_usuario_id UUID NOT NULL REFERENCES usuarios(id),
  de_usuario_nome VARCHAR(255),
  para_usuario_nome VARCHAR(255) NOT NULL,
  tipo_transferencia VARCHAR(50) NOT NULL CHECK (tipo_transferencia IN ('EXIGENCIA','ADMINISTRATIVO','JUDICIAL','TODOS')),
  processos_afetados INTEGER DEFAULT 0,
  realizado_por_id UUID REFERENCES usuarios(id),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ht_de ON historico_transferencias(de_usuario_id);
CREATE INDEX IF NOT EXISTS idx_ht_para ON historico_transferencias(para_usuario_id);

-- =====================================================
-- COMENTÁRIOS
-- =====================================================

COMMENT ON TABLE beneficios IS 'Tipos de benefício padronizados do INSS';
COMMENT ON TABLE usuario_responsabilidades IS 'Matriz de responsabilidades por usuário/benefício/fase';
COMMENT ON COLUMN usuario_responsabilidades.responsavel_exigencia IS 'Se TRUE, assume processos em exigência';
COMMENT ON COLUMN usuario_responsabilidades.pode_administrativo IS 'Pode assumir processos na fase administrativa';
COMMENT ON COLUMN usuario_responsabilidades.pode_judicial IS 'Pode assumir processos na fase judicial';
COMMENT ON COLUMN usuario_responsabilidades.fase IS 'Fase específica (NULL = ambas)';
COMMENT ON COLUMN usuario_responsabilidades.prioridade IS 'Prioridade para desempate (maior = escolhido primeiro)';

COMMENT ON FUNCTION escolher_responsavel IS 'Escolhe responsável baseado em tipo benefício + fase + exigência (configurável)';
COMMENT ON VIEW v_responsavel_regra IS 'View de lookup rápido para responsabilidades';

COMMENT ON TABLE historico_transferencias IS 'Registro de transferências de responsabilidade entre usuários';
