/**
 * Script de Simulação de Requisição da Extensão
 * 
 * Simula um usuário do SaaS fazendo um pedido de atualização via extensão Chrome.
 * 
 * Uso:
 * 1. Configure as variáveis de ambiente no .env:
 *    - EXTENSAO_EMAIL
 *    - EXTENSAO_PASSWORD
 *    - EXTENSAO_NOME (opcional)
 *    - EXTENSAO_PAT_TOKEN (Token PAT do INSS)
 *    - EXTENSAO_GEMINI_KEY (opcional)
 *    - EXTENSAO_TRAMITACAO_TOKEN (opcional)
 * 
 * 2. Execute: npm run simular-extensao
 * 
 * Este script simula exatamente o que a extensão faz ao clicar no botão de sincronização.
 */

import axios from 'axios';
import logger from '../utils/logger';

const BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000/api/v1';

interface LoginResponse {
    success: boolean;
    message?: string;
    token?: string;
    user?: any;
}

interface ConfigResponse {
    success: boolean;
    message?: string;
    config?: {
        geminiApiKey?: string;
        tramitacaoApiToken?: string;
        patToken?: string;
    };
}

interface SyncResponse {
    success: boolean;
    message?: string;
    jobId?: string;
    dataInicio?: Date;
    dataFim?: Date;
}

interface StatusResponse {
    success: boolean;
    status?: {
        status: 'pending' | 'processing' | 'completed' | 'failed';
        progress?: {
            total: number;
            processados: number;
            sucesso: number;
            erros: number;
        };
        resultado?: {
            protocolosProcessados: number;
            clientesCriados: number;
            clientesAtualizados: number;
            notificacoesEnviadas: number;
            erros: string[];
        };
        erro?: string;
    };
}

async function login(email: string, password: string): Promise<string> {
    logger.info(`[Simulação] 🔐 Fazendo login com ${email}...`);

    try {
        const response = await axios.post<LoginResponse>(`${BASE_URL}/extensao/login`, {
            email,
            password
        });

        if (response.data.success && response.data.token) {
            logger.info('[Simulação] ✅ Login realizado com sucesso!');
            return response.data.token;
        } else {
            throw new Error(response.data.message || 'Falha no login');
        }
    } catch (error: any) {
        if (error.response?.status === 401) {
            logger.warn('[Simulação] Usuário não encontrado. Tentando registrar...');
            return await registrar(email, password);
        }

        if (error.code === 'ECONNREFUSED') {
            throw new Error(`Servidor não está rodando em ${BASE_URL}. Execute 'npm run dev' primeiro.`);
        }

        throw error;
    }
}

async function registrar(email: string, password: string): Promise<string> {
    const nome = process.env.EXTENSAO_NOME || 'Usuário Teste Extensão';

    logger.info(`[Simulação] 📝 Registrando usuário ${email}...`);

    const response = await axios.post<LoginResponse>(`${BASE_URL}/extensao/register`, {
        email,
        password,
        nome
    });

    if (!response.data.success) {
        throw new Error(response.data.message || 'Falha ao registrar');
    }

    logger.info('[Simulação] ✅ Usuário registrado! Fazendo login...');
    return await login(email, password);
}

async function atualizarConfig(
    token: string,
    config: { geminiApiKey?: string; tramitacaoApiToken?: string; patToken?: string }
): Promise<void> {
    logger.info('[Simulação] 🔧 Atualizando configurações do usuário...');

    const response = await axios.put<ConfigResponse>(
        `${BASE_URL}/extensao/config`,
        config,
        {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        }
    );

    if (!response.data.success) {
        throw new Error(response.data.message || 'Falha ao atualizar configurações');
    }

    logger.info('[Simulação] ✅ Configurações atualizadas!');
}

async function iniciarSincronizacao(token: string, patToken: string, forcarExecucao: boolean = false): Promise<string> {
    logger.info('[Simulação] 🚀 Iniciando sincronização INSS...');

    const response = await axios.post<SyncResponse>(
        `${BASE_URL}/inss/sincronizar`,
        {
            tokenPat: patToken,
            forcarExecucao
        },
        {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        }
    );

    if (!response.data.success || !response.data.jobId) {
        throw new Error(response.data.message || 'Falha ao iniciar sincronização');
    }

    logger.info(`[Simulação] ✅ Sincronização iniciada! Job ID: ${response.data.jobId}`);
    return response.data.jobId;
}

