import {
    createUsuariosTable,
    createProcessosTable,
    createExigenciasTable,
    createHistoricoStatusTable,
    createProcessosJudiciaisTable,
    createNotificacoesTable,
    createWebhookLogsTable,
} from './001_create_tables';
import { createAILearningTable } from './004_create_ai_learning_table';
import { createUsuariosExtensaoTable } from './017_create_usuarios_extensao';
import { addTramitacaoCredentials } from './018_add_tramitacao_credentials';
import { addWhatsAppConfig } from './019_add_whatsapp_config';
import { createPadroesEtiquetasTable } from './011_create_padroes_etiquetas_table';
import { createParceirosConfigTable } from './012_create_parceiros_config_table';
import logger from '../../utils/logger';
import database from '../index';

async function runMigrations(): Promise<void> {
    logger.info('🔄 Iniciando migrations...');

    try {
        // Testar conexão
        const connected = await database.testConnection();
        if (!connected) {
            throw new Error('Não foi possível conectar ao banco de dados');
        }

        // Executar migrations em ordem
        await createUsuariosTable();
        await createProcessosTable();
        await createExigenciasTable();
        await createHistoricoStatusTable();
        await createProcessosJudiciaisTable();
        await createNotificacoesTable();
        await createWebhookLogsTable();
        await createAILearningTable(); // Sistema de aprendizado da IA
        await createUsuariosExtensaoTable(); // Usuários da extensão INSS
        await addTramitacaoCredentials(); // Credenciais do Tramitação por usuário
        await addWhatsAppConfig(); // Configurações de WhatsApp personalizadas
        await createPadroesEtiquetasTable(); // Padrões de etiquetas por escritório (SaaS)
        await createParceirosConfigTable(); // Configuração de parceiros (SaaS)

        logger.info('Todas as migrations executadas com sucesso!');
        process.exit(0);
    } catch (error) {
        logger.error('❌ Erro ao executar migrations', error);
        process.exit(1);
    }
}

// Executar se chamado diretamente
if (require.main === module) {
    runMigrations();
}

export default runMigrations;
