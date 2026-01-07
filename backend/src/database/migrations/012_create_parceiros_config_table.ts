/**
 * Migration: Tabela de Parceiros por Usuário (SaaS)
 * 
 * Permite que cada escritório cadastre parceiros (captadores, advogados parceiros, sindicatos)
 * para receberem notificações automáticas quando processos com a etiqueta PARCEIRO:NOME tiverem atualizações.
 */

import database from '../../database';
import logger from '../../utils/logger';

export async function createParceirosConfigTable(): Promise<void> {
    const query = `
        -- Tabela principal de parceiros por usuário
        CREATE TABLE IF NOT EXISTS parceiros_config (
            id SERIAL PRIMARY KEY,
            user_id UUID REFERENCES usuarios_extensao(id) ON DELETE CASCADE,
            
            -- Nome/identificador do parceiro (usado na etiqueta)
            -- Ex: "ARMENIO", "SINDICATO_RURAL", "DRA_MARIA"
            nome_etiqueta VARCHAR(100) NOT NULL,
            
            -- Nome completo para exibição
            nome_completo VARCHAR(255),
            
            -- Telefone WhatsApp (formato: 5577988887777)
            telefone VARCHAR(20) NOT NULL,
            
            -- Email para notificações (opcional)
            email VARCHAR(255),
            
            -- Preferências de notificação por status
            notificar_exigencia BOOLEAN DEFAULT true,
            notificar_deferido BOOLEAN DEFAULT true,
            notificar_indeferido BOOLEAN DEFAULT true,
            notificar_agendamento BOOLEAN DEFAULT true,
            notificar_em_analise BOOLEAN DEFAULT false,
            
            -- Se ativo, recebe notificações
            ativo BOOLEAN DEFAULT true,
            
            -- Opções de personalização da mensagem
            incluir_link_processo BOOLEAN DEFAULT false,  -- Links internos do PAT
            incluir_comprovantes BOOLEAN DEFAULT true,    -- Links públicos de comprovantes
            incluir_analise_ia BOOLEAN DEFAULT true,      -- Análise detalhada da IA
            
            -- Metadados
            observacoes TEXT,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW(),
            
            -- Constraint única: um parceiro por nome por usuário
            UNIQUE(user_id, nome_etiqueta)
        );

        -- Índices para busca rápida
        CREATE INDEX IF NOT EXISTS idx_parceiros_config_user_id 
        ON parceiros_config(user_id);
        
        CREATE INDEX IF NOT EXISTS idx_parceiros_config_nome_etiqueta 
        ON parceiros_config(user_id, UPPER(nome_etiqueta));

        -- Comentários
        COMMENT ON TABLE parceiros_config IS 
        'Configuração de parceiros por escritório para notificações automáticas';
        
        COMMENT ON COLUMN parceiros_config.nome_etiqueta IS 
        'Nome usado na etiqueta PARCEIRO:NOME no Tramitação (uppercase obrigatório)';
        
        COMMENT ON COLUMN parceiros_config.incluir_link_processo IS 
        'Se true, inclui link do PAT na mensagem (apenas se parceiro tiver acesso)';
    `;

    try {
        await database.query(query);
        logger.info('Tabela parceiros_config criada');
    } catch (error) {
        logger.error('Erro ao criar tabela parceiros_config', error);
        throw error;
    }
}



