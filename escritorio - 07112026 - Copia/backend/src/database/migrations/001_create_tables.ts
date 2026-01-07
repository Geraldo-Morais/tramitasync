import database from '../index';
import logger from '../../utils/logger';

export async function createUsuariosTable(): Promise<void> {
    const query = `
    CREATE TABLE IF NOT EXISTS usuarios (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      nome VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      senha VARCHAR(255) NOT NULL,
      perfil VARCHAR(50) NOT NULL CHECK (perfil IN ('admin', 'secretaria', 'administrativo', 'intermediacao', 'judicial')),
      ativo BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios(email);
    CREATE INDEX IF NOT EXISTS idx_usuarios_perfil ON usuarios(perfil);
  `;

    try {
        await database.query(query);
        logger.info('✅ Tabela usuarios criada');
    } catch (error) {
        logger.error('❌ Erro ao criar tabela usuarios', error);
        throw error;
    }
}

export async function createProcessosTable(): Promise<void> {
    const query = `
    CREATE TABLE IF NOT EXISTS processos (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      cpf_segurado VARCHAR(14) NOT NULL,
      nome_segurado VARCHAR(255) NOT NULL,
      protocolo_inss VARCHAR(50) UNIQUE NOT NULL,
      der DATE NOT NULL,
      status_inss VARCHAR(50) NOT NULL CHECK (status_inss IN ('PENDENTE', 'EM_ANALISE', 'CUMPRIMENTO_DE_EXIGENCIA', 'CONCLUIDA', 'CANCELADA')),
      status_fluxo VARCHAR(50) NOT NULL DEFAULT 'NOVO' CHECK (status_fluxo IN ('NOVO', 'EXIGENCIA_DETECTADA', 'SOLICITADO_CINTIA', 'CONTATO_COLABORADOR', 'DOCUMENTO_RECEBIDO', 'DOCUMENTO_ANEXADO', 'CONCLUIDO', 'CANCELADO', 'ENCAMINHADO_JUDICIAL')),
      tipo_beneficio VARCHAR(50) NOT NULL CHECK (tipo_beneficio IN ('BPC', 'SALÁRIO MATERNIDADE', 'PENSÃO', 'APOSENTADORIAS', 'AUX DOENÇA')),
      classe_final VARCHAR(50) CHECK (classe_final IN ('DEFERIDO', 'INDEFERIDO', 'DUPLICADO', 'CANCELADO', 'PENDENTE')),
      motivo_inss TEXT,
      data_conclusao DATE,
      responsavel_id UUID REFERENCES usuarios(id) ON DELETE SET NULL,
      tramitacao_cliente_id INTEGER,
      tramitacao_cliente_uuid UUID,
      dt_ultima_verificacao TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_processos_cpf ON processos(cpf_segurado);
    CREATE INDEX IF NOT EXISTS idx_processos_protocolo ON processos(protocolo_inss);
    CREATE INDEX IF NOT EXISTS idx_processos_status_inss ON processos(status_inss);
    CREATE INDEX IF NOT EXISTS idx_processos_status_fluxo ON processos(status_fluxo);
    CREATE INDEX IF NOT EXISTS idx_processos_tipo ON processos(tipo_beneficio);
    CREATE INDEX IF NOT EXISTS idx_processos_der ON processos(der);
    CREATE INDEX IF NOT EXISTS idx_processos_responsavel ON processos(responsavel_id);
  `;

    try {
        await database.query(query);
        logger.info('✅ Tabela processos criada');
    } catch (error) {
        logger.error('❌ Erro ao criar tabela processos', error);
        throw error;
    }
}

export async function createExigenciasTable(): Promise<void> {
    const query = `
    CREATE TABLE IF NOT EXISTS exigencias (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      processo_id UUID NOT NULL REFERENCES processos(id) ON DELETE CASCADE,
      data_abertura DATE NOT NULL,
      prazo DATE NOT NULL,
      resumo_exigencia TEXT NOT NULL,
      itens_pendentes TEXT[] DEFAULT '{}',
      status VARCHAR(50) NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE', 'EM_ANDAMENTO', 'CUMPRIDA', 'VENCIDA')),
      tramitacao_nota_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_exigencias_processo ON exigencias(processo_id);
    CREATE INDEX IF NOT EXISTS idx_exigencias_status ON exigencias(status);
    CREATE INDEX IF NOT EXISTS idx_exigencias_prazo ON exigencias(prazo);
  `;

    try {
        await database.query(query);
        logger.info('✅ Tabela exigencias criada');
    } catch (error) {
        logger.error('❌ Erro ao criar tabela exigencias', error);
        throw error;
    }
}

