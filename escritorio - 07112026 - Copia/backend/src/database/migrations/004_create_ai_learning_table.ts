import database from '../index';
import logger from '../../utils/logger';

/**
 * Tabela para armazenar histórico de análises de exigências
 * Sistema de aprendizado contínuo para melhorar precisão da IA
 */
export async function createAILearningTable(): Promise<void> {
    const query = `
    CREATE TABLE IF NOT EXISTS exigencias_ia_historico (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      protocolo_inss VARCHAR(50) NOT NULL,
      texto_bruto TEXT NOT NULL,
      classe_final VARCHAR(50) NOT NULL,
      motivo_ia TEXT NOT NULL,
      documentos_exigidos TEXT[] DEFAULT '{}',
      confianca DECIMAL(5,2) DEFAULT 0.0,
      validado BOOLEAN DEFAULT false,
      validado_por UUID REFERENCES usuarios(id) ON DELETE SET NULL,
      validado_em TIMESTAMP,
      observacoes_validacao TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_exigencias_ia_protocolo ON exigencias_ia_historico(protocolo_inss);
    CREATE INDEX IF NOT EXISTS idx_exigencias_ia_classe ON exigencias_ia_historico(classe_final);
    CREATE INDEX IF NOT EXISTS idx_exigencias_ia_validado ON exigencias_ia_historico(validado);
    CREATE INDEX IF NOT EXISTS idx_exigencias_ia_confianca ON exigencias_ia_historico(confianca DESC);
    CREATE INDEX IF NOT EXISTS idx_exigencias_ia_created ON exigencias_ia_historico(created_at DESC);
    
    -- Índice GIN para busca full-text no texto_bruto
    CREATE INDEX IF NOT EXISTS idx_exigencias_ia_texto_gin ON exigencias_ia_historico USING gin(to_tsvector('portuguese', texto_bruto));
  `;

    try {
        await database.query(query);
        logger.info('✅ Tabela exigencias_ia_historico criada (sistema de aprendizado)');
    } catch (error) {
        logger.error('❌ Erro ao criar tabela exigencias_ia_historico', error);
        throw error;
    }
}

