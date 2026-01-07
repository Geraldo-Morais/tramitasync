import logger from '../../utils/logger';
import database from '../index';

/**
 * Migration 017: Cria tabela de usuários da extensão INSS
 */
export async function createUsuariosExtensaoTable(): Promise<void> {
    const client = await database.getClient();

    try {
        logger.info('🔄 Executando migration 017: usuarios_extensao...');

        await client.query(`
            CREATE TABLE IF NOT EXISTS usuarios_extensao (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                email VARCHAR(255) NOT NULL UNIQUE,
                nome VARCHAR(255) NOT NULL,
                senha_hash VARCHAR(255) NOT NULL,
                
                -- Configurações do usuário
                gemini_api_key TEXT,
                tramitacao_api_token TEXT,
                pat_token TEXT,
                pat_token_timestamp TIMESTAMP WITH TIME ZONE,
                
                -- Licença (lifetime = 100 anos)
                licenca_valida_ate TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() + INTERVAL '100 years'),
                
                -- Timestamps
                criado_em TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
                atualizado_em TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
            );
        `);

        // Índices
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_usuarios_extensao_email ON usuarios_extensao(email);
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_usuarios_extensao_licenca ON usuarios_extensao(licenca_valida_ate);
        `);

        // Trigger para atualizar 'atualizado_em' automaticamente
        await client.query(`
            CREATE OR REPLACE FUNCTION update_usuarios_extensao_updated_at()
            RETURNS TRIGGER AS $$
            BEGIN
                NEW.atualizado_em = NOW();
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
        `);

        await client.query(`
            DROP TRIGGER IF EXISTS update_usuarios_extensao_updated_at ON usuarios_extensao;
            CREATE TRIGGER update_usuarios_extensao_updated_at
            BEFORE UPDATE ON usuarios_extensao
            FOR EACH ROW
            EXECUTE FUNCTION update_usuarios_extensao_updated_at();
        `);

        logger.info('✅ Migration 017 executada com sucesso: usuarios_extensao criada');
    } catch (error: any) {
        if (error.message.includes('already exists')) {
            logger.info('ℹ️ Tabela usuarios_extensao já existe, pulando criação');
        } else {
            logger.error('❌ Erro ao executar migration 017:', error);
            throw error;
        }
    }
}


