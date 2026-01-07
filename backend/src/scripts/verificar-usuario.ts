/**
 * Script para verificar e atualizar credenciais do usuário gerald.morais.0192@gmail.com
 */

import Database from '../database';
import logger from '../utils/logger';

async function verificarEAtualizarUsuario() {
    try {
        logger.info('🔍 Verificando usuário gerald.morais.0192@gmail.com...');

        // Buscar usuário
        const usuarios = await Database.query(
            `SELECT id, email, nome, gemini_api_key, tramitacao_api_token, 
                    tramitacao_email, tramitacao_senha, pat_token, licenca_valida_ate
             FROM usuarios_extensao 
             WHERE email = $1`,
            ['gerald.morais.0192@gmail.com']
        );

        if (usuarios.length === 0) {
            logger.error('❌ Usuário não encontrado no banco!');
            logger.info('💡 O usuário precisa se registrar pela extensão primeiro.');
            process.exit(1);
        }

        const usuario = usuarios[0];
        logger.info('✅ Usuário encontrado!');
        logger.info(`   ID: ${usuario.id}`);
        logger.info(`   Nome: ${usuario.nome}`);
        logger.info(`   Email: ${usuario.email}`);
        logger.info(`   Licença válida até: ${usuario.licenca_valida_ate}`);
        logger.info('');
        logger.info('📋 Configurações atuais:');
        logger.info(`   Gemini API Key: ${usuario.gemini_api_key ? '✅ Configurado' : '❌ Não configurado'}`);
        logger.info(`   Tramitação API Token: ${usuario.tramitacao_api_token ? '✅ Configurado' : '❌ Não configurado'}`);
        logger.info(`   Tramitação Email: ${usuario.tramitacao_email || '❌ Não configurado'}`);
        logger.info(`   Tramitação Senha: ${usuario.tramitacao_senha ? '✅ Configurado' : '❌ Não configurado'}`);
        logger.info(`   PAT Token: ${usuario.pat_token ? '✅ Configurado' : '❌ Não configurado'}`);
        logger.info('');

        // Atualizar credenciais do Tramitação se não configuradas
        if (!usuario.tramitacao_email || !usuario.tramitacao_senha) {
            logger.info('🔧 Atualizando credenciais do Tramitação...');

            await Database.query(
                `UPDATE usuarios_extensao 
                 SET tramitacao_email = $1, 
                     tramitacao_senha = $2,
                     atualizado_em = NOW()
                 WHERE email = $3`,
                ['gerald.morais.0192@gmail.com', 'Bb200330**', 'gerald.morais.0192@gmail.com']
            );

            logger.info('✅ Credenciais do Tramitação atualizadas!');
            logger.info('   Email: gerald.morais.0192@gmail.com');
            logger.info('   Senha: Bb200330** (configurada)');
        } else {
            logger.info('✅ Credenciais do Tramitação já configuradas!');
        }

        logger.info('');
        logger.info('🎉 Usuário configurado corretamente!');
        process.exit(0);
    } catch (error: any) {
        logger.error(`❌ Erro: ${error.message}`, error);
        process.exit(1);
    }
}

verificarEAtualizarUsuario();
