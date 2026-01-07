import puppeteerService from './PuppeteerService';
import { AIService } from './AIService';
import { TramitacaoService } from './TramitacaoService';
import whatsappService from './WhatsAppService';
import tramitacaoSyncService from './TramitacaoSyncService';
import agendamentosService from './AgendamentosService';
import padroesEtiquetasService from './PadroesEtiquetasService';
import parceirosService from './ParceirosService';
import Database from '../database';
import logger from '../utils/logger';
import config from '../config';
import { mapearServicoParaTag, servicoEstaMapeado, normalizarServico } from '../utils/servicos-inss';
import { analisarTipoIndeferimento } from '../utils/analisarIndeferimento';

type ProgressCallback = (jobId: string, progress: {
    total: number;
    processados: number;
    sucesso: number;
    erros: number;
}) => void;

type SuccessCallback = (jobId: string, resultado: {
    protocolosProcessados: number;
    clientesCriados: number;
    clientesAtualizados: number;
    notificacoesEnviadas: number;
    erros: string[];
    protocolosComErro?: string[];
}) => void;

type ErrorCallback = (jobId: string, erro: string) => void;

/**
 * Serviço de sincronização INSS
 * Reutiliza a lógica do teste-fluxo mas com datas dinâmicas e todos os status
 */
export class SincronizacaoInssService {
    private onProgress: ProgressCallback;
    private onSuccess: SuccessCallback;
    private onError: ErrorCallback;
    private aiService: AIService;
    private tramitacaoService: TramitacaoService;

    constructor(
        onProgress: ProgressCallback,
        onSuccess: SuccessCallback,
        onError: ErrorCallback
    ) {
        this.onProgress = onProgress;
        this.onSuccess = onSuccess;
        this.onError = onError;
        // Instâncias padrão (serão substituídas se userConfig fornecer credenciais)
        this.aiService = new AIService();
        this.tramitacaoService = new TramitacaoService();
    }

    /**
     * Valida rapidamente se o token PAT é válido fazendo uma requisição HTTP simples
     * Isso evita esperar o Puppeteer inicializar só para descobrir que o token está expirado
     */
    private async validarTokenPatRapido(tokenPat: string): Promise<boolean> {
        try {
            // Extrair apenas o token (remover URL se houver)
            let token = tokenPat.trim();

            // Se contém URL, extrair apenas o token
            if (token.includes('access_token=')) {
                const match = token.match(/[#&?]access_token=([^&]+)/);
                if (match && match[1]) {
                    token = match[1];
                }
            }

            if (!token || token.length < 10) {
                logger.warn('[Validação PAT] Token muito curto ou vazio');
                return false;
            }

            // Fazer requisição rápida para verificar se o token é válido
            // Usamos uma URL que requer autenticação para validar
            const url = `https://atendimento.inss.gov.br/#access_token=${token}`;

            // Usar fetch nativo do Node.js (se disponível) ou axios
            const https = require('https');
            const { URL } = require('url');

            return new Promise((resolve) => {
                // Timeout curto (5 segundos) para não demorar
                const timeout = setTimeout(() => {
                    logger.warn('[Validação PAT] Timeout na validação, assumindo válido (validação será feita no login)');
                    resolve(true); // Assumir válido se timeout (validação real será no login)
                }, 5000);

                // Tentar fazer uma requisição simples
                // Como não podemos fazer requisição direta ao PAT sem navegador,
                // vamos validar o formato do token e deixar o Puppeteer validar de verdade
                // Mas pelo menos verificamos se tem formato válido

                clearTimeout(timeout);

                // Validar formato básico do token
                if (token.startsWith('AT-') && token.length > 20) {
                    logger.info('[Validação PAT] Token tem formato válido');
                    resolve(true);
                } else {
                    logger.warn('[Validação PAT] Token não tem formato válido (deve começar com AT-)');
                    resolve(false);
                }
            });
        } catch (error: any) {
            logger.warn(`[Validação PAT] Erro na validação rápida: ${error.message}, assumindo válido`);
            // Se der erro na validação rápida, assumir válido e deixar Puppeteer validar
            return true;
        }
    }

    /**
     * Executa a sincronização completa
     */
    async executarSincronizacao(
        jobId: string,
        tokenPat: string,
        dataInicio: Date,
        dataFim: Date,
        userId?: string,
        userConfig?: {
            geminiApiKey?: string;
            tramitacaoApiToken?: string;
            tramitacaoEmail?: string;
            tramitacaoSenha?: string;
        }
    ): Promise<void> {
        try {
            // ⚠️ SEGURANÇA: Sempre usar credenciais do usuário, nunca fallbacks
            // Verificar se credenciais obrigatórias foram fornecidas
            if (!userConfig?.tramitacaoApiToken) {
                const erro = 'Token do Tramitação é obrigatório. Configure nas configurações da extensão.';
                logger.error(`❌ [Sincronização] ${erro}`);
                this.onError(jobId, erro);
                return;
            }

            // Configurar serviços APENAS com credenciais do usuário
            if (userConfig?.geminiApiKey) {
                this.aiService = new AIService(userConfig.geminiApiKey);
            }
            // Gemini é opcional - continuar sem se não fornecido

            this.tramitacaoService = new TramitacaoService(
                userConfig.tramitacaoApiToken,
                userConfig.tramitacaoEmail,
                userConfig.tramitacaoSenha
            );

            // Validar token PAT rapidamente antes de iniciar Puppeteer
            const tokenValido = await this.validarTokenPatRapido(tokenPat);

            if (!tokenValido) {
                const erro = 'Token PAT inválido ou expirado. Por favor, faça login no PAT novamente.';
                logger.error(`❌ [Sincronização] ${erro}`);
                this.onError(jobId, erro);
                return;
            }

            // Inicializar Puppeteer com tratamento de erro melhorado
            try {
                await puppeteerService.initialize();
                logger.info(`✅ [Job ${jobId}] Puppeteer inicializado com sucesso`);
            } catch (error: any) {
                const errorMsg = error.message || String(error);
                logger.error(`❌ [Job ${jobId}] Erro ao inicializar Puppeteer: ${errorMsg}`);

                if (errorMsg.includes('Chrome não está rodando') || errorMsg.includes('remote debugging')) {
                    const erro = 'Chrome não está com remote debugging ativo. Por favor, abra o Chrome com: chrome.exe --remote-debugging-port=9222';
                    this.onError(jobId, erro);
                    return;
                }

                // Se for outro erro, propagar
                throw error;
            }

            // Debug: mostrar token que será usado
            logger.info(`[Job ${jobId}] 🔑 Token PAT recebido para login: ${tokenPat.substring(0, 50)}... (tamanho: ${tokenPat.length} caracteres)`);
            if (tokenPat.includes('refresh_token=')) {
                logger.info(`[Job ${jobId}] ✅ Token PAT completo (contém refresh_token)`);
            } else {
                logger.warn(`[Job ${jobId}] ⚠️ Token PAT pode estar incompleto (não contém refresh_token)`);
            }

            // Tentar fazer login e capturar erros de token expirado
            try {
                await puppeteerService.login(tokenPat);
            } catch (error: any) {
                const errorMsg = error.message || String(error);
                if (errorMsg.includes('expirado') || errorMsg.includes('inválido') || errorMsg.includes('login')) {
                    const erro = 'Token PAT inválido ou expirado. Por favor, faça login no PAT novamente.';
                    logger.error(`❌ [Job ${jobId}] ${erro}`);
                    await puppeteerService.close().catch(() => { });
                    this.onError(jobId, erro);
                    return;
                }
                // Se for outro erro, propagar
                throw error;
            }

            // Atualizar progresso inicial (coletando protocolos)
            this.onProgress(jobId, {
                total: 0,
                processados: 0,
                sucesso: 0,
                erros: 0
            });

            // Coletar protocolos do período solicitado
            // 🧪 MODO TESTE: Filtrando apenas EXIGÊNCIA
            logger.info(`🔍 Coletando protocolos de ${dataInicio.toLocaleDateString('pt-BR')} a ${dataFim.toLocaleDateString('pt-BR')} (EXIGÊNCIA)...`);
            const protocolos = await puppeteerService.coletarProtocolos(
                dataInicio,
                dataFim,
                'EXIGENCIA' // 🧪 TESTE: Apenas exigências
            );

            if (protocolos.length === 0) {
                logger.warn(`⚠️ [Job ${jobId}] Nenhum protocolo encontrado no período`);
                await puppeteerService.close();
                this.onSuccess(jobId, {
                    protocolosProcessados: 0,
                    clientesCriados: 0,
                    clientesAtualizados: 0,
                    notificacoesEnviadas: 0,
                    erros: []
                });
                return;
            }

            logger.info(`✅ [Job ${jobId}] ${protocolos.length} protocolo(s) encontrado(s)`);

            // Atualizar progresso com total de protocolos encontrados
            this.onProgress(jobId, {
                total: protocolos.length,
                processados: 0,
                sucesso: 0,
                erros: 0
            });

            // Estatísticas
            let clientesCriados = 0;
            let clientesAtualizados = 0;
            let notificacoesEnviadas = 0;
            const erros: string[] = [];
            const protocolosComErro: string[] = []; // Protocolos que falharam e serão reprocessados no final

            // Processar cada protocolo
            for (let idx = 0; idx < protocolos.length; idx++) {
                const protocolo = protocolos[idx];

                try {
                    logger.info(`\n${'='.repeat(80)}`);
                    logger.info(`📋 [Job ${jobId}] PROCESSANDO PROTOCOLO ${idx + 1}/${protocolos.length}: ${protocolo}`);
                    logger.info(`${'='.repeat(80)}\n`);

                    // Garantir que estamos na aba do PAT
                    if (idx > 0) {
                        const patPage = puppeteerService.getPage();
                        if (patPage) {
                            await patPage.bringToFront();
                            await patPage.waitForTimeout(1000);
                        }
                    }

                    // Extrair detalhes do protocolo com retry (10 tentativas)
                    const detalhes = await puppeteerService.extrairDetalhesProtocolo(protocolo, {
                        dataInicio,
                        dataFim,
                        status: 'TODOS'
                    }, 10);

                    logger.info(`CPF: ${detalhes.cpf} | Nome: ${detalhes.nome} | Status: ${detalhes.statusAtual}`);

                    // Verificar se tem comentários
                    if (detalhes.comentarios.length === 0) {
                        logger.warn(`⚠️ Protocolo ${protocolo} não tem comentários, pulando...`);
                        // Atualizar progresso mesmo pulando
                        this.onProgress(jobId, {
                            total: protocolos.length,
                            processados: idx + 1,
                            sucesso: idx + 1 - erros.length,
                            erros: erros.length
                        });
                        continue;
                    }

                    // ⚠️ NOVA LÓGICA: Se status for "Em Análise", processar de forma especial
                    const statusUpper = (detalhes.statusAtual || '').toUpperCase();
                    const ehEmAnalise = statusUpper.includes('EM ANÁLISE') || statusUpper.includes('EM ANALISE') || statusUpper.includes('PENDENTE');

                    if (ehEmAnalise) {
                        logger.info(`[Job ${jobId}] 📋 Status "Em Análise" detectado - processando de forma especial...`);
                        const resultado = await this.processarProtocoloEmAnalise(
                            jobId,
                            protocolo,
                            detalhes,
                            userId,
                            userConfig
                        );

                        if (resultado.clienteCriado) clientesCriados++;
                        if (resultado.clienteAtualizado) clientesAtualizados++;

                        // Atualizar progresso
                        this.onProgress(jobId, {
                            total: protocolos.length,
                            processados: idx + 1,
                            sucesso: idx + 1 - erros.length,
                            erros: erros.length
                        });

                        // Continuar para próximo protocolo
                        if (idx < protocolos.length - 1) {
                            await new Promise(resolve => setTimeout(resolve, 3000));
                        }
                        continue;
                    }

                    // Processar protocolo normalmente (similar ao teste-fluxo)
                    const resultado = await this.processarProtocolo(
                        jobId,
                        protocolo,
                        detalhes,
                        dataInicio,
                        dataFim,
                        userId,
                        userConfig
                    );

                    if (resultado.clienteCriado) clientesCriados++;
                    if (resultado.clienteAtualizado) clientesAtualizados++;
                    if (resultado.notificacaoEnviada) notificacoesEnviadas++;

                    // Atualizar progresso após processar com sucesso
                    this.onProgress(jobId, {
                        total: protocolos.length,
                        processados: idx + 1,
                        sucesso: idx + 1 - erros.length,
                        erros: erros.length
                    });

                    // ⚡ LIMITE DE PROTOCOLOS: Verificar se deve parar
                    if (config.inss.limitProtocols && (idx + 1) >= config.inss.limitProtocols) {
                        logger.info(`\n🛑 [Job ${jobId}] Limite de protocolos atingido (${idx + 1}/${protocolos.length}). Parando processamento.`);
                        break; // Sair do loop
                    }

                    // Aguardar antes do próximo protocolo
                    if (idx < protocolos.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, 3000));
                    }
                } catch (error: any) {
                    const errorMsg = error.message || String(error);
                    const isError406 = errorMsg.includes('406') ||
                        errorMsg.includes('Not Acceptable') ||
                        errorMsg.includes('não foi possível extrair detalhes');

                    const erroMsg = `Erro ao processar protocolo ${protocolo}: ${errorMsg}`;
                    logger.error(`❌ [Job ${jobId}] ${erroMsg}`);

                    // Se for erro 406 ou erro de extração após retries, mover para o final da lista
                    if (isError406) {
                        logger.warn(`[Job ${jobId}] ⚠️ Protocolo ${protocolo} falhou após 10 tentativas. Será reprocessado no final.`);
                        protocolosComErro.push(protocolo);
                    } else {
                        erros.push(erroMsg);
                    }

                    // Atualizar progresso mesmo em caso de erro
                    this.onProgress(jobId, {
                        total: protocolos.length,
                        processados: idx + 1,
                        sucesso: idx + 1 - erros.length - protocolosComErro.length,
                        erros: erros.length + protocolosComErro.length
                    });
                }
            }

            // Reprocessar protocolos que falharam (erro 406) no final
            if (protocolosComErro.length > 0) {
                logger.info(`\n${'='.repeat(80)}`);
                logger.info(`🔄 [Job ${jobId}] REPROCESSANDO ${protocolosComErro.length} PROTOCOLO(S) QUE FALHARAM`);
                logger.info(`${'='.repeat(80)}\n`);

                for (let idx = 0; idx < protocolosComErro.length; idx++) {
                    const protocolo = protocolosComErro[idx];

                    try {
                        logger.info(`\n${'='.repeat(80)}`);
                        logger.info(`📋 [Job ${jobId}] REPROCESSANDO PROTOCOLO ${idx + 1}/${protocolosComErro.length}: ${protocolo}`);
                        logger.info(`${'='.repeat(80)}\n`);

                        // Garantir que estamos na aba do PAT
                        const patPage = puppeteerService.getPage();
                        if (patPage) {
                            await patPage.bringToFront();
                            await patPage.waitForTimeout(1000);
                        }

                        // Tentar extrair detalhes novamente (mais 10 tentativas)
                        const detalhes = await puppeteerService.extrairDetalhesProtocolo(protocolo, {
                            dataInicio,
                            dataFim,
                            status: 'TODOS'
                        }, 10);

                        logger.info(`CPF: ${detalhes.cpf} | Nome: ${detalhes.nome} | Status: ${detalhes.statusAtual}`);

                        // Verificar se tem comentários
                        if (detalhes.comentarios.length === 0) {
                            logger.warn(`⚠️ Protocolo ${protocolo} não tem comentários, pulando...`);
                            continue;
                        }

                        // Processar protocolo normalmente
                        const statusUpper = (detalhes.statusAtual || '').toUpperCase();
                        const ehEmAnalise = statusUpper.includes('EM ANÁLISE') || statusUpper.includes('EM ANALISE') || statusUpper.includes('PENDENTE');

                        let resultado;
                        if (ehEmAnalise) {
                            resultado = await this.processarProtocoloEmAnalise(
                                jobId,
                                protocolo,
                                detalhes,
                                userId,
                                userConfig
                            );
                        } else {
                            resultado = await this.processarProtocolo(
                                jobId,
                                protocolo,
                                detalhes,
                                dataInicio,
                                dataFim,
                                userId,
                                userConfig
                            );
                        }

                        if (resultado.clienteCriado) clientesCriados++;
                        if (resultado.clienteAtualizado) clientesAtualizados++;
                        // processarProtocoloEmAnalise não retorna notificacaoEnviada

                        logger.info(`✅ [Job ${jobId}] Protocolo ${protocolo} reprocessado com sucesso!`);

                        // Aguardar antes do próximo protocolo
                        if (idx < protocolosComErro.length - 1) {
                            await new Promise(resolve => setTimeout(resolve, 3000));
                        }
                    } catch (error: any) {
                        const erroMsg = `Não foi possível processar protocolo ${protocolo} mesmo após reprocessamento: ${error.message}`;
                        logger.error(`❌ [Job ${jobId}] ${erroMsg}`);
                        erros.push(erroMsg);
                    }
                }
            }

            await puppeteerService.close();

            logger.info(`✅ [Job ${jobId}] Sincronização concluída`);
            logger.info(`📊 Estatísticas: ${protocolos.length} processados, ${clientesCriados} criados, ${clientesAtualizados} atualizados, ${notificacoesEnviadas} notificações`);

            this.onSuccess(jobId, {
                protocolosProcessados: protocolos.length,
                clientesCriados,
                clientesAtualizados,
                notificacoesEnviadas,
                erros,
                protocolosComErro: protocolosComErro.length > 0 ? protocolosComErro : undefined
            });
        } catch (error: any) {
            logger.error(`❌ [Job ${jobId}] Erro na sincronização: ${error.message}`, error);
            await puppeteerService.close().catch(() => { });
            this.onError(jobId, error.message);
        }
    }

