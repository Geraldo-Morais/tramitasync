import database from '../index';
import logger from '../../utils/logger';

/**
 * Migration 002: Sistema de Workflow e Gestão de Tarefas
 * 
 * Adiciona:
 * 1. Campo responsavel_entrada_id em processos (quem deu entrada)
 * 2. Tabela tarefas (atribuição de trabalhos por perfil)
 * 3. Tabela documentos (uploads de arquivos)
 * 4. Tabela notificacoes (sistema de alertas)
 * 5. Tabela configuracoes_perfil (descrição de cada perfil e suas responsabilidades)
 */

export async function addResponsavelEntradaToProcessos(): Promise<void> {
    const query = `
    -- Adicionar campo responsavel_entrada_id (quem deu entrada no processo)
    ALTER TABLE processos 
    ADD COLUMN IF NOT EXISTS responsavel_entrada_id UUID REFERENCES usuarios(id) ON DELETE SET NULL;

    CREATE INDEX IF NOT EXISTS idx_processos_responsavel_entrada ON processos(responsavel_entrada_id);
  `;

    try {
        await database.query(query);
        logger.info('✅ Campo responsavel_entrada_id adicionado à tabela processos');
    } catch (error) {
        logger.error('❌ Erro ao adicionar responsavel_entrada_id', error);
        throw error;
    }
}

export async function createTarefasTable(): Promise<void> {
    const query = `
    CREATE TABLE IF NOT EXISTS tarefas (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      processo_id UUID NOT NULL REFERENCES processos(id) ON DELETE CASCADE,
      exigencia_id UUID REFERENCES exigencias(id) ON DELETE CASCADE,
      tipo VARCHAR(50) NOT NULL CHECK (tipo IN (
        'CONTATAR_COLABORADOR',
        'SOLICITAR_DOCUMENTO',
        'ANEXAR_DOCUMENTO',
        'AGENDAR_PERICIA',
        'AVALIAR_INDEFERIMENTO',
        'ENTRAR_JUDICIAL',
        'OUTRO'
      )),
      titulo VARCHAR(255) NOT NULL,
      descricao TEXT,
      prioridade VARCHAR(20) NOT NULL DEFAULT 'MEDIA' CHECK (prioridade IN ('BAIXA', 'MEDIA', 'ALTA', 'URGENTE')),
      status VARCHAR(50) NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE', 'EM_ANDAMENTO', 'CONCLUIDA', 'CANCELADA')),
      responsavel_perfil VARCHAR(50) NOT NULL CHECK (responsavel_perfil IN ('admin', 'secretaria', 'administrativo', 'intermediacao', 'judicial')),
      responsavel_usuario_id UUID REFERENCES usuarios(id) ON DELETE SET NULL,
      criado_por_id UUID REFERENCES usuarios(id) ON DELETE SET NULL,
      data_prazo DATE,
      data_conclusao TIMESTAMP,
      observacoes TEXT,
      tramitacao_atividade_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_tarefas_processo ON tarefas(processo_id);
    CREATE INDEX IF NOT EXISTS idx_tarefas_status ON tarefas(status);
    CREATE INDEX IF NOT EXISTS idx_tarefas_responsavel_perfil ON tarefas(responsavel_perfil);
    CREATE INDEX IF NOT EXISTS idx_tarefas_responsavel_usuario ON tarefas(responsavel_usuario_id);
    CREATE INDEX IF NOT EXISTS idx_tarefas_prioridade ON tarefas(prioridade);
  `;

    try {
        await database.query(query);
        logger.info('✅ Tabela tarefas criada');
    } catch (error) {
        logger.error('❌ Erro ao criar tabela tarefas', error);
        throw error;
    }
}

export async function createDocumentosTable(): Promise<void> {
    const query = `
    CREATE TABLE IF NOT EXISTS documentos (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      processo_id UUID NOT NULL REFERENCES processos(id) ON DELETE CASCADE,
      exigencia_id UUID REFERENCES exigencias(id) ON DELETE CASCADE,
      tarefa_id UUID REFERENCES tarefas(id) ON DELETE CASCADE,
      nome_arquivo VARCHAR(255) NOT NULL,
      tipo_documento VARCHAR(100),
      caminho_arquivo TEXT NOT NULL,
      tamanho_bytes BIGINT,
      hash_arquivo VARCHAR(64),
      enviado_por_id UUID REFERENCES usuarios(id) ON DELETE SET NULL,
      enviado_tramitacao BOOLEAN DEFAULT false,
      tramitacao_arquivo_id INTEGER,
      observacoes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_documentos_processo ON documentos(processo_id);
    CREATE INDEX IF NOT EXISTS idx_documentos_exigencia ON documentos(exigencia_id);
    CREATE INDEX IF NOT EXISTS idx_documentos_tarefa ON documentos(tarefa_id);
    CREATE INDEX IF NOT EXISTS idx_documentos_enviado_por ON documentos(enviado_por_id);
  `;

    try {
        await database.query(query);
        logger.info('✅ Tabela documentos criada');
    } catch (error) {
        logger.error('❌ Erro ao criar tabela documentos', error);
        throw error;
    }
}