async function monitorarStatus(jobId: string): Promise<void> {
    logger.info(`[Simulação] 👀 Monitorando job ${jobId}...`);

    let concluido = false;
    let tentativas = 0;
    const maxTentativas = 120; // 10 minutos (5s * 120)

    while (!concluido && tentativas < maxTentativas) {
        try {
            const response = await axios.get<StatusResponse>(`${BASE_URL}/inss/status/${jobId}`);

            if (!response.data.success || !response.data.status) {
                throw new Error('Status não disponível');
            }

            const status = response.data.status;

            if (status.progress) {
                const { total, processados, sucesso, erros } = status.progress;
                logger.info(
                    `[Job ${jobId}] 📊 Status: ${status.status} | ` +
                    `Total: ${total} | Processados: ${processados} | ` +
                    `Sucesso: ${sucesso} | Erros: ${erros}`
                );
            } else {
                logger.info(`[Job ${jobId}] Status: ${status.status}`);
            }

            if (status.status === 'completed') {
                concluido = true;
                logger.info(`[Job ${jobId}] ✅ Finalizado com sucesso!`);

                if (status.resultado) {
                    logger.info(
                        `[Job ${jobId}] 📈 Resumo Final:\n` +
                        `  - Protocolos Processados: ${status.resultado.protocolosProcessados}\n` +
                        `  - Clientes Criados: ${status.resultado.clientesCriados}\n` +
                        `  - Clientes Atualizados: ${status.resultado.clientesAtualizados}\n` +
                        `  - Notificações Enviadas: ${status.resultado.notificacoesEnviadas}`
                    );

                    if (status.resultado.erros.length > 0) {
                        logger.warn(`[Job ${jobId}] ⚠️ Erros durante execução:`);
                        status.resultado.erros.forEach(erro => logger.warn(`  - ${erro}`));
                    }
                }
            } else if (status.status === 'failed') {
                throw new Error(status.erro || 'Job falhou sem detalhes');
            } else {
                // Aguardar 5 segundos antes de checar novamente
                await new Promise(resolve => setTimeout(resolve, 5000));
                tentativas++;
            }
        } catch (error: any) {
            logger.error(`[Simulação] Erro ao monitorar status: ${error.message}`);
            throw error;
        }
    }

    if (!concluido) {
        logger.warn(`[Simulação] ⏱️ Timeout: Job ${jobId} não finalizou em 10 minutos`);
    }
}

async function main() {
    try {
        logger.info('========================================');
        logger.info('🎭 SIMULAÇÃO DE REQUISIÇÃO DA EXTENSÃO');
        logger.info('========================================\n');

        // 1. Validar variáveis de ambiente
        const email = process.env.EXTENSAO_EMAIL;
        const password = process.env.EXTENSAO_PASSWORD;
        const patToken = process.env.EXTENSAO_PAT_TOKEN;

        if (!email || !password) {
            throw new Error('Configure EXTENSAO_EMAIL e EXTENSAO_PASSWORD no .env');
        }

        if (!patToken) {
            throw new Error('Configure EXTENSAO_PAT_TOKEN no .env');
        }

        // 2. Login ou Registro
        const token = await login(email, password);

        // 3. Atualizar Configurações (opcional mas recomendado)
        const config: any = {};

        if (process.env.EXTENSAO_GEMINI_KEY) {
            config.geminiApiKey = process.env.EXTENSAO_GEMINI_KEY;
        }

        if (process.env.EXTENSAO_TRAMITACAO_TOKEN) {
            config.tramitacaoApiToken = process.env.EXTENSAO_TRAMITACAO_TOKEN;
        }

        if (patToken) {
            config.patToken = patToken;
        }

        if (Object.keys(config).length > 0) {
            await atualizarConfig(token, config);
        }

        // 4. Iniciar Sincronização
        const forcarExecucao = process.argv.includes('--forcar');
        const jobId = await iniciarSincronizacao(token, patToken, forcarExecucao);

        // 5. Monitorar Status
        await monitorarStatus(jobId);

        logger.info('\n========================================');
        logger.info('✅ SIMULAÇÃO CONCLUÍDA COM SUCESSO!');
        logger.info('========================================');

        process.exit(0);
    } catch (error: any) {
        logger.error('\n========================================');
        logger.error('❌ ERRO NA SIMULAÇÃO');
        logger.error('========================================');
        logger.error(`Erro: ${error.message}`);

        if (error.code) {
            logger.error(`Código de erro: ${error.code}`);
        }

        if (error.response?.data) {
            logger.error('Resposta da API:', JSON.stringify(error.response.data, null, 2));
        }

        if (error.stack) {
            logger.error('Stack trace:', error.stack);
        }

        process.exit(1);
    }
}

main();