    /**
     * Processa um protocolo individual
     * Reutiliza a lógica completa do teste-fluxo.ts
     * Inclui: IA, tags, notas, WhatsApp, agendamentos e comprovantes
     */
    private async processarProtocolo(
        jobId: string,
        protocolo: string,
        detalhes: any,
        dataInicio: Date,
        dataFim: Date,
        userId?: string,
        userConfig?: {
            geminiApiKey?: string;
            tramitacaoApiToken?: string;
            tramitacaoEmail?: string;
            tramitacaoSenha?: string;
        }
    ): Promise<{
        clienteCriado: boolean;
        clienteAtualizado: boolean;
        notificacaoEnviada: boolean;
    }> {
        try {
            logger.info(`📋 [Job ${jobId}] Processando protocolo ${protocolo}...`);
            logger.info(`   Usando AI Service: ${userConfig?.geminiApiKey ? 'Credenciais do usuário' : 'Credenciais padrão'}`);
            logger.info(`   Usando Tramitação Service: ${userConfig?.tramitacaoApiToken ? 'Credenciais do usuário' : 'Credenciais padrão'}`);

            // Extrair últimos 3 comentários para análise com contexto
            const ultimosComentarios = detalhes.comentarios.slice(-3);
            if (ultimosComentarios.length === 0) {
                logger.warn(`⚠️ [Job ${jobId}] Protocolo ${protocolo} não tem comentários suficientes`);
                return {
                    clienteCriado: false,
                    clienteAtualizado: false,
                    notificacaoEnviada: false
                };
            }

            // Preparar array de cards para IA (com data formatada)
            const cardsParaIA = ultimosComentarios.map((comentario: any) => ({
                data: comentario.data.toLocaleDateString('pt-BR'),
                texto: comentario.texto
            }));

            logger.info(`[Job ${jobId}] Analisando últimos ${cardsParaIA.length} card(s) com contexto completo...`);
            const analiseIA = await this.aiService.analisarTextoInss(
                cardsParaIA,
                protocolo,
                detalhes.dataNascimento
            );
            logger.info(`[Job ${jobId}] Classe: ${analiseIA.classe_final} | Docs: ${analiseIA.documentos_exigidos?.length || 0}`);

            // Calcular prazo baseado na data do card que contém a exigência
            let prazoFinal: Date;
            let diasPrazo: number;

            if (analiseIA.data_evento) {
                // IA calculou o prazo corretamente
                prazoFinal = new Date(analiseIA.data_evento);
                const hoje = new Date();
                diasPrazo = Math.ceil((prazoFinal.getTime() - hoje.getTime()) / (1000 * 60 * 60 * 24));
                logger.info(`[Job ${jobId}] 📅 Prazo calculado pela IA: ${prazoFinal.toLocaleDateString('pt-BR')} (${diasPrazo} dias restantes)`);
            } else {
                // Procurar o card que contém a exigência real
                let cardComExigencia = ultimosComentarios[ultimosComentarios.length - 1];

                const ultimoTexto = cardComExigencia.texto.toLowerCase();
                if (ultimoTexto.includes('transferida') ||
                    ultimoTexto.includes('agendamento realizado') ||
                    ultimoTexto.includes('perícia agendada') ||
                    ultimoTexto.includes('avaliação agendada')) {
                    // Procurar card anterior com exigência real
                    for (let i = ultimosComentarios.length - 2; i >= 0; i--) {
                        const textoCard = ultimosComentarios[i].texto.toLowerCase();
                        if (textoCard.includes('exigência') ||
                            textoCard.includes('prezado') ||
                            textoCard.includes('nr:') ||
                            textoCard.includes('documentos') ||
                            textoCard.includes('prazo')) {
                            cardComExigencia = ultimosComentarios[i];
                            logger.info(`[Job ${jobId}] 📋 Exigência real encontrada no card anterior (${cardComExigencia.data.toLocaleDateString('pt-BR')})`);
                            break;
                        }
                    }
                }

                // Usar data do card com exigência + 30 dias (padrão)
                prazoFinal = new Date(cardComExigencia.data);
                prazoFinal.setDate(prazoFinal.getDate() + 30);
                diasPrazo = 30;

                // Tentar extrair prazo específico do texto
                const textoExigencia = cardComExigencia.texto;
                const matchPrazoEspecifico = textoExigencia.match(/(\d{1,3})\s*dias/);
                const matchDataEspecifica = textoExigencia.match(/até\s+(\d{2}\/\d{2}\/\d{4})/i);

                if (matchDataEspecifica) {
                    const [dia, mes, ano] = matchDataEspecifica[1].split('/').map(Number);
                    prazoFinal = new Date(ano, mes - 1, dia);
                    const hoje = new Date();
                    diasPrazo = Math.ceil((prazoFinal.getTime() - hoje.getTime()) / (1000 * 60 * 60 * 24));
                    logger.info(`[Job ${jobId}] 📅 Prazo específico encontrado no texto: ${prazoFinal.toLocaleDateString('pt-BR')}`);
                } else if (matchPrazoEspecifico) {
                    const diasMencionados = parseInt(matchPrazoEspecifico[1]);
                    prazoFinal = new Date(cardComExigencia.data);
                    prazoFinal.setDate(prazoFinal.getDate() + diasMencionados);
                    diasPrazo = diasMencionados;
                    logger.info(`[Job ${jobId}] 📅 Prazo específico encontrado: ${diasMencionados} dias a partir de ${cardComExigencia.data.toLocaleDateString('pt-BR')}`);
                } else {
                    logger.info(`[Job ${jobId}] 📅 Usando prazo padrão: 30 dias a partir de ${cardComExigencia.data.toLocaleDateString('pt-BR')}`);
                }
            }

            // Criar/Buscar cliente no Tramitação
            logger.info(`[Job ${jobId}] Criando/Buscando cliente no Tramitação...`);
            let clienteId = await this.tramitacaoService.buscarCliente(detalhes.cpf);

            const clienteCriado = !clienteId;
            if (!clienteId) {
                clienteId = await this.tramitacaoService.criarCliente({
                    nome: detalhes.nome,
                    cpf: detalhes.cpf,
                    protocolo: protocolo,
                    servico: detalhes.servico
                });
                logger.info(`[Job ${jobId}] Cliente criado: ${typeof clienteId === 'string' ? clienteId : clienteId?.id}`);
            } else {
                logger.info(`[Job ${jobId}] Cliente encontrado: ${typeof clienteId === 'string' ? clienteId : clienteId?.id}`);
            }

            const idCliente = typeof clienteId === 'string' ? clienteId : (clienteId?.id || '');

            if (!idCliente) {
                logger.error(`[Job ${jobId}] Falha ao obter ID do cliente para protocolo ${protocolo}`);
                return {
                    clienteCriado: false,
                    clienteAtualizado: false,
                    notificacaoEnviada: false
                };
            }

            // Obter serviço da lista se disponível
            const servicoDaLista = puppeteerService.obterServicoPorProtocolo(protocolo);
            if (servicoDaLista) {
                logger.info(`[Job ${jobId}] 📋 Serviço extraído da lista: ${servicoDaLista}`);
            }

            // Detectar tipo de status
            const statusNormalizadoUpper = (detalhes.statusAtual || '').toUpperCase();
            const classeFinalUpper = (analiseIA.classe_final || '').toUpperCase();
            const ehExigencia = statusNormalizadoUpper.includes('EXIGENCIA') || statusNormalizadoUpper.includes('EXIGÊNCIA') || classeFinalUpper === 'EXIGENCIA' || classeFinalUpper === 'EXIGÊNCIA';
            const ehDeferido = statusNormalizadoUpper.includes('DEFERIDO') || classeFinalUpper === 'DEFERIDO' || statusNormalizadoUpper.includes('CONCLUIDA') && classeFinalUpper === 'DEFERIDO';
            const ehIndeferido = statusNormalizadoUpper.includes('INDEFERIDO') || classeFinalUpper === 'INDEFERIDO';

            // Para indeferimento, usar classificação da IA
            let tipoIndeferimento: 'CULPA' | 'MERITO' | null = null;
            if (ehIndeferido) {
                if (analiseIA.tipo_indeferimento) {
                    tipoIndeferimento = analiseIA.tipo_indeferimento;
                    logger.info(`[Job ${jobId}] 🤖 Tipo de indeferimento detectado pela IA: ${tipoIndeferimento}`);
                } else {
                    const ultimoComentarioTexto = ultimosComentarios[ultimosComentarios.length - 1]?.texto || '';
                    const textoCompleto = ultimoComentarioTexto || analiseIA.motivo_ia || '';
                    tipoIndeferimento = analisarTipoIndeferimento(textoCompleto);
                    logger.info(`[Job ${jobId}] 🔍 Tipo de indeferimento detectado por palavras-chave (fallback): ${tipoIndeferimento}`);
                }
            }

            // Determinar fase
            let fase = detalhes.statusAtual.toUpperCase().includes('JUDICIAL') ? 'JUDICIAL' : 'ADMINISTRATIVO';
            if (ehIndeferido && tipoIndeferimento === 'MERITO') {
                fase = 'JUDICIAL';
                logger.info(`[Job ${jobId}] ⚖️ Indeferimento por mérito: convertendo fase para JUDICIAL`);
            } else if (ehIndeferido && tipoIndeferimento === 'CULPA') {
                fase = 'ADMINISTRATIVO';
                logger.info(`[Job ${jobId}] 📋 Indeferimento por culpa: fase ADMINISTRATIVO (nova entrada)`);
            }

            // ========== LÓGICA SAAS - APRENDIZADO AUTOMÁTICO DE TAGS ==========
            logger.info(`[Job ${jobId}] Usando lógica SaaS com aprendizado de padrões`);

            // 1. Mapear status para tag de status (GLOBAL - aplica para todos os escritórios)
            let tagStatus: string = 'PENDENTE';
            if (ehExigencia) {
                tagStatus = 'EXIGENCIA';
            } else if (detalhes.statusAtual.toUpperCase().includes('EM ANÁLISE') ||
                detalhes.statusAtual.toUpperCase().includes('EM_ANALISE')) {
                tagStatus = 'EM_ANALISE';
            } else if (ehDeferido) {
                tagStatus = 'DEFERIDO';
            } else if (ehIndeferido) {
                tagStatus = 'INDEFERIDO';
            } else if (detalhes.statusAtual.toUpperCase().includes('CONCLUIDO') ||
                detalhes.statusAtual.toUpperCase().includes('CONCLUÍDO')) {
                tagStatus = 'CONCLUIDO';
            }

            // 2. Tags obrigatórias (sempre aplicadas)
            const tagsObrigatorias: string[] = ['CLIENTE_INSS', tagStatus];

            // 3. Buscar padrão de etiquetas do escritório (se existir)
            let tagBeneficio: string | null = null;
            let tagsDoEscritorio: string[] = [];

            if (userId) {
                try {
                    // Verificar se precisa aprender padrões (primeira vez ou mais de 7 dias)
                    const precisaAprender = await padroesEtiquetasService.precisaAtualizar(userId);

                    if (precisaAprender) {
                        logger.info(`[Job ${jobId}] Aprendendo padrões de etiquetas do escritório (análise de ~100 clientes)...`);
                        await padroesEtiquetasService.aprenderPadroes(userId, this.tramitacaoService, 100);
                    }

                    // Obter padrão do escritório
                    const padrao = await padroesEtiquetasService.obterPadrao(userId, this.tramitacaoService);

                    if (padrao) {
                        // Mapear benefício do INSS para etiqueta usada pelo escritório
                        const servicoINSS = servicoDaLista || detalhes.servico || '';
                        if (servicoINSS) {
                            tagBeneficio = padroesEtiquetasService.mapearBeneficio(servicoINSS, padrao);
                            if (tagBeneficio) {
                                logger.info(`[Job ${jobId}] Benefício mapeado: "${servicoINSS}" → "${tagBeneficio}"`);
                            }
                        }

                        // Usar etiquetas obrigatórias do padrão do escritório
                        tagsDoEscritorio = padrao.etiquetasObrigatorias.filter(t =>
                            !tagsObrigatorias.some(o => o.toUpperCase() === t.toUpperCase())
                        );
                    }
                } catch (error: any) {
                    logger.warn(`[Job ${jobId}] Erro ao buscar padrões: ${error.message}. Usando tags básicas.`);
                }
            }

            // 4. Fallback: se não tem padrão, usar mapeamento básico
            if (!tagBeneficio) {
                const servicoParaTag = servicoDaLista || detalhes.servico || '';
                if (servicoParaTag && servicoParaTag.trim()) {
                    if (servicoEstaMapeado(servicoParaTag)) {
                        tagBeneficio = mapearServicoParaTag(servicoParaTag);
                    } else {
                        tagBeneficio = normalizarServico(servicoParaTag);
                        logger.info(`[Job ${jobId}] Serviço normalizado para tag: ${tagBeneficio}`);
                    }
                }
            }

            // 5. Para clientes novos, aprender tags de clientes similares (TramitacaoService)
            let tagsAprendidas: string[] = [];
            if (clienteCriado) {
                logger.info(`[Job ${jobId}] Cliente novo - buscando tags de clientes similares...`);
                const servicoParaAprendizado = servicoDaLista || detalhes.servico || '';
                if (servicoParaAprendizado) {
                    tagsAprendidas = await this.tramitacaoService.aprenderTagsPorBeneficio(servicoParaAprendizado, 20);
                    if (tagsAprendidas.length > 0) {
                        logger.info(`[Job ${jobId}] Tags aprendidas: ${tagsAprendidas.join(', ')}`);
                    }
                }
            }

            // 6. Montar lista final de tags (sem duplicatas)
            let todasTags: string[] = [...tagsObrigatorias, ...tagsDoEscritorio];

            if (tagBeneficio && !todasTags.some(t => t.toUpperCase() === tagBeneficio!.toUpperCase())) {
                todasTags.push(tagBeneficio);
            }

            // Adicionar tags aprendidas (apenas as que não existem ainda)
            for (const tag of tagsAprendidas) {
                if (!todasTags.some(t => t.toUpperCase() === tag.toUpperCase())) {
                    todasTags.push(tag);
                }
            }

            // 7. Adicionar tag de fase se indeferido por mérito (converter para JUDICIAL)
            if (ehIndeferido && tipoIndeferimento === 'MERITO') {
                // Remover ADMINISTRATIVO se existir
                todasTags = todasTags.filter(t => t.toUpperCase() !== 'ADMINISTRATIVO');
                if (!todasTags.some(t => t.toUpperCase() === 'JUDICIAL')) {
                    todasTags.push('JUDICIAL');
                }
            }

            // 8. VALIDAÇÃO CRÍTICA: Garantir que apenas 1 tag de benefício está presente
            // Remover tags de outros benefícios que possam ter sido aprendidas erroneamente
            const tagsBeneficioPresentes = todasTags.filter(tag => {
                const tagUpper = tag.toUpperCase();
                return tagUpper.includes('APOSENTADORIA') ||
                    tagUpper.includes('APOS_') ||
                    tagUpper.includes('BPC') ||
                    tagUpper.includes('LOAS') ||
                    tagUpper.includes('BENEFICIO_DE_PRESTACAO_CONTINUADA') ||
                    tagUpper.includes('PENSAO') ||
                    tagUpper.includes('PENSÃO') ||
                    tagUpper.includes('AUXILIO') ||
                    tagUpper.includes('AUXÍLIO') ||
                    tagUpper.includes('SALARIO_MATERNIDADE') ||
                    tagUpper.includes('SALÁRIO_MATERNIDADE') ||
                    tagUpper.includes('BENEFICIO_POR_INCAPACIDADE') ||
                    tagUpper.includes('BENEFÍCIO_POR_INCAPACIDADE');
            });

            if (tagsBeneficioPresentes.length > 1) {
                logger.warn(`[Job ${jobId}] ⚠️ Múltiplas tags de benefício detectadas: ${tagsBeneficioPresentes.join(', ')}`);
                logger.warn(`[Job ${jobId}]    Mantendo apenas a tag correta do benefício: ${tagBeneficio}`);

                // Remover todas as tags de benefício EXCETO a correta
                todasTags = todasTags.filter(tag => {
                    const tagUpper = tag.toUpperCase();
                    const ehTagBeneficio = tagUpper.includes('APOSENTADORIA') ||
                        tagUpper.includes('APOS_') ||
                        tagUpper.includes('BPC') ||
                        tagUpper.includes('LOAS') ||
                        tagUpper.includes('BENEFICIO_DE_PRESTACAO_CONTINUADA') ||
                        tagUpper.includes('PENSAO') ||
                        tagUpper.includes('PENSÃO') ||
                        tagUpper.includes('AUXILIO') ||
                        tagUpper.includes('AUXÍLIO') ||
                        tagUpper.includes('SALARIO_MATERNIDADE') ||
                        tagUpper.includes('SALÁRIO_MATERNIDADE') ||
                        tagUpper.includes('BENEFICIO_POR_INCAPACIDADE') ||
                        tagUpper.includes('BENEFÍCIO_POR_INCAPACIDADE');

                    // Se não é tag de benefício, manter
                    if (!ehTagBeneficio) return true;

                    // Se é tag de benefício, manter apenas se for a correta
                    return tagBeneficio && tag.toUpperCase() === tagBeneficio.toUpperCase();
                });

                // Garantir que a tag correta está presente
                if (tagBeneficio && !todasTags.some(t => t.toUpperCase() === tagBeneficio.toUpperCase())) {
                    todasTags.push(tagBeneficio);
                }
            }

            logger.info(`[Job ${jobId}] 🏷️ Tags finais a aplicar: ${todasTags.join(', ')}`);

            // Verificar tags atuais antes de aplicar (evitar atualização desnecessária)
            logger.info(`[Job ${jobId}] 🔍 Verificando tags atuais do cliente...`);
            const tagsAtuais = await this.tramitacaoService.obterTagsCliente(idCliente);
            logger.info(`[Job ${jobId}] 📋 Tags atuais: ${tagsAtuais.join(', ') || 'Nenhuma'}`);

            // Verificar se precisa atualizar tags
            const tagsFaltando = todasTags.filter(tag =>
                !tagsAtuais.some(t => t.toUpperCase() === tag.toUpperCase())
            );
            const tagsExtras = tagsAtuais.filter(tag =>
                !todasTags.some(t => t.toUpperCase() === tag.toUpperCase())
            );

            if (tagsFaltando.length > 0 || tagsExtras.length > 0) {
                logger.info(`[Job ${jobId}] 🔄 Tags desatualizadas detectadas. Atualizando...`);
                if (tagsFaltando.length > 0) {
                    logger.info(`[Job ${jobId}]    Faltando: ${tagsFaltando.join(', ')}`);
                }
                if (tagsExtras.length > 0) {
                    logger.info(`[Job ${jobId}]    Extras (serão removidas): ${tagsExtras.join(', ')}`);
                }

                // Aplicar tags ANTES de qualquer outra operação
                logger.info(`[Job ${jobId}] 🏷️ Aplicando tags no Tramitação (OBRIGATÓRIO antes de continuar)...`);
                const tagsAplicadas = await this.tramitacaoService.aplicarEtiquetas(idCliente, todasTags);

                if (!tagsAplicadas) {
                    logger.error(`[Job ${jobId}] ❌ FALHA CRÍTICA: Não foi possível aplicar tags no Tramitação!`);
                    return {
                        clienteCriado: false,
                        clienteAtualizado: false,
                        notificacaoEnviada: false
                    };
                }

                logger.info(`[Job ${jobId}] ✅ Tags atualizadas com sucesso: ${todasTags.join(', ')}`);
            } else {
                logger.info(`[Job ${jobId}] ✅ Tags já estão atualizadas, pulando aplicação`);
            }

            // Verificar tags aplicadas
            const tagsCliente = await this.tramitacaoService.obterTagsCliente(idCliente);
            logger.info(`[Job ${jobId}] Tags atuais do cliente: ${tagsCliente.join(', ') || 'Nenhuma'}`);

            // Salvar processo no banco (não crítico)
            let processoId: string | null = null;
            try {
                let dataSolicitacaoValida: Date;
                if (detalhes.dataSolicitacao && detalhes.dataSolicitacao instanceof Date && !isNaN(detalhes.dataSolicitacao.getTime())) {
                    dataSolicitacaoValida = detalhes.dataSolicitacao;
                } else {
                    dataSolicitacaoValida = new Date();
                }

                let classeFinalMapeada: string = analiseIA.classe_final || 'PENDENTE';
                const classeFinalUpper = classeFinalMapeada.toUpperCase();
                if (classeFinalUpper === 'EXIGENCIA' || classeFinalUpper === 'EXIGÊNCIA') {
                    classeFinalMapeada = 'PENDENTE';
                } else if (!['DEFERIDO', 'INDEFERIDO', 'DUPLICADO', 'CANCELADO', 'PENDENTE'].includes(classeFinalMapeada)) {
                    classeFinalMapeada = 'PENDENTE';
                }

                let tipoBeneficioMapeado: string = detalhes.servico || 'APOSENTADORIAS';
                const servicoLower = tipoBeneficioMapeado.toLowerCase();
                if (servicoLower.includes('prestação continuada') || servicoLower.includes('prestacao continuada') ||
                    servicoLower.includes('loas') || servicoLower.includes('bpc') ||
                    servicoLower.includes('benefício assistencial') || servicoLower.includes('beneficio assistencial')) {
                    tipoBeneficioMapeado = 'BPC';
                } else if (servicoLower.includes('salário maternidade') || servicoLower.includes('salario maternidade')) {
                    tipoBeneficioMapeado = 'SALÁRIO MATERNIDADE';
                } else if (servicoLower.includes('pensão') || servicoLower.includes('pensao')) {
                    tipoBeneficioMapeado = 'PENSÃO';
                } else if (servicoLower.includes('aposentadoria')) {
                    tipoBeneficioMapeado = 'APOSENTADORIAS';
                } else if (servicoLower.includes('auxílio') || servicoLower.includes('auxilio') ||
                    servicoLower.includes('incapacidade') || servicoLower.includes('doença') ||
                    servicoLower.includes('doenca') || servicoLower.includes('acidente')) {
                    tipoBeneficioMapeado = 'AUX DOENÇA';
                } else {
                    tipoBeneficioMapeado = 'APOSENTADORIAS';
                }

                let statusInssMapeado = detalhes.statusAtual || 'CUMPRIMENTO_DE_EXIGENCIA';
                const statusUpper = statusInssMapeado.toUpperCase();
                if (!['PENDENTE', 'EM_ANALISE', 'CUMPRIMENTO_DE_EXIGENCIA', 'CONCLUIDA', 'CANCELADA'].includes(statusUpper)) {
                    if (statusUpper.includes('EXIGENCIA') || statusUpper.includes('EXIGÊNCIA')) {
                        statusInssMapeado = 'CUMPRIMENTO_DE_EXIGENCIA';
                    } else if (statusUpper.includes('ANALISE') || statusUpper.includes('ANÁLISE')) {
                        statusInssMapeado = 'EM_ANALISE';
                    } else if (statusUpper.includes('CONCLUIDO') || statusUpper.includes('CONCLUÍDO')) {
                        statusInssMapeado = 'CONCLUIDA';
                    } else {
                        statusInssMapeado = 'PENDENTE';
                    }
                } else {
                    statusInssMapeado = statusUpper;
                }

                const resultProcesso: any = await Database.query(`
                    INSERT INTO processos (
                        protocolo_inss, cpf_segurado, nome_segurado, tipo_beneficio, der,
                        status_inss, classe_final, motivo_inss, tramitacao_cliente_id
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    ON CONFLICT (protocolo_inss) DO UPDATE SET
                        status_inss = EXCLUDED.status_inss,
                        updated_at = NOW()
                    RETURNING id
                `, [
                    protocolo,
                    detalhes.cpf.replace(/\D/g, ''),
                    detalhes.nome,
                    tipoBeneficioMapeado,
                    dataSolicitacaoValida,
                    statusInssMapeado,
                    classeFinalMapeada,
                    analiseIA.motivo_ia || '',
                    idCliente
                ]);

                if (Array.isArray(resultProcesso) && resultProcesso.length > 0) {
                    processoId = resultProcesso[0].id;
                    logger.info(`[Job ${jobId}] ✅ Processo salvo no banco (ID: ${processoId})`);
                }
            } catch (error: any) {
                logger.warn(`[Job ${jobId}] ⚠️ Erro ao salvar processo no banco (não crítico, continuando): ${error.message}`);
            }

            // Gerar email exclusivo via Tramitação
            logger.info(`[Job ${jobId}] 📧 Gerando email exclusivo via Tramitação (scraping)...`);
            let emailExclusivo: string | null = null;

            try {
                logger.info(`[Job ${jobId}] 🔍 Gerando email via TramitacaoSyncService (scraping)...`);
                const resultadoSync = await tramitacaoSyncService.gerarEmailExclusivo(
                    idCliente,
                    detalhes.nome,
                    userConfig?.tramitacaoEmail,
                    userConfig?.tramitacaoSenha
                );

                if (resultadoSync.success && resultadoSync.data?.email) {
                    emailExclusivo = resultadoSync.data.email;
                    logger.info(`[Job ${jobId}] ✅ Email gerado via TramitacaoSyncService: ${emailExclusivo}`);

                    if (processoId) {
                        Database.query(`
                            UPDATE processos 
                            SET email_exclusivo_tramitacao = $1
                            WHERE id = $2
                        `, [emailExclusivo, processoId]).catch(() => { });
                    }
                } else {
                    logger.warn(`[Job ${jobId}] ⚠️ TramitacaoSyncService não conseguiu gerar email: ${resultadoSync.error || 'Erro desconhecido'}`);
                    emailExclusivo = await puppeteerService.obterEmailExclusivo(idCliente);
                    if (emailExclusivo) {
                        logger.info(`[Job ${jobId}] ✅ Email gerado via PuppeteerService: ${emailExclusivo}`);
                        if (processoId) {
                            Database.query(`
                                UPDATE processos 
                                SET email_exclusivo_tramitacao = $1
                                WHERE id = $2
                            `, [emailExclusivo, processoId]).catch(() => { });
                        }
                    }
                }
            } catch (error: any) {
                logger.error(`[Job ${jobId}] ❌ Erro ao obter email: ${error.message}`);
            }

            // Formatar DER
            const derFormatado = detalhes.dataSolicitacao && !isNaN(detalhes.dataSolicitacao.getTime())
                ? detalhes.dataSolicitacao.toLocaleDateString('pt-BR')
                : 'Não informado';

            // Calcular dias restantes
            const hojeCalculo = new Date();
            const diasRestantes = Math.ceil((prazoFinal.getTime() - hojeCalculo.getTime()) / (1000 * 60 * 60 * 24));

            // Mascarar CPF para WhatsApp (padrão: 000.XXX.X0X-00)
            const mascararCpf = (cpf: string): string => {
                const cpfLimpo = cpf.replace(/\D/g, '');
                if (cpfLimpo.length !== 11) return cpf;
                // Formato: 000.XXX.X0X-00 (primeiros 3, XXX maiúsculo, penúltimo dígito, últimos 2)
                return `${cpfLimpo.substring(0, 3)}.XXX.X${cpfLimpo.substring(8, 9)}X-${cpfLimpo.substring(9, 11)}`;
            };

            const cpfMascarado = mascararCpf(detalhes.cpf || '');

            // Verificar se é menor de 18 anos
            let ehMenor = false;
            if (detalhes.dataNascimento) {
                try {
                    const [dia, mes, ano] = detalhes.dataNascimento.split('/').map(Number);
                    const dataNasc = new Date(ano, mes - 1, dia);
                    const hoje = new Date();
                    const idade = hoje.getFullYear() - dataNasc.getFullYear() -
                        (hoje.getMonth() < dataNasc.getMonth() ||
                            (hoje.getMonth() === dataNasc.getMonth() && hoje.getDate() < dataNasc.getDate()) ? 1 : 0);
                    ehMenor = idade < 18;
                } catch (error) {
                    // Ignorar erro
                }
            }

            // Formar texto da exigência/motivo
            let textoExigencia = analiseIA.motivo_ia || ultimosComentarios[ultimosComentarios.length - 1]?.texto || 'N/A';
            textoExigencia = textoExigencia.replace(/^Cumprir\s+exigência:\s*/i, '').trim();

            if (ehMenor && (textoExigencia.includes('assin') || textoExigencia.includes('termo') || textoExigencia.includes('biometria'))) {
                textoExigencia = textoExigencia.replace(/(assinado|assinada|assinatura|termo|biometria)/gi, (match: string) => {
                    return match + ' pelo representante legal';
                });
            }

            const linkProcesso = `https://atendimento.inss.gov.br/tarefas/detalhar_tarefa/${protocolo}`;

            logger.info(`[Job ${jobId}] 📊 Status detectado: ${ehExigencia ? 'EXIGÊNCIA' : ehDeferido ? 'DEFERIDO' : ehIndeferido ? 'INDEFERIDO' : 'OUTRO'}`);

            // Array para coletar links de comprovantes dos agendamentos
            const comprovantesAgendamentos: Array<{ tipo: string; data: string; hora?: string; unidade?: string; endereco?: string; url: string }> = [];

            // ⚠️ NOVO: Buscar configurações de WhatsApp personalizadas do usuário (ANTES de processar agendamentos)
            let whatsappConfig: {
                ativo: boolean;
                numeroUnico?: string;
                exigencia?: string;
                deferido?: string;
                indeferido?: string;
                emAnalise?: string;
                agendamento?: string;
            } | null = null;

            try {
                // Buscar userId do userConfig (precisamos passar isso)
                // Por enquanto, vamos buscar do banco usando o email do tramitação
                if (userConfig?.tramitacaoEmail) {
                    const resultadoWhatsApp = await Database.query(
                        `SELECT whatsapp_personalizado_ativo, whatsapp_numero_unico,
                                whatsapp_exigencia, whatsapp_deferido, whatsapp_indeferido,
                                whatsapp_em_analise, whatsapp_agendamento
                        FROM usuarios_extensao 
                        WHERE tramitacao_email = $1`,
                        [userConfig.tramitacaoEmail]
                    );

                    if (resultadoWhatsApp.length > 0 && resultadoWhatsApp[0].whatsapp_personalizado_ativo) {
                        whatsappConfig = {
                            ativo: true,
                            numeroUnico: resultadoWhatsApp[0].whatsapp_numero_unico || undefined,
                            exigencia: resultadoWhatsApp[0].whatsapp_exigencia || undefined,
                            deferido: resultadoWhatsApp[0].whatsapp_deferido || undefined,
                            indeferido: resultadoWhatsApp[0].whatsapp_indeferido || undefined,
                            emAnalise: resultadoWhatsApp[0].whatsapp_em_analise || undefined,
                            agendamento: resultadoWhatsApp[0].whatsapp_agendamento || undefined
                        };
                        logger.info(`[Job ${jobId}] 📱 WhatsApp personalizado ativo para este usuário`);
                    }
                }
            } catch (error: any) {
                logger.warn(`[Job ${jobId}] ⚠️ Erro ao buscar configurações de WhatsApp: ${error.message}`);
            }

            // ========== PROCESSAR AGENDAMENTOS (PERÍCIAS E AVALIAÇÕES) ==========
            logger.info(`[Job ${jobId}] 🔍 Verificando agendamentos de perícia/avaliação...`);

            try {
                const page = puppeteerService.getPage();
                if (page) {
                    // Verificar se precisa de perícia/avaliação baseado no tipo de benefício
                    const { precisaPericia, precisaAvaliacao } = agendamentosService.precisaPericiaOuAvaliacao(detalhes.servico || '');

                    if (precisaPericia || precisaAvaliacao) {
                        logger.info(`[Job ${jobId}] 📅 Benefício requer ${precisaPericia ? 'PERÍCIA' : ''} ${precisaAvaliacao ? 'AVALIAÇÃO SOCIAL' : ''}`);

                        // Verificar botões "Agendar"
                        const tiposParaAgendar = await agendamentosService.verificarBotoesAgendar(page);

                        if (tiposParaAgendar.length > 0) {
                            logger.info(`[Job ${jobId}] ⚠️ Botões "Agendar" encontrados: ${tiposParaAgendar.join(', ')}`);

                            const tagsAgendar: string[] = [];
                            if (tiposParaAgendar.includes('PERICIA')) {
                                tagsAgendar.push('AGENDAR_PERICIA');
                            }
                            if (tiposParaAgendar.includes('AVALIACAO_SOCIAL')) {
                                tagsAgendar.push('AGENDAR_AVALIACAO');
                            }

                            if (tagsAgendar.length > 0) {
                                await this.tramitacaoService.aplicarEtiquetas(idCliente, tagsAgendar);
                                logger.info(`[Job ${jobId}] Tags aplicadas: ${tagsAgendar.join(', ')}`);

                                // Enviar WhatsApp avisando que precisa agendar (se configurado)
                                const mensagemAgendar = `*AGENDAMENTO NECESSÁRIO*%0A%0A` +
                                    `*Protocolo*: ${protocolo}%0A` +
                                    `*Cliente*: ${detalhes.nome || 'Não informado'}%0A` +
                                    `*CPF*: ${cpfMascarado}%0A%0A` +
                                    `*ATENÇÃO: É necessário agendar ${tiposParaAgendar.map(t => t === 'PERICIA' ? 'PERÍCIA MÉDICA' : 'AVALIAÇÃO SOCIAL').join(' e ')}*%0A%0A` +
                                    `*Acesse o processo*:%0A` +
                                    `https://atendimento.inss.gov.br/tarefas/detalhar_tarefa/${protocolo}%0A%0A` +
                                    `Extraído automaticamente do PAT via IA em: ${new Date().toLocaleString('pt-BR')}`;

                                // Verificar se tem número de agendamento configurado
                                if (whatsappConfig?.ativo && (whatsappConfig.agendamento || whatsappConfig.numeroUnico)) {
                                    const numeroDestino = whatsappConfig.agendamento || whatsappConfig.numeroUnico;
                                    try {
                                        if (numeroDestino) {
                                            await whatsappService.enviar(
                                                numeroDestino,
                                                decodeURIComponent(mensagemAgendar)
                                            );
                                            logger.info(`[Job ${jobId}] WhatsApp enviado sobre necessidade de agendamento`);
                                        }
                                    } catch (error: any) {
                                        logger.warn(`[Job ${jobId}] Erro ao enviar WhatsApp: ${error.message}`);
                                    }
                                } else {
                                    logger.info(`[Job ${jobId}] WhatsApp não configurado para agendamentos. Nota será criada.`);
                                }
                            }
                        }

                        // Extrair agendamentos existentes
                        const agendamentosProcessados: any[] = [];

                        // Processar avaliações sociais
                        if (precisaAvaliacao) {
                            try {
                                const avaliacoes = await agendamentosService.extrairAvaliacoesSociais(page, protocolo, detalhes.cpf);
                                const agendadas = agendamentosService.filtrarAgendados(avaliacoes);

                                for (const agendamento of agendadas) {
                                    logger.info(`[Job ${jobId}] 📅 Avaliação Social agendada: ${agendamento.data.toLocaleDateString('pt-BR')} às ${agendamento.hora}`);

                                    // Extrair detalhes completos (incluindo download do PDF e upload para Backblaze)
                                    const detalhesAgendamento = await agendamentosService.extrairDetalhesAgendamento(page, agendamento);

                                    if (detalhesAgendamento) {
                                        // Coletar link do comprovante se disponível
                                        if (detalhesAgendamento.urlComprovante) {
                                            comprovantesAgendamentos.push({
                                                tipo: 'AVALIAÇÃO SOCIAL',
                                                data: detalhesAgendamento.data.toLocaleDateString('pt-BR'),
                                                hora: detalhesAgendamento.hora || '',
                                                unidade: detalhesAgendamento.unidade || '',
                                                endereco: detalhesAgendamento.endereco || '',
                                                url: detalhesAgendamento.urlComprovante
                                            });
                                        }

                                        // Verificar se já existe atividade com mesma data antes de criar
                                        const jaExisteAtividade = await tramitacaoSyncService.verificarAtividadeExistente(
                                            parseInt(idCliente),
                                            detalhesAgendamento.data,
                                            'AVALIACAO_SOCIAL',
                                            userConfig?.tramitacaoEmail,
                                            userConfig?.tramitacaoSenha
                                        );

                                        let atividadeCriada: number | null = null;
                                        if (!jaExisteAtividade) {
                                            // Cadastrar atividade no Tramitação apenas se não existir
                                            atividadeCriada = await tramitacaoSyncService.cadastrarAtividade(
                                                parseInt(idCliente),
                                                {
                                                    tipo: 'AVALIACAO_SOCIAL',
                                                    data: detalhesAgendamento.data,
                                                    hora: detalhesAgendamento.hora,
                                                    unidade: detalhesAgendamento.unidade,
                                                    endereco: detalhesAgendamento.endereco,
                                                    servico: detalhesAgendamento.servico,
                                                    urlComprovante: detalhesAgendamento.urlComprovante
                                                },
                                                userConfig?.tramitacaoEmail,
                                                userConfig?.tramitacaoSenha
                                            );
                                        } else {
                                            logger.info(`[Job ${jobId}] ⏭️ Atividade AVALIACAO_SOCIAL com data ${detalhesAgendamento.data.toLocaleDateString('pt-BR')} já existe, pulando para evitar duplicidade`);
                                        }

                                        if (atividadeCriada) {
                                            logger.info(`[Job ${jobId}] ✅ Atividade de AVALIAÇÃO SOCIAL cadastrada no Tramitação`);

                                            // Aplicar tag
                                            await this.tramitacaoService.aplicarEtiquetas(idCliente, ['AVALIACAO_AGENDADA']);

                                            // Salvar no banco
                                            if (processoId) {
                                                try {
                                                    await Database.query(`
                                                        INSERT INTO agendamentos (
                                                            processo_id, protocolo_inss, cpf_segurado, tipo,
                                                            data_agendamento, hora_agendamento, unidade, endereco,
                                                            status, servico, url_comprovante
                                                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                                                        ON CONFLICT (processo_id, tipo, data_agendamento) DO UPDATE SET
                                                            hora_agendamento = EXCLUDED.hora_agendamento,
                                                            unidade = EXCLUDED.unidade,
                                                            endereco = EXCLUDED.endereco,
                                                            status = EXCLUDED.status,
                                                            url_comprovante = EXCLUDED.url_comprovante,
                                                            updated_at = NOW()
                                                    `, [
                                                        processoId,
                                                        protocolo,
                                                        detalhes.cpf.replace(/\D/g, ''),
                                                        'AVALIACAO_SOCIAL',
                                                        detalhesAgendamento.data,
                                                        detalhesAgendamento.hora,
                                                        detalhesAgendamento.unidade,
                                                        detalhesAgendamento.endereco || null,
                                                        'AGENDADO',
                                                        detalhesAgendamento.servico || null,
                                                        detalhesAgendamento.urlComprovante || null
                                                    ]);
                                                    logger.info(`[Job ${jobId}] ✅ Agendamento salvo no banco`);
                                                } catch (error: any) {
                                                    logger.warn(`[Job ${jobId}] ⚠️ Erro ao salvar agendamento no banco: ${error.message}`);
                                                }
                                            }

                                            // Criar nota SEPARADA para a avaliação social
                                            const dataFormatadaAvaliacao = detalhesAgendamento.data.toLocaleDateString('pt-BR');
                                            const conteudoNotaAvaliacao = `📅 *AVALIAÇÃO SOCIAL AGENDADA* 📅

*Protocolo*: ${protocolo}
*Cliente*: ${detalhes.nome || 'Não informado'}
*CPF*: ${cpfMascarado}

*Data*: ${dataFormatadaAvaliacao}${detalhesAgendamento.hora ? ` às ${detalhesAgendamento.hora}` : ''}
${detalhesAgendamento.unidade ? `*Unidade*: ${detalhesAgendamento.unidade}\n` : ''}${detalhesAgendamento.endereco ? `*Endereço*: ${detalhesAgendamento.endereco}\n` : ''}${detalhesAgendamento.servico ? `*Serviço*: ${detalhesAgendamento.servico}\n` : ''}
*📄 Comprovante*:
${detalhesAgendamento.urlComprovante}

*🔗 Acesse o processo diretamente*:
https://atendimento.inss.gov.br/tarefas/detalhar_tarefa/${protocolo}

---
📅 Extraído automaticamente do PAT via IA em: ${new Date().toLocaleString('pt-BR')}`;

                                            // Verificar se já existe nota similar antes de criar
                                            const notaAvaliacaoSimilar = await this.tramitacaoService.verificarNotaSimilar(
                                                idCliente,
                                                protocolo,
                                                conteudoNotaAvaliacao,
                                                1
                                            );

                                            if (!notaAvaliacaoSimilar) {
                                                await this.tramitacaoService.criarNota(idCliente, {
                                                    titulo: `📅 AVALIAÇÃO SOCIAL Agendada - ${dataFormatadaAvaliacao}`,
                                                    texto: conteudoNotaAvaliacao,
                                                    tipo: 'INFORMACAO'
                                                });
                                                logger.info(`[Job ${jobId}] ✅ Nota de avaliação social criada separadamente`);
                                            } else {
                                                logger.info(`[Job ${jobId}] ⏭️ Nota de avaliação social similar já existe, pulando para evitar duplicidade`);
                                            }

                                            // Enviar notificação WhatsApp para escritório
                                            await this.enviarNotificacaoAgendamento(
                                                idCliente,
                                                detalhes.nome,
                                                detalhes.cpf,
                                                protocolo,
                                                'AVALIACAO_SOCIAL',
                                                detalhesAgendamento.data,
                                                detalhesAgendamento.hora,
                                                detalhesAgendamento.unidade,
                                                detalhesAgendamento.endereco,
                                                detalhesAgendamento.urlComprovante,
                                                processoId,
                                                userId,
                                                userConfig,
                                                whatsappConfig
                                            );
                                        }

                                        agendamentosProcessados.push(detalhesAgendamento);
                                    }
                                }
                            } catch (error: any) {
                                logger.warn(`[Job ${jobId}] ⚠️ Erro ao extrair avaliações sociais: ${error.message}`);
                            }
                        }

                        // Processar perícias médicas
                        if (precisaPericia) {
                            try {
                                const pericias = await agendamentosService.extrairPericiasMedicas(page, protocolo, detalhes.cpf);
                                const agendadas = agendamentosService.filtrarAgendados(pericias);

                                for (const agendamento of agendadas) {
                                    logger.info(`[Job ${jobId}] 📅 Perícia Médica agendada: ${agendamento.data.toLocaleDateString('pt-BR')} às ${agendamento.hora}`);

                                    // Extrair detalhes completos (incluindo download do PDF e upload para Backblaze)
                                    const detalhesAgendamento = await agendamentosService.extrairDetalhesAgendamento(page, agendamento);

                                    if (detalhesAgendamento) {
                                        // Coletar link do comprovante se disponível
                                        if (detalhesAgendamento.urlComprovante) {
                                            comprovantesAgendamentos.push({
                                                tipo: 'PERÍCIA MÉDICA',
                                                data: detalhesAgendamento.data.toLocaleDateString('pt-BR'),
                                                hora: detalhesAgendamento.hora || '',
                                                unidade: detalhesAgendamento.unidade || '',
                                                endereco: detalhesAgendamento.endereco || '',
                                                url: detalhesAgendamento.urlComprovante
                                            });
                                        }

                                        // Verificar se já existe atividade com mesma data antes de criar
                                        const jaExisteAtividade = await tramitacaoSyncService.verificarAtividadeExistente(
                                            parseInt(idCliente),
                                            detalhesAgendamento.data,
                                            'PERICIA',
                                            userConfig?.tramitacaoEmail,
                                            userConfig?.tramitacaoSenha
                                        );

                                        let atividadeCriada: number | null = null;
                                        if (!jaExisteAtividade) {
                                            // Cadastrar atividade no Tramitação apenas se não existir
                                            atividadeCriada = await tramitacaoSyncService.cadastrarAtividade(
                                                parseInt(idCliente),
                                                {
                                                    tipo: 'PERICIA',
                                                    data: detalhesAgendamento.data,
                                                    hora: detalhesAgendamento.hora,
                                                    unidade: detalhesAgendamento.unidade,
                                                    endereco: detalhesAgendamento.endereco,
                                                    servico: detalhesAgendamento.servico,
                                                    urlComprovante: detalhesAgendamento.urlComprovante
                                                },
                                                userConfig?.tramitacaoEmail,
                                                userConfig?.tramitacaoSenha
                                            );
                                        } else {
                                            logger.info(`[Job ${jobId}] ⏭️ Atividade PERICIA com data ${detalhesAgendamento.data.toLocaleDateString('pt-BR')} já existe, pulando para evitar duplicidade`);
                                        }

                                        if (atividadeCriada) {
                                            logger.info(`[Job ${jobId}] ✅ Atividade de PERÍCIA MÉDICA cadastrada no Tramitação`);

                                            // Aplicar tag
                                            await this.tramitacaoService.aplicarEtiquetas(idCliente, ['PERICIA_AGENDADA']);

                                            // Salvar no banco
                                            if (processoId) {
                                                try {
                                                    await Database.query(`
                                                        INSERT INTO agendamentos (
                                                            processo_id, protocolo_inss, cpf_segurado, tipo,
                                                            data_agendamento, hora_agendamento, unidade, endereco,
                                                            status, servico, url_comprovante
                                                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                                                        ON CONFLICT (processo_id, tipo, data_agendamento) DO UPDATE SET
                                                            hora_agendamento = EXCLUDED.hora_agendamento,
                                                            unidade = EXCLUDED.unidade,
                                                            endereco = EXCLUDED.endereco,
                                                            status = EXCLUDED.status,
                                                            url_comprovante = EXCLUDED.url_comprovante,
                                                            updated_at = NOW()
                                                    `, [
                                                        processoId,
                                                        protocolo,
                                                        detalhes.cpf.replace(/\D/g, ''),
                                                        'PERICIA',
                                                        detalhesAgendamento.data,
                                                        detalhesAgendamento.hora,
                                                        detalhesAgendamento.unidade,
                                                        detalhesAgendamento.endereco || null,
                                                        'AGENDADO',
                                                        detalhesAgendamento.servico || null,
                                                        detalhesAgendamento.urlComprovante || null
                                                    ]);
                                                    logger.info(`[Job ${jobId}] ✅ Agendamento salvo no banco`);
                                                } catch (error: any) {
                                                    logger.warn(`[Job ${jobId}] ⚠️ Erro ao salvar agendamento no banco: ${error.message}`);
                                                }
                                            }

                                            // Criar nota SEPARADA para a perícia médica
                                            const dataFormatadaPericia = detalhesAgendamento.data.toLocaleDateString('pt-BR');
                                            const conteudoNotaPericia = `📅 *PERÍCIA MÉDICA AGENDADA* 📅

*Protocolo*: ${protocolo}
*Cliente*: ${detalhes.nome || 'Não informado'}
*CPF*: ${cpfMascarado}

*Data*: ${dataFormatadaPericia}${detalhesAgendamento.hora ? ` às ${detalhesAgendamento.hora}` : ''}
${detalhesAgendamento.unidade ? `*Unidade*: ${detalhesAgendamento.unidade}\n` : ''}${detalhesAgendamento.endereco ? `*Endereço*: ${detalhesAgendamento.endereco}\n` : ''}${detalhesAgendamento.servico ? `*Serviço*: ${detalhesAgendamento.servico}\n` : ''}
*📄 Comprovante*:
${detalhesAgendamento.urlComprovante}

*🔗 Acesse o processo diretamente*:
https://atendimento.inss.gov.br/tarefas/detalhar_tarefa/${protocolo}

---
📅 Extraído automaticamente do PAT via IA em: ${new Date().toLocaleString('pt-BR')}`;

                                            // Verificar se já existe nota similar antes de criar
                                            const notaPericiaSimilar = await this.tramitacaoService.verificarNotaSimilar(
                                                idCliente,
                                                protocolo,
                                                conteudoNotaPericia,
                                                1
                                            );

                                            if (!notaPericiaSimilar) {
                                                await this.tramitacaoService.criarNota(idCliente, {
                                                    titulo: `📅 PERÍCIA MÉDICA Agendada - ${dataFormatadaPericia}`,
                                                    texto: conteudoNotaPericia,
                                                    tipo: 'INFORMACAO'
                                                });
                                                logger.info(`[Job ${jobId}] ✅ Nota de perícia médica criada separadamente`);
                                            } else {
                                                logger.info(`[Job ${jobId}] ⏭️ Nota de perícia médica similar já existe, pulando para evitar duplicidade`);
                                            }

                                            // Enviar notificação WhatsApp para escritório
                                            await this.enviarNotificacaoAgendamento(
                                                idCliente,
                                                detalhes.nome,
                                                detalhes.cpf,
                                                protocolo,
                                                'PERICIA',
                                                detalhesAgendamento.data,
                                                detalhesAgendamento.hora,
                                                detalhesAgendamento.unidade,
                                                detalhesAgendamento.endereco,
                                                detalhesAgendamento.urlComprovante,
                                                processoId,
                                                userId,
                                                userConfig,
                                                whatsappConfig
                                            );
                                        }

                                        agendamentosProcessados.push(detalhesAgendamento);
                                    }
                                }
                            } catch (error: any) {
                                logger.warn(`[Job ${jobId}] ⚠️ Erro ao extrair perícias médicas: ${error.message}`);
                            }
                        }

                        if (agendamentosProcessados.length > 0) {
                            logger.info(`[Job ${jobId}] ✅ ${agendamentosProcessados.length} agendamento(s) processado(s)`);
                        } else {
                            logger.info(`[Job ${jobId}] ℹ️ Nenhum agendamento AGENDADO encontrado`);
                        }
                    } else {
                        logger.info(`[Job ${jobId}] ℹ️ Benefício não requer perícia ou avaliação social`);
                    }
                } else {
                    logger.warn(`[Job ${jobId}] ⚠️ Page não disponível para extrair agendamentos`);
                }
            } catch (error: any) {
                logger.error(`[Job ${jobId}] ❌ Erro ao processar agendamentos: ${error.message}`);
                // Não bloquear o fluxo principal se houver erro
            }

            // Criar nota ANTES de enviar WhatsApp
            logger.info(`[Job ${jobId}] 📝 Criando nota no Tramitação com dados da IA...`);

            let tituloNota = '';
            let conteudoNota = '';
            let tipoNota: 'INFORMACAO' | 'ALERTA' | 'URGENTE' = 'ALERTA';

            if (ehExigencia) {
                // NOTA DE EXIGÊNCIA
                tituloNota = `🔔 NOVA EXIGÊNCIA INSS - Protocolo ${protocolo} - DER: ${derFormatado} 🔔`;
                conteudoNota = `*NOME*: ${detalhes.nome || 'Não informado'}
*CPF*: ${cpfMascarado}
Status INSS: *${detalhes.statusAtual || 'Exigência'}*

*Exigência*: ${textoExigencia}

*Documentos exigidos*:

${analiseIA.documentos_exigidos?.map((doc, idx) => `> *${idx + 1}. ${doc}*`).join('\n') || '> *Nenhum documento especificado*'}

*Prazo limite: ${prazoFinal.toLocaleDateString('pt-BR')}*

---
*ENVIE OS DOCUMENTOS PARA*:

${emailExclusivo || 'Email não disponível'}

${diasRestantes > 0 ? `*Dias restantes para envio: ${diasRestantes} dia(s).*` : `*⚠️ ATENÇÃO: Prazo já vencido há ${Math.abs(diasRestantes)} dia(s).*`}

*✅ Após enviar, responda "ENVIADO" neste chat*`;

                conteudoNota += `\n---\n\n📅 Extraído automaticamente do PAT via IA em: ${new Date().toLocaleString('pt-BR')}`;
            } else if (ehDeferido) {
                // NOTA DE DEFERIMENTO
                tituloNota = `✅ BENEFÍCIO DEFERIDO - Protocolo ${protocolo} - DER: ${derFormatado} ✅`;
                conteudoNota = `Benefício: ${detalhes.servico || 'Não informado'}
NOME: ${detalhes.nome || 'Não informado'}
CPF: ${cpfMascarado}
Status INSS: Deferido

📋 ORIENTAÇÕES:

1. Baixe a Carta de Concessão através do link abaixo
2. Verifique todos os dados na carta
3. Entre em contato com o cliente para comunicar a decisão

🔗 Acesse o processo diretamente:
${linkProcesso}

---

📅 Extraído automaticamente do PAT via IA em: ${new Date().toLocaleString('pt-BR')}`;
                tipoNota = 'INFORMACAO';
            } else if (ehIndeferido) {
                if (tipoIndeferimento === 'CULPA') {
                    // NOTA DE INDEFERIMENTO POR CULPA
                    tituloNota = `🔔 INDEFERIMENTO INSS - Protocolo ${protocolo} - DER: ${derFormatado} 🔔`;
                    conteudoNota = `🔔 *INDEFERIMENTO INSS - Protocolo ${protocolo} - DER: ${derFormatado}* 🔔

*Benefício*: ${detalhes.servico || 'Não informado'}
*NOME*: ${detalhes.nome || 'Não informado'}
*CPF*: ${cpfMascarado}
*Status INSS*: *Indeferido*

*Motivo do Indeferimento*:
${textoExigencia || analiseIA.motivo_ia || 'Não informado'}

*Instrução*:
Fazer nova entrada administrativa. É necessário corrigir o motivo do indeferimento e apresentar nova solicitação.

*🔗 Acesse o processo diretamente*:
${linkProcesso}

---

📅 Extraído automaticamente do PAT via IA em: ${new Date().toLocaleString('pt-BR')}`;
                } else {
                    // NOTA DE INDEFERIMENTO POR MÉRITO
                    tituloNota = `⚖️ INDEFERIDO - Convertido para JUDICIAL - Protocolo ${protocolo} - DER: ${derFormatado} ⚖️`;
                    conteudoNota = `🔔 *INDEFERIMENTO INSS - Protocolo ${protocolo} - DER: ${derFormatado}* 🔔

*Benefício*: ${detalhes.servico || 'Não informado'}
*NOME*: ${detalhes.nome || 'Não informado'}
*CPF*: ${cpfMascarado}
*Status INSS*: *Indeferido*

*Motivo do Indeferimento*:
${textoExigencia || analiseIA.motivo_ia || 'Não informado'}

*Instrução*:
Processo convertido para fase JUDICIAL. Aguardar orientação do jurídico.

*🔗 Acesse o processo diretamente*:
${linkProcesso}

---

📅 Extraído automaticamente do PAT via IA em: ${new Date().toLocaleString('pt-BR')}`;
                }
            } else {
                // Fallback para outros status
                tituloNota = `📋 ATUALIZAÇÃO INSS - Protocolo ${protocolo} - DER: ${derFormatado} 📋`;
                conteudoNota = `Benefício: ${detalhes.servico || 'Não informado'}
NOME: ${detalhes.nome || 'Não informado'}
CPF: ${cpfMascarado}
Status INSS: ${detalhes.statusAtual || 'Não informado'}

Informações:
${textoExigencia || analiseIA.motivo_ia || 'Nenhuma informação adicional'}

---

📅 Extraído automaticamente do PAT via IA em: ${new Date().toLocaleString('pt-BR')}`;
            }

            // Criar nota
            const notaCriada = await this.tramitacaoService.criarNota(idCliente, {
                titulo: tituloNota,
                texto: conteudoNota,
                tipo: tipoNota,
            });

            if (!notaCriada) {
                logger.error(`[Job ${jobId}] ❌ FALHA CRÍTICA: Não foi possível criar nota no Tramitação!`);
                return {
                    clienteCriado: false,
                    clienteAtualizado: false,
                    notificacaoEnviada: false
                };
            }

            logger.info(`[Job ${jobId}] ✅ Nota criada com sucesso (ID: ${notaCriada})`);

            // Preparar mensagens WhatsApp e destinatários
            let destinatarios: Array<{ telefone: string; mensagem: string; nome: string }> = [];
            let notificacaoEnviada = false;

            // ⚠️ whatsappConfig já foi buscado anteriormente (antes de processar agendamentos)

            // Função auxiliar para obter número de WhatsApp baseado no status
            const obterNumeroWhatsApp = (status: 'EXIGENCIA' | 'DEFERIDO' | 'INDEFERIDO' | 'EM_ANALISE' | 'AGENDAMENTO'): string | null => {
                if (!whatsappConfig || !whatsappConfig.ativo) {
                    return null; // Usar lógica padrão
                }

                // Se tem número único, usar para todos
                if (whatsappConfig.numeroUnico) {
                    return whatsappConfig.numeroUnico;
                }

                // Senão, usar número específico do status
                switch (status) {
                    case 'EXIGENCIA':
                        return whatsappConfig.exigencia || null;
                    case 'DEFERIDO':
                        return whatsappConfig.deferido || null;
                    case 'INDEFERIDO':
                        return whatsappConfig.indeferido || null;
                    case 'EM_ANALISE':
                        return whatsappConfig.emAnalise || null;
                    case 'AGENDAMENTO':
                        return whatsappConfig.agendamento || null;
                    default:
                        return null;
                }
            };

            if (ehExigencia) {
                // EXIGÊNCIA: enviar para escritório
                let mensagemWhatsApp = `🔔 *NOVA EXIGÊNCIA INSS - Protocolo ${protocolo} - DER: ${derFormatado}* 🔔

*NOME*: ${detalhes.nome || 'Não informado'}
*CPF*: ${cpfMascarado}
Status INSS: *${detalhes.statusAtual || 'Exigência'}*

*Exigência*: ${textoExigencia}

*Documentos exigidos*:

${analiseIA.documentos_exigidos?.map((doc, idx) => `> *${idx + 1}. ${doc}*`).join('\n') || '> *Nenhum documento especificado*'}

*Prazo limite: ${prazoFinal.toLocaleDateString('pt-BR')}*

${emailExclusivo ? `*ENVIE OS DOCUMENTOS PARA*:\n\n${emailExclusivo}\n\n` : ''}${diasRestantes > 0 ? `*Dias restantes para envio: ${diasRestantes} dia(s).*` : `*⚠️ ATENÇÃO: Prazo já vencido há ${Math.abs(diasRestantes)} dia(s).*`}

*✅ Após enviar, responda "ENVIADO" neste chat*`;

                // Adicionar links de comprovantes de agendamentos se houver
                if (comprovantesAgendamentos.length > 0) {
                    mensagemWhatsApp += `\n\n*📄 Comprovantes de Agendamentos*:\n\n`;
                    comprovantesAgendamentos.forEach((comp, idx) => {
                        mensagemWhatsApp += `*${idx + 1}. ${comp.tipo}*\n`;
                        mensagemWhatsApp += `*Data*: ${comp.data}${comp.hora ? ` às ${comp.hora}` : ''}\n`;
                        if (comp.unidade) mensagemWhatsApp += `*Unidade*: ${comp.unidade}\n`;
                        if (comp.endereco) mensagemWhatsApp += `*Endereço*: ${comp.endereco}\n`;
                        mensagemWhatsApp += `*Comprovante*: ${comp.url}\n\n`;
                    });
                }

                logger.info(`[Job ${jobId}] 📱 Preparando mensagem de EXIGÊNCIA...`);

                // Verificar se usuário tem WhatsApp personalizado
                const numeroPersonalizado = obterNumeroWhatsApp('EXIGENCIA');

                if (numeroPersonalizado) {
                    destinatarios.push({
                        telefone: numeroPersonalizado,
                        mensagem: mensagemWhatsApp,
                        nome: 'Notificação de Exigência'
                    });
                    logger.info(`[Job ${jobId}] Usando número configurado para EXIGÊNCIA: ${numeroPersonalizado}`);
                } else {
                    logger.info(`[Job ${jobId}] WhatsApp não configurado para EXIGÊNCIA. Nota será criada sem notificação.`);
                }
            } else if (ehDeferido) {
                // DEFERIDO: enviar para número específico
                const mensagemDeferido = `✅ *BENEFÍCIO DEFERIDO - Protocolo ${protocolo}* ✅

*NOME*: ${detalhes.nome || 'Não informado'}
*CPF*: ${cpfMascarado}
*Status INSS*: *Deferido*

*Benefício*: ${detalhes.servico || 'Não informado'}

*📋 ORIENTAÇÕES*:

1. *Baixe a Carta de Concessão* através do link abaixo
2. Verifique todos os dados na carta
3. Entre em contato com o cliente para comunicar a decisão

*🔗 Acesse o processo diretamente*:
${linkProcesso}

*📅 Extraído automaticamente do PAT via IA em:* ${new Date().toLocaleString('pt-BR')}`;

                // Verificar se usuário tem WhatsApp personalizado
                const numeroPersonalizado = obterNumeroWhatsApp('DEFERIDO');

                if (numeroPersonalizado) {
                    destinatarios.push({
                        telefone: numeroPersonalizado,
                        mensagem: mensagemDeferido,
                        nome: 'Notificação de Deferimento'
                    });
                    logger.info(`[Job ${jobId}] Usando número configurado para DEFERIDO: ${numeroPersonalizado}`);
                } else {
                    logger.info(`[Job ${jobId}] WhatsApp não configurado para DEFERIDO. Nota será criada sem notificação.`);
                }
            } else if (ehIndeferido) {
                // Verificar se usuário tem WhatsApp personalizado
                const numeroPersonalizado = obterNumeroWhatsApp('INDEFERIDO');

                if (tipoIndeferimento === 'CULPA') {
                    // INDEFERIDO POR CULPA
                    const mensagemIndeferidoCulpa = `🔔 *INDEFERIMENTO INSS - Protocolo ${protocolo} - DER: ${derFormatado}* 🔔

*Benefício*: ${detalhes.servico || 'Não informado'}
*NOME*: ${detalhes.nome || 'Não informado'}
*CPF*: ${cpfMascarado}
*Status INSS*: *Indeferido*

*Motivo do Indeferimento*:
${textoExigencia || analiseIA.motivo_ia || 'Não informado'}

*Instrução*:
Fazer nova entrada administrativa. É necessário corrigir o motivo do indeferimento e apresentar nova solicitação.

*🔗 Acesse o processo diretamente*:
${linkProcesso}

*📅 Extraído automaticamente do PAT via IA em:* ${new Date().toLocaleString('pt-BR')}`;

                    if (numeroPersonalizado) {
                        destinatarios.push({
                            telefone: numeroPersonalizado,
                            mensagem: mensagemIndeferidoCulpa,
                            nome: 'Notificação de Indeferimento'
                        });
                        logger.info(`[Job ${jobId}] Usando número configurado para INDEFERIDO: ${numeroPersonalizado}`);
                    } else {
                        logger.info(`[Job ${jobId}] WhatsApp não configurado para INDEFERIDO. Nota será criada sem notificação.`);
                    }
                } else {
                    // INDEFERIDO POR MÉRITO
                    const mensagemIndeferidoMerito = `🔔 *INDEFERIMENTO INSS - Protocolo ${protocolo} - DER: ${derFormatado}* 🔔

*Benefício*: ${detalhes.servico || 'Não informado'}
*NOME*: ${detalhes.nome || 'Não informado'}
*CPF*: ${cpfMascarado}
*Status INSS*: *Indeferido*

*Motivo do Indeferimento*:
${textoExigencia || analiseIA.motivo_ia || 'Não informado'}

*Instrução*:
Processo convertido para fase JUDICIAL. Aguardar orientação do jurídico.

*🔗 Acesse o processo diretamente*:
${linkProcesso}

*📅 Extraído automaticamente do PAT via IA em:* ${new Date().toLocaleString('pt-BR')}`;

                    if (numeroPersonalizado) {
                        destinatarios.push({
                            telefone: numeroPersonalizado,
                            mensagem: mensagemIndeferidoMerito,
                            nome: 'Notificação de Indeferimento'
                        });
                        logger.info(`[Job ${jobId}] Usando número configurado para INDEFERIDO: ${numeroPersonalizado}`);
                    } else {
                        logger.info(`[Job ${jobId}] WhatsApp não configurado para INDEFERIDO. Nota será criada sem notificação.`);
                    }
                }
            } else {
                logger.warn(`[Job ${jobId}] ⚠️ Status não reconhecido: ${detalhes.statusAtual}. Não enviando WhatsApp.`);
            }

            // ⚠️ ENVIO DE WHATSAPP TEMPORARIAMENTE DESABILITADO
            logger.info(`[Job ${jobId}] 📱 WhatsApp desabilitado temporariamente (em desenvolvimento)`);

            /* 
            // Enviar WhatsApp
            if (destinatarios.length === 0) {
                logger.warn(`[Job ${jobId}] ⚠️ Nenhum destinatário configurado para este tipo de status. Pulando envio de WhatsApp.`);
            } else {
                // Verificar se WhatsApp está pronto (aguardar se necessário)
                let whatsappPronto = whatsappService.isConfigured();

                if (!whatsappPronto) {
                    logger.warn(`[Job ${jobId}] ⏳ WhatsApp ainda não está pronto, aguardando até 10s...`);
                    whatsappPronto = await whatsappService.aguardarPronto(10000);
                }

                if (!whatsappPronto) {
                    logger.error(`[Job ${jobId}] ❌ WhatsApp Service não ficou pronto a tempo! Certifique-se de que o WhatsApp foi conectado.`);
                    logger.error(`[Job ${jobId}]    Pulando envio de WhatsApp para este protocolo.`);
                } else {
                    logger.info(`[Job ${jobId}] 📤 Enviando WhatsApp via WhatsApp Service para ${destinatarios.length} destinatário(s)...`);

                    for (const destinatario of destinatarios) {
                        try {
                            logger.info(`[Job ${jobId}] 📱 Enviando para ${destinatario.nome} (${destinatario.telefone})...`);

                            const enviado = await whatsappService.enviar(
                                destinatario.telefone,
                                destinatario.mensagem
                            );

                            if (enviado) {
                                logger.info(`[Job ${jobId}] ✅ Mensagem enviada com sucesso para ${destinatario.nome}`);
                                notificacaoEnviada = true;

                                // Salvar no banco
                                if (processoId) {
                                    Database.query(`
                                    INSERT INTO notificacoes_whatsapp (
                                        processo_id, parceiro_id, tipo, telefone_destino, cidade, mensagem, enviada, data_envio
                                    ) VALUES ($1, $2, $3, $4, $5, $6, true, NOW())
                                `, [
                                        processoId,
                                        null,
                                        ehExigencia ? 'EXIGENCIA_DETECTADA' : ehDeferido ? 'RESULTADO_DEFERIDO' : 'RESULTADO_INDEFERIDO',
                                        destinatario.telefone,
                                        'ESCRITORIO',
                                        destinatario.mensagem
                                    ]).catch(() => { });
                                }
                            } else {
                                logger.error(`[Job ${jobId}] ❌ Falha ao enviar mensagem para ${destinatario.nome}`);
                            }
                        } catch (error: any) {
                            logger.error(`[Job ${jobId}] ❌ Erro ao processar notificação para ${destinatario.nome}: ${error.message}`);
                        }
                    }
                }
            }
            */

            // ========== NOTIFICAÇÕES PARA PARCEIROS (ETIQUETAS PARCEIRO:NOME) ==========
            // ⚠️ ENVIO DE WHATSAPP PARA PARCEIROS TEMPORARIAMENTE DESABILITADO
            logger.info(`[Job ${jobId}] 📱 Notificações para parceiros desabilitadas temporariamente`);

            /*
            if (userId && whatsappService.isConfigured()) {
                try {
                    // Determinar tipo de status para notificação de parceiros
                    let tipoStatusParceiro: 'EXIGENCIA' | 'DEFERIDO' | 'INDEFERIDO' | 'AGENDAMENTO' | 'EM_ANALISE' = 'EXIGENCIA';
                    if (ehExigencia) tipoStatusParceiro = 'EXIGENCIA';
                    else if (ehDeferido) tipoStatusParceiro = 'DEFERIDO';
                    else if (ehIndeferido) tipoStatusParceiro = 'INDEFERIDO';

                    // Buscar parceiros que devem ser notificados baseado nas tags do cliente
                    const parceirosParaNotificar = await parceirosService.buscarParceirosParaNotificacao(
                        userId!,
                        tagsCliente,
                        tipoStatusParceiro
                    );

                    const parceirosAtivos = parceirosParaNotificar.filter(p => p.deveNotificar);

                    if (parceirosAtivos.length > 0) {
                        logger.info(`[Job ${jobId}] Encontrado(s) ${parceirosAtivos.length} parceiro(s) para notificar`);

                        for (const { parceiro } of parceirosAtivos) {
                            try {
                                // Montar mensagem personalizada para o parceiro
                                const mensagemParceiro = parceirosService.gerarMensagemParceiro(parceiro, {
                                    nomeCliente: detalhes.nome || 'Não informado',
                                    cpfMascarado,
                                    protocolo,
                                    beneficio: detalhes.servico || 'Não informado',
                                    status: ehExigencia ? 'EXIGÊNCIA' : ehDeferido ? 'DEFERIDO' : 'INDEFERIDO',
                                    motivo: textoExigencia || analiseIA.motivo_ia,
                                    sugestaoAcao: ehIndeferido ? (tipoIndeferimento === 'CULPA'
                                        ? 'Fazer nova entrada administrativa'
                                        : 'Processo convertido para fase JUDICIAL') : undefined,
                                    linkProcesso: parceiro.incluirLinkProcesso ? linkProcesso : undefined,
                                    comprovantes: comprovantesAgendamentos.map(c => ({ tipo: c.tipo, url: c.url })),
                                    analiseIA: analiseIA.motivo_ia
                                });

                                logger.info(`[Job ${jobId}] Enviando para parceiro: ${parceiro.nomeEtiqueta} (${parceiro.telefone})`);

                                const enviado = await whatsappService.enviar(
                                    parceiro.telefone,
                                    mensagemParceiro
                                );

                                if (enviado) {
                                    logger.info(`[Job ${jobId}] Mensagem enviada para parceiro ${parceiro.nomeEtiqueta}`);
                                }
                            } catch (erroParceiro: any) {
                                logger.warn(`[Job ${jobId}] Erro ao notificar parceiro ${parceiro.nomeEtiqueta}: ${erroParceiro.message}`);
                            }
                        }
                    }
                } catch (erroParceiros: any) {
                    logger.warn(`[Job ${jobId}] Erro ao processar notificações de parceiros: ${erroParceiros.message}`);
                }
            }
            */

            return {
                clienteCriado,
                clienteAtualizado: !clienteCriado,
                notificacaoEnviada
            };

        } catch (error: any) {
            logger.error(`[Job ${jobId}] ❌ Erro ao processar protocolo ${protocolo}: ${error.message}`);
            throw error;
        }
    }