export async function createNotificacoesTable(): Promise<void> {
    const query = `
    CREATE TABLE IF NOT EXISTS notificacoes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      tipo VARCHAR(50) NOT NULL CHECK (tipo IN (
        'NOVA_TAREFA',
        'TAREFA_CONCLUIDA',
        'DOCUMENTO_RECEBIDO',
        'EXIGENCIA_VENCENDO',
        'STATUS_ALTERADO',
        'OUTRO'
      )),
      titulo VARCHAR(255) NOT NULL,
      mensagem TEXT NOT NULL,
      link_processo_id UUID REFERENCES processos(id) ON DELETE CASCADE,
      link_tarefa_id UUID REFERENCES tarefas(id) ON DELETE CASCADE,
      lida BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

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

export async function createConfiguracoesPerfilTable(): Promise<void> {
    const query = `
    CREATE TABLE IF NOT EXISTS configuracoes_perfil (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      perfil VARCHAR(50) UNIQUE NOT NULL CHECK (perfil IN ('admin', 'secretaria', 'administrativo', 'intermediacao', 'judicial')),
      nome_exibicao VARCHAR(100) NOT NULL,
      descricao TEXT NOT NULL,
      responsabilidades TEXT[] DEFAULT '{}',
      cor_badge VARCHAR(20) DEFAULT '#6B7280',
      ativo BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Inserir configurações padrão dos perfis
    INSERT INTO configuracoes_perfil (perfil, nome_exibicao, descricao, responsabilidades, cor_badge) VALUES
    ('admin', 'Administrador', 'Gerencia todo o sistema, usuários e configurações', ARRAY[
      'Gerenciar usuários e perfis',
      'Configurar integrações (INSS, Gemini, Tramitação)',
      'Renovar tokens e executar workers',
      'Visualizar logs e relatórios',
      'Acesso total ao sistema'
    ], '#DC2626'),
    ('secretaria', 'Secretaria', 'Dá entrada nos processos e monitora status', ARRAY[
      'Cadastrar novos processos',
      'Atualizar dados de colaboradores',
      'Monitorar prazos de exigências',
      'Visualizar dashboard geral'
    ], '#2563EB'),
    ('intermediacao', 'Intermediação (Cíntia)', 'Contata colaboradores e coleta documentos', ARRAY[
      'Receber notificações de exigências',
      'Contatar colaboradores via WhatsApp (futuro)',
      'Marcar documentos como recebidos',
      'Anexar documentos ao Tramitação',
      'Notificar responsável pela entrada'
    ], '#16A34A'),
    ('administrativo', 'Administrativo (Antonio)', 'Agenda perícias e avaliações sociais', ARRAY[
      'Receber notificações de perícias',
      'Agendar perícias médicas',
      'Agendar avaliações sociais',
      'Atualizar status de agendamentos',
      'Registrar comparecimento'
    ], '#CA8A04'),
    ('judicial', 'Jurídico', 'Avalia indeferimentos e entra com ações judiciais', ARRAY[
      'Receber notificações de indeferimentos',
      'Avaliar viabilidade de ação judicial',
      'Cadastrar processos judiciais',
      'Acompanhar andamento judicial',
      'Atualizar sistema com decisões'
    ], '#7C3AED')
    ON CONFLICT (perfil) DO NOTHING;
  `;

    try {
        await database.query(query);
        logger.info('✅ Tabela configuracoes_perfil criada e populada');
    } catch (error) {
        logger.error('❌ Erro ao criar tabela configuracoes_perfil', error);
        throw error;
    }
}

/**
 * Executar todas as migrations da versão 002
 */
export async function runMigration002(): Promise<void> {
    logger.info('🚀 Executando Migration 002: Sistema de Workflow...');

    await addResponsavelEntradaToProcessos();
    await createTarefasTable();
    await createDocumentosTable();
    await createNotificacoesTable();
    await createConfiguracoesPerfilTable();

    logger.info('✅ Migration 002 concluída com sucesso!');
}

// Executar se chamado diretamente
if (require.main === module) {
    runMigration002()
        .then(() => {
            logger.info('✅ Migration 002 executada com sucesso');
            process.exit(0);
        })
        .catch((error) => {
            logger.error('❌ Erro ao executar Migration 002:', error);
            process.exit(1);
        });
}
