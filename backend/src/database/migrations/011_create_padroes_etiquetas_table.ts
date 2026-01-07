/**
 * Migration: Tabela de Padrões de Etiquetas por Escritório
 * 
 * Armazena os padrões de etiquetas aprendidos de cada escritório (cliente SaaS)
 * para que o sistema use o mesmo vocabulário que o escritório já usa.
 */

import database from '../../database';
import logger from '../../utils/logger';

export async function createPadroesEtiquetasTable(): Promise<void> {
    const query = `
        -- Tabela principal de padrões por escritório
        CREATE TABLE IF NOT EXISTS padroes_etiquetas_escritorio (
            id SERIAL PRIMARY KEY,
            user_id UUID REFERENCES usuarios_extensao(id) ON DELETE CASCADE,
            
            -- Mapeamento de benefícios INSS → etiqueta do escritório
            -- Ex: {"BENEFICIO_ASSISTENCIAL_DEFICIENCIA": "BPC", "APOSENTADORIA_POR_IDADE": "APOS_IDADE"}
            mapeamento_beneficios JSONB DEFAULT '{}',
            
            -- Etiquetas de status que o escritório usa
            -- Ex: ["EXIGENCIA", "EM_ANALISE", "DEFERIDO", "INDEFERIDO"]
            etiquetas_status TEXT[] DEFAULT ARRAY[]::TEXT[],
            
            -- Etiquetas de fase que o escritório usa
            -- Ex: ["ADMINISTRATIVO", "JUDICIAL"]
            etiquetas_fase TEXT[] DEFAULT ARRAY[]::TEXT[],
            
            -- Etiquetas de responsáveis/pessoas que o escritório usa
            -- Ex: ["MARIA", "JOAO", "ADVOGADO_1"]
            etiquetas_responsaveis TEXT[] DEFAULT ARRAY[]::TEXT[],
            
            -- Todas as etiquetas conhecidas do sistema (para identificar manuais)
            -- União de todas as acima + outras frequentes
            etiquetas_sistema TEXT[] DEFAULT ARRAY[]::TEXT[],
            
            -- Etiquetas que SEMPRE devem ser aplicadas (ex: CLIENTE_INSS)
            etiquetas_obrigatorias TEXT[] DEFAULT ARRAY['CLIENTE_INSS']::TEXT[],
            
            -- Estatísticas
            total_clientes_analisados INT DEFAULT 0,
            ultima_atualizacao TIMESTAMP DEFAULT NOW(),
            
            -- Frequência mínima para considerar padrão (0.0 a 1.0)
            frequencia_minima DECIMAL(3,2) DEFAULT 0.15,
            
            -- Constraint única por usuário
            UNIQUE(user_id)
        );

        -- Índice para busca rápida
        CREATE INDEX IF NOT EXISTS idx_padroes_etiquetas_user_id 
        ON padroes_etiquetas_escritorio(user_id);

        -- Comentários para documentação
        COMMENT ON TABLE padroes_etiquetas_escritorio IS 
        'Padrões de etiquetas aprendidos de cada escritório para manter consistência';
        
        COMMENT ON COLUMN padroes_etiquetas_escritorio.mapeamento_beneficios IS 
        'JSON mapeando nome do benefício INSS → etiqueta usada pelo escritório';
        
        COMMENT ON COLUMN padroes_etiquetas_escritorio.etiquetas_sistema IS 
        'Lista de todas as etiquetas conhecidas do sistema (não são manuais)';
    `;

    try {
        await database.query(query);
        logger.info('Tabela padroes_etiquetas_escritorio criada');
    } catch (error) {
        logger.error('Erro ao criar tabela padroes_etiquetas_escritorio', error);
        throw error;
    }
}