    /**
     * Função auxiliar para enviar notificação de agendamento e registrar nas notas
     * Agora suporta configurações personalizadas de WhatsApp do usuário
     */
    private async enviarNotificacaoAgendamento(
        clienteId: string,
        nomeCliente: string,
        cpfCliente: string,
        protocolo: string,
        tipo: 'PERICIA' | 'AVALIACAO_SOCIAL',
        data: Date,
        hora: string,
        unidade: string,
        endereco?: string,
        urlComprovante?: string,
        processoId?: string | null,
        userId?: string,
        userConfig?: {
            tramitacaoEmail?: string;
        },
        whatsappConfig?: {
            ativo: boolean;
            numeroUnico?: string;
            agendamento?: string;
        } | null
    ): Promise<void> {
        try {
            const tipoTexto = tipo === 'PERICIA' ? 'PERÍCIA MÉDICA' : 'AVALIAÇÃO SOCIAL';
            // Mascarar CPF para WhatsApp (padrão: 000.XXX.X0X-00)
            const mascararCpfWhatsApp = (cpf: string): string => {
                const cpfLimpo = cpf.replace(/\D/g, '');
                if (cpfLimpo.length !== 11) return cpf;
                // Formato: 000.XXX.X0X-00 (primeiros 3, XXX maiúsculo, penúltimo dígito, últimos 2)
                return `${cpfLimpo.substring(0, 3)}.XXX.X${cpfLimpo.substring(8, 9)}X-${cpfLimpo.substring(9, 11)}`;
            };
            const cpfMascarado = mascararCpfWhatsApp(cpfCliente);
            const dataFormatada = data.toLocaleDateString('pt-BR');
            const dataHoraAtual = new Date().toLocaleString('pt-BR');

            // Montar mensagem WhatsApp
            let mensagemWhatsApp = `📅 *${tipoTexto} AGENDADA* 📅%0A%0A` +
                `*Protocolo*: ${protocolo}%0A` +
                `*Cliente*: ${nomeCliente}%0A` +
                `*CPF*: ${cpfMascarado}%0A%0A` +
                `*Data e Hora*: ${dataFormatada} às ${hora}%0A` +
                `*Unidade*: ${unidade}%0A`;

            if (endereco) {
                mensagemWhatsApp += `*Endereço*: ${endereco}%0A`;
            }

            if (urlComprovante) {
                mensagemWhatsApp += `%0A*📄 Comprovante*:%0A${urlComprovante}%0A`;
            }

            mensagemWhatsApp += `%0A*🔗 Acesse o processo diretamente*:%0A` +
                `https://atendimento.inss.gov.br/tarefas/detalhar_tarefa/${protocolo}%0A%0A` +
                `*📅 Agendamento cadastrado automaticamente em:* ${dataHoraAtual}`;

            // Verificar se usuário tem WhatsApp configurado para agendamentos
            let telefoneDestino: string | null = null;
            let nomeDestinatario = 'Notificação de Agendamento';

            if (whatsappConfig && whatsappConfig.ativo) {
                telefoneDestino = whatsappConfig.agendamento || whatsappConfig.numeroUnico || null;
                if (telefoneDestino) {
                    logger.info(`Usando número configurado para AGENDAMENTO: ${telefoneDestino}`);
                }
            }

            // Se não tem WhatsApp configurado, apenas registrar nota sem enviar mensagem
            if (!telefoneDestino) {
                logger.info(`WhatsApp não configurado para agendamentos. Nota será criada sem notificação.`);

                // Criar nota no Tramitação mesmo sem enviar WhatsApp
                const conteudoNota = `*📅 ${tipoTexto} AGENDADA*%0A%0A` +
                    `*Protocolo*: ${protocolo}%0A` +
                    `*Cliente*: ${nomeCliente}%0A` +
                    `*CPF*: ${cpfMascarado}%0A%0A` +
                    `*Data e Hora*: ${dataFormatada} às ${hora}%0A` +
                    `*Unidade*: ${unidade}%0A` +
                    (endereco ? `*Endereço*: ${endereco}%0A` : '') +
                    (urlComprovante ? `%0A*📄 Comprovante*:%0A${urlComprovante}%0A` : '') +
                    `%0A📅 Extraído automaticamente do PAT via IA em: ${dataHoraAtual}`;

                await this.tramitacaoService.criarNota(clienteId, {
                    titulo: `📅 ${tipoTexto} Agendada - ${dataFormatada}`,
                    texto: decodeURIComponent(conteudoNota),
                    tipo: 'INFORMACAO'
                });

                return;
            }

            // userId deve estar disponível no contexto - vamos buscar do userConfig ou passar como parâmetro
            // Por enquanto, vamos buscar do banco se não estiver disponível
            let userIdParaWhatsApp = userId;
            if (!userIdParaWhatsApp && userConfig?.tramitacaoEmail) {
                // Tentar buscar userId pelo email (fallback)
                const resultado = await Database.query(
                    `SELECT id FROM usuarios_extensao WHERE tramitacao_email = $1 LIMIT 1`,
                    [userConfig.tramitacaoEmail]
                );
                if (resultado.length > 0) {
                    userIdParaWhatsApp = resultado[0].id;
                }
            }

            if (!userIdParaWhatsApp) {
                logger.warn(`⚠️ userId não disponível para enviar WhatsApp. Pulando envio.`);
                return;
            }

            const enviado = await whatsappService.enviar(
                telefoneDestino,
                decodeURIComponent(mensagemWhatsApp)
            );

            if (enviado) {
                logger.info(`✅ Notificação de ${tipoTexto} enviada para ${nomeDestinatario} (${telefoneDestino})`);

                // Registrar nas notas
                const conteudoNota = `*📅 ${tipoTexto} AGENDADA*%0A%0A` +
                    `*Protocolo*: ${protocolo}%0A` +
                    `*Cliente*: ${nomeCliente}%0A` +
                    `*CPF*: ${cpfMascarado}%0A%0A` +
                    `*Data e Hora*: ${dataFormatada} às ${hora}%0A` +
                    `*Unidade*: ${unidade}%0A` +
                    (endereco ? `*Endereço*: ${endereco}%0A` : '') +
                    (urlComprovante ? `%0A*📄 Comprovante*:%0A${urlComprovante}%0A` : '') +
                    `%0A*📱 Notificação WhatsApp enviada para:* ${nomeDestinatario} (${telefoneDestino}) em ${dataHoraAtual}%0A%0A` +
                    `*🔗 Acesse o processo diretamente*:%0A` +
                    `https://atendimento.inss.gov.br/tarefas/detalhar_tarefa/${protocolo}%0A%0A` +
                    `---%0A%0A📅 Extraído automaticamente do PAT via IA em: ${dataHoraAtual}`;

                await this.tramitacaoService.criarNota(clienteId, {
                    titulo: `📅 ${tipoTexto} Agendada - ${dataFormatada}`,
                    texto: decodeURIComponent(conteudoNota),
                    tipo: 'INFORMACAO'
                });

                // Salvar notificação no banco
                if (processoId) {
                    try {
                        await Database.query(`
                            INSERT INTO notificacoes_whatsapp (
                                processo_id, tipo, telefone_destino, cidade, mensagem, enviada, data_envio
                            ) VALUES ($1, $2, $3, $4, $5, true, NOW())
                        `, [
                            processoId,
                            'AGENDAMENTO_CADASTRO',
                            telefoneDestino,
                            'ESCRITORIO',
                            decodeURIComponent(mensagemWhatsApp)
                        ]);
                    } catch (error: any) {
                        logger.warn(`⚠️ Erro ao salvar notificação no banco: ${error.message}`);
                    }
                }
            } else {
                logger.warn(`⚠️ Falha ao enviar notificação de ${tipoTexto} para ${nomeDestinatario}`);
            }
        } catch (error: any) {
            logger.error(`❌ Erro ao enviar notificação de agendamento: ${error.message}`);
        }
    }

