-- =====================================================
-- MIGRATION 017: Sistema de Agendamentos (Perícia e Avaliação Social)
-- =====================================================

-- Tabela para armazenar agendamentos extraídos do PAT
CREATE TABLE IF NOT EXISTS agendamentos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    processo_id UUID REFERENCES processos(id) ON DELETE CASCADE,
    protocolo_inss VARCHAR(50) NOT NULL,
    cpf_segurado VARCHAR(11) NOT NULL,
    tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('PERICIA', 'AVALIACAO_SOCIAL')),
    data_agendamento DATE NOT NULL,
    hora_agendamento VARCHAR(5) NOT NULL, -- Formato HH:mm
    unidade VARCHAR(200),
    endereco TEXT,
    status VARCHAR(20) NOT NULL CHECK (status IN ('AGENDADO', 'REMARCADO', 'CANCELADO', 'CUMPRIDO')),
    etapa VARCHAR(100), -- Ex: "Aguardando comparecimento"
    servico TEXT, -- Descrição do serviço
    url_comprovante TEXT, -- URL para baixar PDF do comprovante
    tramitacao_atividade_id INTEGER, -- ID da atividade criada no Tramitação
    ultimo_lembrete_30d TIMESTAMP, -- Último lembrete enviado (30 dias antes)
    ultimo_lembrete_7d TIMESTAMP, -- Último lembrete enviado (7 dias antes)
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Constraint UNIQUE para evitar duplicatas (mesmo processo, tipo e data)
CREATE UNIQUE INDEX IF NOT EXISTS idx_agendamentos_unique ON agendamentos(processo_id, tipo, data_agendamento);

-- Índices para busca eficiente
CREATE INDEX IF NOT EXISTS idx_agendamentos_processo ON agendamentos(processo_id);
CREATE INDEX IF NOT EXISTS idx_agendamentos_protocolo ON agendamentos(protocolo_inss);
CREATE INDEX IF NOT EXISTS idx_agendamentos_data ON agendamentos(data_agendamento);
CREATE INDEX IF NOT EXISTS idx_agendamentos_status ON agendamentos(status) WHERE status = 'AGENDADO';
CREATE INDEX IF NOT EXISTS idx_agendamentos_lembrete_30d ON agendamentos(data_agendamento, ultimo_lembrete_30d) 
    WHERE status = 'AGENDADO';
CREATE INDEX IF NOT EXISTS idx_agendamentos_lembrete_7d ON agendamentos(data_agendamento, ultimo_lembrete_7d) 
    WHERE status = 'AGENDADO';

-- Comentários
COMMENT ON TABLE agendamentos IS 'Agendamentos de Perícia Médica e Avaliação Social extraídos do PAT';
COMMENT ON COLUMN agendamentos.tramitacao_atividade_id IS 'ID da atividade criada no Tramitação (para atualização)';
COMMENT ON COLUMN agendamentos.ultimo_lembrete_30d IS 'Data do último lembrete enviado 30 dias antes';
COMMENT ON COLUMN agendamentos.ultimo_lembrete_7d IS 'Data do último lembrete enviado 7 dias antes';

