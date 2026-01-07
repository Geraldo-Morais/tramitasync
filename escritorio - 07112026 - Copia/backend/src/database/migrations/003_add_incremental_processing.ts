import database from '../index';
import logger from '../../utils/logger';

/**
 * Migration 003: Sistema de Processamento Incremental
 * 
 * Cria tabelas para configuração e auditoria do Worker:
 * - configuracoes_sistema: Armazena período de processamento (INCREMENTAL ou CUSTOM)
 * - execucoes_worker: Log de todas as execuções do Worker
 */

async function migrate() {
    try {
        logger.info('[Migration 003] Iniciando criação de tabelas de processamento incremental...');

        // 1. Tabela de configurações do sistema
        await database.query(`
            CREATE TABLE IF NOT EXISTS configuracoes_sistema (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                chave VARCHAR(100) UNIQUE NOT NULL,
                modo_processamento VARCHAR(20) DEFAULT 'INCREMENTAL' CHECK (modo_processamento IN ('INCREMENTAL', 'CUSTOM')),
                data_inicio_custom DATE,
                data_fim_custom DATE,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW(),
                CONSTRAINT valid_custom_dates CHECK (
                    (modo_processamento = 'CUSTOM' AND data_inicio_custom IS NOT NULL AND data_fim_custom IS NOT NULL) OR
                    (modo_processamento = 'INCREMENTAL')
                )
            );
        `);
        logger.info('✅ Tabela configuracoes_sistema criada');

        // 2. Inserir configuração padrão para o Worker
        await database.query(`
            INSERT INTO configuracoes_sistema (chave, modo_processamento)
            VALUES ('periodo_worker', 'INCREMENTAL')
            ON CONFLICT (chave) DO NOTHING;
        `);
        logger.info('✅ Configuração padrão inserida (INCREMENTAL)');

        // 3. Tabela de log de execuções do Worker
        await database.query(`
            CREATE TABLE IF NOT EXISTS execucoes_worker (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('AUTOMATICO', 'MANUAL', 'CUSTOM')),
                status VARCHAR(20) NOT NULL CHECK (status IN ('EM_ANDAMENTO', 'SUCESSO', 'ERRO')),
                data_inicio TIMESTAMP NOT NULL,
                data_fim TIMESTAMP,
                protocolos_processados INTEGER DEFAULT 0,
                mudancas_detectadas INTEGER DEFAULT 0,
                erros INTEGER DEFAULT 0,
                periodo_inicio DATE,
                periodo_fim DATE,
                observacoes TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);
        logger.info('✅ Tabela execucoes_worker criada');

        // 4. Índices para performance
        await database.query(`
            CREATE INDEX IF NOT EXISTS idx_execucoes_worker_data_inicio 
            ON execucoes_worker(data_inicio DESC);
        `);
        logger.info('✅ Índice idx_execucoes_worker_data_inicio criado');

        await database.query(`
            CREATE INDEX IF NOT EXISTS idx_execucoes_worker_status 
            ON execucoes_worker(status);
        `);
        logger.info('✅ Índice idx_execucoes_worker_status criado');

        // 5. Verificar estrutura final
        const result = await database.query(`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
            AND table_name IN ('configuracoes_sistema', 'execucoes_worker')
            ORDER BY table_name;
        `);

        logger.info('\n[Migration 003] ========== RESUMO ==========');
        logger.info(`✅ Tabelas criadas: ${result.length}/2`);
        result.forEach((row: any) => {
            logger.info(`   - ${row.table_name}`);
        });

        logger.info('\n[Migration 003] ✅ Migration concluída com sucesso!');
        logger.info('\n📋 Próximos passos:');
        logger.info('   1. Sistema processará apenas o dia atual por padrão');
        logger.info('   2. Admin pode alterar para CUSTOM via AdminPanel (próxima feature)');
        logger.info('   3. Todas execuções serão logadas em execucoes_worker\n');

    } catch (error) {
        logger.error('[Migration 003] ❌ Erro ao executar migration:', error);
        throw error;
    }
}

// Executar migration
if (require.main === module) {
    migrate()
        .then(() => {
            logger.info('[Migration 003] Processo finalizado');
            process.exit(0);
        })
        .catch((error) => {
            logger.error('[Migration 003] Falha na execução:', error);
            process.exit(1);
        });
}

export default migrate;
