import 'dotenv/config';
import { ExtensaoAuthController } from '../controllers/ExtensaoAuthController';
import { SincronizacaoInssController } from '../controllers/SincronizacaoInssController';
import logger from '../utils/logger';

interface SyncOptions {
    email: string;
    password: string;
    nome: string;
    geminiApiKey?: string;
    tramitacaoApiToken?: string;
    patToken?: string;
    forcarExecucao?: boolean;
}

function getArgValue(flag: string): string | undefined {
    const prefix = `--${flag}=`;
    const arg = process.argv.find((value) => value.startsWith(prefix));
    return arg ? arg.substring(prefix.length) : undefined;
}

async function ensureUser(
    controller: ExtensaoAuthController,
    email: string,
    password: string,
    nome: string
) {
    const login = await controller.login(email, password);
    if (login.success && login.token) {
        return login;
    }

    logger.warn(`[Extensão] Login falhou (${login.message || 'motivo desconhecido'}). Tentando registrar usuário.`);
    const registro = await controller.registrar(email, password, nome);
    if (!registro.success) {
        throw new Error(registro.message || 'Não foi possível registrar o usuário da extensão');
    }

    logger.info('[Extensão] Usuário registrado com sucesso. Tentando login novamente...');
    const novoLogin = await controller.login(email, password);
    if (!novoLogin.success || !novoLogin.token) {
        throw new Error(novoLogin.message || 'Falha ao autenticar após registro');
    }

    return novoLogin;
}

async function atualizarConfiguracoes(
    controller: ExtensaoAuthController,
    token: string,
    configs: { geminiApiKey?: string; tramitacaoApiToken?: string; patToken?: string }
) {
    const payload: { geminiApiKey?: string; tramitacaoApiToken?: string; patToken?: string } = {};

    if (configs.geminiApiKey) {
        payload.geminiApiKey = configs.geminiApiKey;
    }
    if (configs.tramitacaoApiToken) {
        payload.tramitacaoApiToken = configs.tramitacaoApiToken;
    }
    if (configs.patToken) {
        payload.patToken = configs.patToken;
    }

    if (Object.keys(payload).length === 0) {
        return;
    }

    const resultado = await controller.atualizarConfig(token, payload);
    if (!resultado.success) {
        throw new Error(resultado.message || 'Falha ao atualizar configurações do usuário');
    }
    logger.info('[Extensão] Configurações atualizadas no backend.');
}

