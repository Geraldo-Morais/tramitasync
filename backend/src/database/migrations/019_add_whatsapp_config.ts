import database from '../index';
import logger from '../../utils/logger';

/**
 * Migration 019: Adicionar configurações de WhatsApp personalizadas por status
 * Permite que usuários SaaS configurem números diferentes para cada tipo de notificação
 */
export async function addWhatsAppConfig(): Promise<void> {
    try {
        logger.info('📦 Migration 019: Adicionando configurações de WhatsApp personalizadas...');

        // Adicionar colunas para configuração de WhatsApp por status
        await database.query(`
            ALTER TABLE usuarios_extensao 
            ADD COLUMN IF NOT EXISTS whatsapp_personalizado_ativo BOOLEAN DEFAULT false,
            ADD COLUMN IF NOT EXISTS whatsapp_numero_unico VARCHAR(20),
            ADD COLUMN IF NOT EXISTS whatsapp_exigencia VARCHAR(20),
            ADD COLUMN IF NOT EXISTS whatsapp_deferido VARCHAR(20),
            ADD COLUMN IF NOT EXISTS whatsapp_indeferido VARCHAR(20),
            ADD COLUMN IF NOT EXISTS whatsapp_em_analise VARCHAR(20),
            ADD COLUMN IF NOT EXISTS whatsapp_agendamento VARCHAR(20)
        `);

        // Comentários nas colunas
        await database.query(`
            COMMENT ON COLUMN usuarios_extensao.whatsapp_personalizado_ativo IS 'Se true, usa configurações personalizadas de WhatsApp do usuário'
        `);

        await database.query(`
            COMMENT ON COLUMN usuarios_extensao.whatsapp_numero_unico IS 'Número único para todas as notificações (formato: 557788682628 sem +)'
        `);

        await database.query(`
            COMMENT ON COLUMN usuarios_extensao.whatsapp_exigencia IS 'Número específico para notificações de EXIGÊNCIA (formato: 557788682628 sem +)'
        `);

        await database.query(`
            COMMENT ON COLUMN usuarios_extensao.whatsapp_deferido IS 'Número específico para notificações de DEFERIDO (formato: 557788682628 sem +)'
        `);

        await database.query(`
            COMMENT ON COLUMN usuarios_extensao.whatsapp_indeferido IS 'Número específico para notificações de INDEFERIDO (formato: 557788682628 sem +)'
        `);

        await database.query(`
            COMMENT ON COLUMN usuarios_extensao.whatsapp_em_analise IS 'Número específico para notificações de EM_ANALISE (formato: 557788682628 sem +)'
        `);

        await database.query(`
            COMMENT ON COLUMN usuarios_extensao.whatsapp_agendamento IS 'Número específico para notificações de AGENDAMENTO (formato: 557788682628 sem +)'
        `);

        logger.info('✅ Migration 019 executada com sucesso!');
    } catch (error: any) {
        logger.error(`❌ Erro ao executar migration 019: ${error.message}`, error);
        throw error;
    }
}



