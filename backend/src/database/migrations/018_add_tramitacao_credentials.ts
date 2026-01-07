import database from '../index';
import logger from '../../utils/logger';

/**
 * Migration 018: Adicionar credenciais do Tramitação para usuários da extensão
 */
export async function addTramitacaoCredentials(): Promise<void> {
    try {
        logger.info('📦 Migration 018: Adicionando colunas de credenciais do Tramitação...');

        // Adicionar colunas para email e senha do Tramitação
        await database.query(`
            ALTER TABLE usuarios_extensao 
            ADD COLUMN IF NOT EXISTS tramitacao_email VARCHAR(255),
            ADD COLUMN IF NOT EXISTS tramitacao_senha VARCHAR(255)
        `);

        // Criar índice para busca por email do Tramitação
        await database.query(`
            CREATE INDEX IF NOT EXISTS idx_usuarios_extensao_tramitacao_email 
            ON usuarios_extensao(tramitacao_email) 
            WHERE tramitacao_email IS NOT NULL
        `);

        // Comentários nas colunas
        await database.query(`
            COMMENT ON COLUMN usuarios_extensao.tramitacao_email IS 'Email de login do usuário no Tramitação Inteligente'
        `);

        await database.query(`
            COMMENT ON COLUMN usuarios_extensao.tramitacao_senha IS 'Senha de login do usuário no Tramitação Inteligente'
        `);

        logger.info('✅ Migration 018 executada com sucesso!');
    } catch (error: any) {
        logger.error(`❌ Erro ao executar migration 018: ${error.message}`, error);
        throw error;
    }
}
