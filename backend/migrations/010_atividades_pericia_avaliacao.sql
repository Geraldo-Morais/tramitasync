-- ============================================
-- MIGRATION 010: ATIVIDADES (PERÍCIA E AVALIAÇÃO SOCIAL)
-- ============================================
-- Data: 2025-11-10
-- Descrição: Adiciona tabelas para gerenciar agendamentos de perícia e avaliação social
-- ============================================

-- Tabela de Atividades (Perícia/Avaliação Social)
CREATE TABLE IF NOT EXISTS atividades (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    processo_id UUID NOT NULL REFERENCES processos(id) ON DELETE CASCADE,
    
    -- Tipo de atividade
    tipo VARCHAR(50) NOT NULL CHECK (tipo IN ('PERICIA', 'AVALIACAO_SOCIAL')),
    
    -- Status/Etapa
    etapa VARCHAR(100) NOT NULL, -- Ex: "Aguardando comparecimento", "Aguardando agendamento"
    status_agendamento VARCHAR(50) NOT NULL DEFAULT 'PENDENTE' 
        CHECK (status_agendamento IN ('PENDENTE', 'AGENDADO', 'CANCELADO', 'REMARCADO', 'REALIZADO', 'NAO_COMPARECEU')),
    
    -- Dados do Agendamento
    data_hora_agendamento TIMESTAMP WITH TIME ZONE,
    unidade_atendimento VARCHAR(255), -- Ex: "APS VITÓRIA DA CONQUISTA"
    endereco_unidade TEXT,
    
    -- Observações e detalhes
    observacoes TEXT,
    motivo_cancelamento TEXT,
    
    -- Comprovante (caminho do arquivo baixado)
    comprovante_url TEXT,
    comprovante_path TEXT, -- Caminho local após download
    
    -- Metadados do INSS
    id_agendamento_inss VARCHAR(100), -- ID único do agendamento no sistema INSS
    
    -- Auditoria
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_by UUID REFERENCES usuarios(id),
    
    -- Índices
    CONSTRAINT uk_processo_tipo_agendado UNIQUE NULLS NOT DISTINCT (processo_id, tipo, status_agendamento, data_hora_agendamento)
);

-- Índices para melhor performance
CREATE INDEX idx_atividades_processo_id ON atividades(processo_id);
CREATE INDEX idx_atividades_tipo ON atividades(tipo);
CREATE INDEX idx_atividades_status ON atividades(status_agendamento);
CREATE INDEX idx_atividades_data_agendamento ON atividades(data_hora_agendamento);
CREATE INDEX idx_atividades_etapa ON atividades(etapa);

-- Trigger para atualizar updated_at
CREATE OR REPLACE FUNCTION update_atividades_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_atividades_timestamp
    BEFORE UPDATE ON atividades
    FOR EACH ROW
    EXECUTE FUNCTION update_atividades_timestamp();

-- Comentários
COMMENT ON TABLE atividades IS 'Tabela de atividades relacionadas aos processos (perícia médica e avaliação social)';
COMMENT ON COLUMN atividades.tipo IS 'Tipo de atividade: PERICIA ou AVALIACAO_SOCIAL';
COMMENT ON COLUMN atividades.etapa IS 'Etapa atual da atividade no sistema INSS';
COMMENT ON COLUMN atividades.status_agendamento IS 'Status do agendamento: PENDENTE, AGENDADO, CANCELADO, REMARCADO, REALIZADO, NAO_COMPARECEU';
COMMENT ON COLUMN atividades.data_hora_agendamento IS 'Data e hora do agendamento (pode ser NULL se status=PENDENTE)';
COMMENT ON COLUMN atividades.unidade_atendimento IS 'Nome da unidade onde será realizada a atividade';
COMMENT ON COLUMN atividades.comprovante_path IS 'Caminho local do comprovante baixado automaticamente';

-- Dados de exemplo (opcional - remover em produção)
-- INSERT INTO atividades (processo_id, tipo, etapa, status_agendamento, data_hora_agendamento, unidade_atendimento)
-- SELECT 
--     id,
--     'PERICIA',
--     'Aguardando comparecimento',
--     'AGENDADO',
--     '2026-02-20 09:10:00-03',
--     'APS VITÓRIA DA CONQUISTA'
-- FROM processos 
-- WHERE protocolo_inss LIKE '87%' -- Benefícios por incapacidade
-- LIMIT 1;