export async function createHistoricoStatusTable(): Promise<void> {
    const query = `
    CREATE TABLE IF NOT EXISTS historico_status (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      processo_id UUID NOT NULL REFERENCES processos(id) ON DELETE CASCADE,
      status_anterior VARCHAR(50) NOT NULL,
      status_novo VARCHAR(50) NOT NULL,
      tipo VARCHAR(50) NOT NULL CHECK (tipo IN ('STATUS_INSS', 'STATUS_FLUXO')),
      observacao TEXT,
      usuario_id UUID REFERENCES usuarios(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_historico_processo ON historico_status(processo_id);
    CREATE INDEX IF NOT EXISTS idx_historico_created ON historico_status(created_at DESC);
  `;

    try {
        await database.query(query);
        logger.info('✅ Tabela historico_status criada');
    } catch (error) {
        logger.error('❌ Erro ao criar tabela historico_status', error);
        throw error;
    }
}

export async function createProcessosJudiciaisTable(): Promise<void> {
    const query = `
    CREATE TABLE IF NOT EXISTS processos_judiciais (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      processo_id UUID NOT NULL REFERENCES processos(id) ON DELETE CASCADE,
      numero_judicial VARCHAR(50) NOT NULL,
      data_entrada_justica DATE NOT NULL,
      vara VARCHAR(255),
      comarca VARCHAR(255),
      observacoes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_processos_judiciais_processo ON processos_judiciais(processo_id);
    CREATE INDEX IF NOT EXISTS idx_processos_judiciais_numero ON processos_judiciais(numero_judicial);
  `;

    try {
        await database.query(query);
        logger.info('✅ Tabela processos_judiciais criada');
    } catch (error) {
        logger.error('❌ Erro ao criar tabela processos_judiciais', error);
        throw error;
    }
}

export async function createNotificacoesTable(): Promise<void> {
    const query = `
    CREATE TABLE IF NOT EXISTS notificacoes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      processo_id UUID NOT NULL REFERENCES processos(id) ON DELETE CASCADE,
      tipo VARCHAR(50) NOT NULL CHECK (tipo IN ('MUDANCA_STATUS', 'EXIGENCIA', 'PRAZO_VENCENDO', 'PRAZO_VENCIDO')),
      mensagem TEXT NOT NULL,
      lida BOOLEAN DEFAULT false,
      usuario_id UUID REFERENCES usuarios(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_notificacoes_processo ON notificacoes(processo_id);
    CREATE INDEX IF NOT EXISTS idx_notificacoes_usuario ON notificacoes(usuario_id);
    CREATE INDEX IF NOT EXISTS idx_notificacoes_lida ON notificacoes(lida);
    CREATE INDEX IF NOT EXISTS idx_notificacoes_created ON notificacoes(created_at DESC);
  `;

    try {
        await database.query(query);
        logger.info('✅ Tabela notificacoes criada');
    } catch (error) {
        logger.error('❌ Erro ao criar tabela notificacoes', error);
        throw error;
    }
}

export async function createWebhookLogsTable(): Promise<void> {
    const query = `
    CREATE TABLE IF NOT EXISTS webhook_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_type VARCHAR(100) NOT NULL,
      idempotency_key VARCHAR(255) UNIQUE NOT NULL,
      payload JSONB NOT NULL,
      processed BOOLEAN DEFAULT false,
      error TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      processed_at TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_webhook_logs_event ON webhook_logs(event_type);
    CREATE INDEX IF NOT EXISTS idx_webhook_logs_idempotency ON webhook_logs(idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_webhook_logs_processed ON webhook_logs(processed);
  `;

    try {
        await database.query(query);
        logger.info('✅ Tabela webhook_logs criada');
    } catch (error) {
        logger.error('❌ Erro ao criar tabela webhook_logs', error);
        throw error;
    }
}