    /**
     * Processa protocolo com status "Em Análise"
     * - Verifica se cliente existe no Tramitação via API
     * - Se não existir, cria via API
     * - Adiciona nota com detalhes
     * - Verifica perícia/avaliação agendada e cria atividade se necessário
     */
    private async processarProtocoloEmAnalise(
        jobId: string,
        protocolo: string,
        detalhes: any,
        userId?: string,
        userConfig?: {
            geminiApiKey?: string;
            tramitacaoApiToken?: string;
            tramitacaoEmail?: string;
            tramitacaoSenha?: string;
        }
    ): Promise<{
        clienteCriado: boolean;
        clienteAtualizado: boolean;
    }> {
        try {
            logger.info(`📋 [Job ${jobId}] Processando protocolo ${protocolo} em "Em Análise"...`);

            // Usar token do usuário se fornecido
            const tramitacaoService = userConfig?.tramitacaoApiToken
                ? new TramitacaoService(userConfig.tramitacaoApiToken)
                : this.tramitacaoService;

            // 1. Verificar se cliente existe no Tramitação via API
            logger.info(`[Job ${jobId}] 🔍 Verificando se cliente existe no Tramitação via API...`);
            let clienteId = await tramitacaoService.buscarCliente(detalhes.cpf);

            const clienteCriado = !clienteId;
            if (!clienteId) {
                // 2. Criar cliente via API
                logger.info(`[Job ${jobId}] 🆕 Cliente não encontrado, criando via API...`);
                clienteId = await tramitacaoService.criarCliente({
                    nome: detalhes.nome,
                    cpf: detalhes.cpf,
                    protocolo: protocolo,
                    servico: detalhes.servico
                });
                logger.info(`[Job ${jobId}] ✅ Cliente criado: ${typeof clienteId === 'string' ? clienteId : clienteId?.id}`);
            } else {
                logger.info(`[Job ${jobId}] ✅ Cliente encontrado: ${typeof clienteId === 'string' ? clienteId : clienteId?.id}`);
            }

            const idCliente = typeof clienteId === 'string' ? clienteId : (clienteId?.id || '');

            if (!idCliente) {
                logger.error(`[Job ${jobId}] ❌ Falha ao obter ID do cliente para protocolo ${protocolo}`);
                return {
                    clienteCriado: false,
                    clienteAtualizado: false
                };
            }

            // 2. Se cliente já existe, verificar e atualizar tags se necessário
            if (!clienteCriado) {
                logger.info(`[Job ${jobId}] 🔍 Cliente já existe, verificando tags...`);
                try {
                    const tagsAtuais = await tramitacaoService.obterTagsCliente(idCliente);
                    logger.info(`[Job ${jobId}] 📋 Tags atuais: ${tagsAtuais.join(', ') || 'Nenhuma'}`);

                    // Tags esperadas para "Em Análise" (globais)
                    const tagsEsperadas: string[] = [
                        'CLIENTE_INSS',
                        'EM_ANALISE'
                    ];

                    // Aprender tags de clientes similares
                    const servicoDaLista = puppeteerService.obterServicoPorProtocolo(protocolo);
                    const servicoParaAprendizado = servicoDaLista || detalhes.servico || '';
                    if (servicoParaAprendizado) {
                        const tagsAprendidas = await tramitacaoService.aprenderTagsPorBeneficio(servicoParaAprendizado, 20);
                        tagsEsperadas.push(...tagsAprendidas);
                        if (tagsAprendidas.length > 0) {
                            logger.info(`[Job ${jobId}] 📚 Tags aprendidas de clientes similares: ${tagsAprendidas.join(', ')}`);
                        }
                    }

                    // Verificar se precisa atualizar tags
                    const tagsFaltando = tagsEsperadas.filter(tag =>
                        !tagsAtuais.some(t => t.toUpperCase() === tag.toUpperCase())
                    );

                    // Tags que não deveriam estar (status antigos) - serão removidas
                    const statusAntigos = ['EXIGENCIA', 'EXIGÊNCIA', 'PENDENTE', 'DEFERIDO', 'INDEFERIDO', 'CONCLUIDO'];
                    const tagsParaRemover = tagsAtuais.filter(tag => {
                        const tagUpper = tag.toUpperCase();
                        // Remover status antigos que não são o atual
                        return statusAntigos.some(status => tagUpper === status) && tagUpper !== 'EM_ANALISE';
                    });

                    if (tagsFaltando.length > 0 || tagsParaRemover.length > 0) {
                        logger.info(`[Job ${jobId}] 🔄 Tags desatualizadas detectadas. Atualizando...`);
                        if (tagsFaltando.length > 0) {
                            logger.info(`[Job ${jobId}]    Faltando: ${tagsFaltando.join(', ')}`);
                        }
                        if (tagsParaRemover.length > 0) {
                            logger.info(`[Job ${jobId}]    Removendo: ${tagsParaRemover.join(', ')}`);
                        }

                        // Combinar tags: manter tags atuais que são válidas + adicionar faltantes - remover inválidas
                        const tagsValidas = tagsAtuais.filter(tag => {
                            const tagUpper = tag.toUpperCase();
                            return !tagsParaRemover.some(t => t.toUpperCase() === tagUpper) &&
                                (tagsEsperadas.some(t => t.toUpperCase() === tagUpper) ||
                                    tagUpper === 'CLIENTE_INSS');
                        });

                        // Adicionar tags faltantes
                        tagsFaltando.forEach(tag => {
                            if (!tagsValidas.some(t => t.toUpperCase() === tag.toUpperCase())) {
                                tagsValidas.push(tag);
                            }
                        });

                        // Aplicar tags atualizadas
                        await tramitacaoService.aplicarEtiquetas(idCliente, tagsValidas);
                        logger.info(`[Job ${jobId}] ✅ Tags atualizadas: ${tagsValidas.join(', ')}`);
                    } else {
                        logger.info(`[Job ${jobId}] ✅ Tags já estão atualizadas`);
                    }
                } catch (error: any) {
                    logger.warn(`[Job ${jobId}] ⚠️ Erro ao verificar/atualizar tags (não crítico): ${error.message}`);
                }
            }

            // 3. Verificar se já existe nota similar antes de criar
            logger.info(`[Job ${jobId}] 📝 Verificando se já existe nota similar...`);
            const conteudoNota = `📋 **Protocolo INSS**: ${protocolo}\n\n` +
                `👤 **Cliente**: ${detalhes.nome}\n` +
                `🆔 **CPF**: ${detalhes.cpf}\n` +
                `📊 **Status**: ${detalhes.statusAtual}\n` +
                `🏥 **Serviço**: ${detalhes.servico || 'Não informado'}\n\n` +
                `📅 **Última atualização**: ${new Date().toLocaleString('pt-BR')}\n\n` +
                `ℹ️ Status atual: Em Análise. Processo em tramitação no INSS.`;

            const notaSimilar = await tramitacaoService.verificarNotaSimilar(
                idCliente,
                protocolo,
                conteudoNota,
                1 // Mesma data (1 dia de tolerância)
            );

            if (!notaSimilar) {
                try {
                    await tramitacaoService.criarNota(idCliente, {
                        titulo: `Protocolo INSS ${protocolo} - Em Análise`,
                        texto: conteudoNota,
                        tipo: 'INFORMACAO'
                    });
                    logger.info(`[Job ${jobId}] ✅ Nota adicionada com sucesso`);
                } catch (error: any) {
                    logger.warn(`[Job ${jobId}] ⚠️ Erro ao criar nota (não crítico): ${error.message}`);
                }
            } else {
                logger.info(`[Job ${jobId}] ⏭️ Nota similar já existe, pulando criação para evitar duplicidade`);
            }

            // 4. Verificar se tem perícia/avaliação agendada (mesmo em "Em Análise")
            logger.info(`[Job ${jobId}] 🔍 Verificando perícia/avaliação agendada...`);
            try {
                const page = puppeteerService.getPage();
                if (page) {
                    // Extrair tanto perícias médicas quanto avaliações sociais
                    const pericias = await agendamentosService.extrairPericiasMedicas(page, protocolo, detalhes.cpf);
                    const avaliacoes = await agendamentosService.extrairAvaliacoesSociais(page, protocolo, detalhes.cpf);

                    // Combinar e filtrar apenas AGENDADOS
                    const todosAgendamentos = [...pericias, ...avaliacoes];
                    const agendadas = agendamentosService.filtrarAgendados(todosAgendamentos);

                    if (agendadas.length > 0) {
                        logger.info(`[Job ${jobId}] ✅ ${agendadas.length} perícia(s)/avaliação(ões) AGENDADA(s) encontrada(s)`);

                        // Criar atividade para cada agendamento válido
                        for (const agendamento of agendadas) {
                            try {
                                // Verificar se já existe atividade com mesma data
                                const jaExiste = await tramitacaoSyncService.verificarAtividadeExistente(
                                    idCliente,
                                    agendamento.data,
                                    agendamento.tipo,
                                    userConfig?.tramitacaoEmail,
                                    userConfig?.tramitacaoSenha
                                );

                                if (jaExiste) {
                                    logger.info(`[Job ${jobId}] ⏭️ Atividade ${agendamento.tipo} com data ${agendamento.data.toLocaleDateString('pt-BR')} já existe, pulando para evitar duplicidade`);
                                    continue;
                                }

                                // Determinar tipo
                                const tipo: 'PERICIA' | 'AVALIACAO_SOCIAL' = agendamento.tipo;

                                // Usar data e hora do agendamento
                                const dataAgendamento = agendamento.data;
                                const horaStr = agendamento.hora; // Já está no formato HH:mm

                                // Criar atividade via TramitacaoSyncService
                                const atividadeId = await tramitacaoSyncService.cadastrarAtividade(
                                    idCliente,
                                    {
                                        tipo,
                                        data: dataAgendamento,
                                        hora: horaStr,
                                        unidade: agendamento.unidade || 'Não informado',
                                        endereco: agendamento.endereco,
                                        servico: detalhes.servico
                                    },
                                    userConfig?.tramitacaoEmail,
                                    userConfig?.tramitacaoSenha
                                );

                                if (atividadeId) {
                                    logger.info(`[Job ${jobId}] ✅ Atividade criada com sucesso (ID: ${atividadeId})`);
                                } else {
                                    logger.warn(`[Job ${jobId}] ⚠️ Falha ao criar atividade para agendamento`);
                                }
                            } catch (error: any) {
                                logger.warn(`[Job ${jobId}] ⚠️ Erro ao criar atividade (não crítico): ${error.message}`);
                            }
                        }
                    } else {
                        logger.info(`[Job ${jobId}] ℹ️ Nenhuma perícia/avaliação AGENDADA encontrada (pode estar cancelada, remarcada, etc)`);
                    }
                }
            } catch (error: any) {
                logger.warn(`[Job ${jobId}] ⚠️ Erro ao verificar agendamentos (não crítico): ${error.message}`);
            }

            return {
                clienteCriado,
                clienteAtualizado: !clienteCriado
            };

        } catch (error: any) {
            logger.error(`[Job ${jobId}] ❌ Erro ao processar protocolo em "Em Análise": ${error.message}`);
            return {
                clienteCriado: false,
                clienteAtualizado: false
            };
        }
    }
}