async function executarSincronizacao(options: SyncOptions) {
    const extensaoController = new ExtensaoAuthController();
    const sincronizacaoController = new SincronizacaoInssController();

    const login = await ensureUser(extensaoController, options.email, options.password, options.nome);
    const authToken = login.token!;

    // Prioridade para token PAT:
    // 1. Variável de ambiente (mais confiável, não quebra com &)
    // 2. Argumento via --tokenPat (pode quebrar no PowerShell)
    // 3. Opções do script
    // 4. Banco de dados (última tentativa)

    const tokenPatArg = getArgValue('tokenPat');
    const tokenPatEnv = process.env.EXTENSAO_PAT_TOKEN;
    const tokenPatOption = options.patToken;

    // Usar token do ambiente se disponível (mais confiável)
    const tokenPatParaUsar = tokenPatEnv || tokenPatArg || tokenPatOption;

    // Atualizar configurações com o token (se fornecido)
    if (tokenPatParaUsar) {
        await atualizarConfiguracoes(extensaoController, authToken, {
            geminiApiKey: options.geminiApiKey,
            tramitacaoApiToken: options.tramitacaoApiToken,
            patToken: tokenPatParaUsar,
        });
    } else {
        // Se não forneceu token, apenas atualizar outras configs
        await atualizarConfiguracoes(extensaoController, authToken, {
            geminiApiKey: options.geminiApiKey,
            tramitacaoApiToken: options.tramitacaoApiToken,
        });
    }

    const configuracoesAtuais = await extensaoController.obterConfig(authToken);
    if (!configuracoesAtuais.success || !configuracoesAtuais.config) {
        throw new Error(configuracoesAtuais.message || 'Não foi possível recuperar configurações do usuário');
    }

    // Usar token atualizado do banco (já foi salvo acima) ou do banco anterior
    const patToken = tokenPatParaUsar || configuracoesAtuais.config.patToken;

    if (!patToken) {
        throw new Error('Token PAT não informado. Forneça via --tokenPat=AT-xxx ou EXTENSAO_PAT_TOKEN.');
    }

    // Debug: mostrar qual token está sendo usado
    logger.info(`[Extensão] 🔑 Token PAT recebido: ${patToken.substring(0, 50)}... (tamanho: ${patToken.length} caracteres)`);

    // Verificar se o token está completo (deve conter refresh_token se for completo)
    if (patToken.includes('refresh_token=')) {
        logger.info(`[Extensão] ✅ Token PAT completo (contém refresh_token)`);
    } else {
        logger.warn(`[Extensão] ⚠️ Token PAT pode estar incompleto (não contém refresh_token)`);
    }

    logger.info('[Extensão] Iniciando sincronização via controller SaaS...');
    const resultado = await sincronizacaoController.iniciarSincronizacao(patToken, options.forcarExecucao ?? false, {
        geminiApiKey: configuracoesAtuais.config.geminiApiKey || options.geminiApiKey,
        tramitacaoApiToken: configuracoesAtuais.config.tramitacaoApiToken || options.tramitacaoApiToken,
    });

    if (!resultado.success || !resultado.jobId) {
        throw new Error(resultado.message || 'Falha ao iniciar sincronização');
    }

    logger.info(`[Sincronização] Job ${resultado.jobId} iniciado. Monitorando progresso...`);

    const jobId = resultado.jobId;
    let jobFinalizado = false;

    while (!jobFinalizado) {
        const status = await sincronizacaoController.obterStatus(jobId);
        if (!status) {
            throw new Error('Job não encontrado. Verifique os logs do servidor.');
        }

        if (status.progress) {
            const { total, processados, sucesso, erros } = status.progress;
            logger.info(
                `[Job ${jobId}] Status: ${status.status} | Total: ${total} | Processados: ${processados} | Sucesso: ${sucesso} | Erros: ${erros}`
            );
        } else {
            logger.info(`[Job ${jobId}] Status: ${status.status}`);
        }

        if (status.status === 'completed') {
            jobFinalizado = true;
            logger.info(`[Job ${jobId}] Finalizado com sucesso!`);
            if (status.resultado) {
                logger.info(
                    `[Job ${jobId}] Resumo -> Protocolos: ${status.resultado.protocolosProcessados} | Clientes criados: ${status.resultado.clientesCriados} | Atualizados: ${status.resultado.clientesAtualizados} | Notificações: ${status.resultado.notificacoesEnviadas}`
                );
                if (status.resultado.erros.length > 0) {
                    logger.warn(`[Job ${jobId}] Erros durante execução: ${status.resultado.erros.join(' | ')}`);
                }
            }
        } else if (status.status === 'failed') {
            throw new Error(status.erro || 'Job finalizado com erro');
        } else {
            await new Promise((resolve) => setTimeout(resolve, 5000));
        }
    }
}

(async () => {
    try {
        const email = process.env.EXTENSAO_EMAIL;
        const password = process.env.EXTENSAO_PASSWORD;
        const nome = process.env.EXTENSAO_NOME || 'Usuário Extensão';

        if (!email || !password) {
            throw new Error('Configure EXTENSAO_EMAIL e EXTENSAO_PASSWORD no .env para usar este script.');
        }

        // IMPORTANTE: Para token PAT, usar variável de ambiente (EXTENSAO_PAT_TOKEN)
        // O argumento --tokenPat pode quebrar no PowerShell devido ao caractere &
        // Exemplo de uso:
        //   $env:EXTENSAO_PAT_TOKEN="AT-xxx&token_type=bearer&expires_in=1800&refresh_token=RT-xxx"
        //   npm run run:extensao-sync

        await executarSincronizacao({
            email,
            password,
            nome,
            geminiApiKey: process.env.EXTENSAO_GEMINI_KEY || process.env.GEMINI_API_KEY,
            tramitacaoApiToken: process.env.EXTENSAO_TRAMITACAO_TOKEN || process.env.TRAMITACAO_API_TOKEN,
            patToken: process.env.EXTENSAO_PAT_TOKEN || getArgValue('tokenPat'), // Priorizar env sobre arg
            forcarExecucao: getArgValue('forcar') === 'true',
        });

        logger.info('[Extensão] Sincronização concluída.');
        process.exit(0);
    } catch (error: any) {
        logger.error('[Extensão] Erro ao executar sincronização SaaS:', error.message || error);
        process.exit(1);
    }
})();
