import database from '../index';
import logger from '../../utils/logger';

/**
 * Migration 003: Sistema de Configurações
 * 
 * Adiciona tabela para controlar execuções do Worker:
 * - Última execução (timestamp)
 * - Período customizado para processamento
 * - Logs de execução
 */
export async function up(): Promise<void> {
    try {
        logger.info('🚀 Executando Migration 003: Sistema de Configurações...');

        // 1. Tabela de configurações do sistema
        await database.query(`
            CREATE TABLE IF NOT EXISTS sistema_config (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                chave VARCHAR(255) UNIQUE NOT NULL,
                valor TEXT NOT NULL,
                descricao TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_sistema_config_chave ON sistema_config(chave);
        `);
        logger.info('✅ Tabela sistema_config criada');

        // 2. Tabela de logs de execução do Worker
        await database.query(`
            CREATE TABLE IF NOT EXISTS worker_execucoes (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                tipo VARCHAR(50) NOT NULL CHECK (tipo IN ('AUTOMATICO', 'MANUAL', 'PERIODO_CUSTOMIZADO')),
                data_inicio TIMESTAMP NOT NULL,
                data_fim TIMESTAMP,
                periodo_inicio DATE,
                periodo_fim DATE,
                processos_verificados INTEGER DEFAULT 0,
                processos_atualizados INTEGER DEFAULT 0,
                tarefas_criadas INTEGER DEFAULT 0,
                status VARCHAR(50) NOT NULL CHECK (status IN ('EM_EXECUCAO', 'CONCLUIDO', 'ERRO')),
                erro_mensagem TEXT,
                executado_por_usuario_id UUID REFERENCES usuarios(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_worker_execucoes_tipo ON worker_execucoes(tipo);
            CREATE INDEX IF NOT EXISTS idx_worker_execucoes_status ON worker_execucoes(status);
            CREATE INDEX IF NOT EXISTS idx_worker_execucoes_data_inicio ON worker_execucoes(data_inicio DESC);
        `);
        logger.info('✅ Tabela worker_execucoes criada');

        // 3. Adicionar coluna data_processamento em processos
        await database.query(`
            ALTER TABLE processos 
            ADD COLUMN IF NOT EXISTS data_processamento DATE;

            CREATE INDEX IF NOT EXISTS idx_processos_data_processamento ON processos(data_processamento);
        `);
        logger.info('✅ Coluna data_processamento adicionada à tabela processos');

        // 4. Inserir configurações padrão
        await database.query(`
            INSERT INTO sistema_config (chave, valor, descricao)
            VALUES 
                ('ultima_execucao_worker', '', 'Timestamp da última execução automática do Worker'),
                ('modo_processamento', 'DIA_ATUAL', 'Modo de processamento: DIA_ATUAL, PERIODO_CUSTOMIZADO, TODOS'),
                ('periodo_inicio', '', 'Data de início do período customizado (YYYY-MM-DD)'),
                ('periodo_fim', '', 'Data de fim do período customizado (YYYY-MM-DD)')
            ON CONFLICT (chave) DO NOTHING;
        `);
        logger.info('✅ Configurações padrão inseridas');

        logger.info('✅ Migration 003 concluída com sucesso!');
    } catch (error) {
        logger.error('❌ Erro na Migration 003:', error);
        throw error;
    }
}

export async function down(): Promise<void> {
    try {
        await database.query(`
            DROP TABLE IF EXISTS worker_execucoes;
            DROP TABLE IF EXISTS sistema_config;
            ALTER TABLE processos DROP COLUMN IF EXISTS data_processamento;
        `);
        logger.info('✅ Migration 003 revertida');
    } catch (error) {
        logger.error('❌ Erro ao reverter Migration 003:', error);
        throw error;
    }
}

// Auto-executar se chamado diretamente
if (require.main === module) {
    up()
        .then(() => {
            logger.info('✅ Migration 003 executada com sucesso');
            process.exit(0);
        })
        .catch((error) => {
            logger.error('❌ Erro ao executar Migration 003:', error);
            process.exit(1);
        });
}
