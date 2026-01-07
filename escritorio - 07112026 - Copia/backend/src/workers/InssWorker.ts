import cron from 'node-cron';
import { QueryResult } from 'pg';
import config from '../config';
import logger from '../utils/logger';
import Database from '../database';
import aiService from '../services/AIService';
import puppeteerService from '../services/PuppeteerService';
import tramitacaoService from '../services/TramitacaoService';
import whatsappService from '../services/WhatsAppService';
import agendamentosService from '../services/AgendamentosService';
import tramitacaoSyncService from '../services/TramitacaoSyncService';
import parceirosService from '../services/ParceirosService';
import { StatusINSS, ClasseFinal } from '@inss-manager/shared';

/**
 * Worker de automação do INSS
 * Orquestra todo o fluxo: Web Scraping → Análise IA → Persistência → Integração Tramitação
 * 
 * Fluxo:
 * 1. Cron dispara 2x ao dia (8h e 14h)
 * 2. Puppeteer coleta protocolos do INSS
 * 3. Para cada protocolo, extrai texto completo
 * 4. IA analisa texto e retorna classificação
 * 5. Compara com status anterior no banco
 * 6. Se houver mudança, atualiza banco e notifica Tramitação
 */
export class InssWorker {
    private isRunning = false;
    private db: typeof Database;

    constructor() {
        this.db = Database;
    }

    /**
     * Inicializa o Cron Job
     * Executa 2x ao dia: 08:00 e 14:00
     */
    start(): void {
        logger.info('[InssWorker] Iniciando Worker...');

        // Valida configurações
        if (!aiService.isConfigured()) {
            logger.error(
                '[InssWorker] API do Gemini não configurada. Configure GEMINI_API_KEY no .env'
            );
            return;
        }

        // Agenda Cron: 08:00 e 14:00 todos os dias
        const cronExpression = config.inss.cronSchedule || '0 8,14 * * *';

        cron.schedule(cronExpression, async () => {
            logger.info('[InssWorker] Cron disparado');
            await this.run();
        });

        logger.info(
            `[InssWorker] Worker agendado: ${cronExpression} (${config.inss.cronSchedule})`
        );

        // Opção: Executar imediatamente na primeira vez (para testes)
        // setTimeout(() => this.run(), 5000);
    }

    /**
     * Execução manual do Worker (para testes)
     */
    async runManual(): Promise<void> {
        logger.info('[InssWorker] Execução manual iniciada');
        await this.run();
    }

    /**
     * Fluxo principal do Worker
     * Processamento incremental baseado em configuração
     */
    private async run(): Promise<void> {
        if (this.isRunning) {
            logger.warn('[InssWorker] Worker já está em execução. Ignorando...');
            return;
        }

        this.isRunning = true;
        const startTime = Date.now();
        const execucaoId = await this.iniciarExecucao('AUTOMATICO');

        try {
            logger.info('[InssWorker] ========== INICIANDO COLETA ==========');

            // 1. Obter período de processamento baseado na configuração
            const { dataInicio, dataFim } = await this.obterPeriodoProcessamento();

            logger.info(`[InssWorker] Período: ${dataInicio.toLocaleDateString('pt-BR')} até ${dataFim.toLocaleDateString('pt-BR')}`);

            // 2. Inicializar Puppeteer
            await puppeteerService.initialize();
            await puppeteerService.login();

            // 3. Coletar lista de protocolos do período
            const protocolos = await puppeteerService.coletarProtocolos(
                dataInicio,
                dataFim
            );

            logger.info(`[InssWorker] ${protocolos.length} protocolos para processar`);

            // 4. Processar cada protocolo
            let processados = 0;
            let erros = 0;
            let mudancas = 0;

            for (const protocolo of protocolos) {
                try {
                    const houveMudanca = await this.processarProtocolo(protocolo);
                    if (houveMudanca) mudancas++;
                    processados++;

                    // Delay entre requisições para evitar sobrecarga
                    await this.delay(2000);
                } catch (error) {
                    logger.error(
                        `[InssWorker] Erro ao processar protocolo ${protocolo}:`,
                        error
                    );
                    erros++;
                }
            }

            // 5. Fechar navegador
            await puppeteerService.close();

            // 6. Finalizar registro de execução
            await this.finalizarExecucao(execucaoId, 'SUCESSO', processados, mudancas, erros);

            // 7. Log de resumo
            const tempoTotal = Math.round((Date.now() - startTime) / 1000);
            logger.info('[InssWorker] ========== COLETA FINALIZADA ==========');
            logger.info(`[InssWorker] Tempo total: ${tempoTotal}s`);
            logger.info(`[InssWorker] Processados: ${processados}/${protocolos.length}`);
            logger.info(`[InssWorker] Mudanças detectadas: ${mudancas}`);
            logger.info(`[InssWorker] Erros: ${erros}`);
        } catch (error) {
            logger.error('[InssWorker] Erro crítico no Worker:', error);
            await this.finalizarExecucao(execucaoId, 'ERRO', 0, 0, 1);
        } finally {
            this.isRunning = false;
            await puppeteerService.close();
        }
    }

    /**
     * Processa um protocolo individual
     * @param protocolo Número do protocolo
     * @returns true se houve mudança de status
     */
    private async processarProtocolo(protocolo: string): Promise<boolean> {
        logger.info(`[InssWorker] Processando protocolo ${protocolo}`);

        try {
            // 1. Extrair dados do INSS via Puppeteer
            const dadosInss = await puppeteerService.extrairDetalhesProcesso(
                protocolo
            );

            // 2. Buscar processo existente no banco
            const processoExistente = await this.buscarProcessoPorProtocolo(
                protocolo
            );

            // 3. Analisar texto com IA
            const analiseIA = await aiService.analisarTextoInss(
                dadosInss.textoCompleto,
                protocolo
            );

            // 4. Converter classe_final da IA para StatusINSS
            const classeFinal = this.normalizarClasseFinal(
                analiseIA.classe_final
            );

            const novoStatus = this.mapearClasseFinalParaStatus(classeFinal);

            // 5. Verificar se houve mudança
            const houveMudanca =
                !processoExistente || processoExistente.status_inss !== novoStatus;

            if (houveMudanca) {
                logger.info(
                    `[InssWorker] Mudança detectada no protocolo ${protocolo}: ${processoExistente?.status_inss || 'NOVO'} → ${novoStatus}`
                );

                // 6. Salvar/Atualizar no banco
                await this.salvarProcesso({
                    protocolo,
                    cpf: dadosInss.cpf,
                    nome: dadosInss.nome,
                    tipo_beneficio: dadosInss.beneficio,
                    der: dadosInss.der,
                    status_inss: novoStatus,
                    classe_final: classeFinal,
                    motivo_ia: analiseIA.motivo_ia,
                    documentos_exigidos: analiseIA.documentos_exigidos,
                    data_evento: analiseIA.data_evento,
                    confianca_ia: analiseIA.confianca,
                    processoExistente,
                });

                // 7. Processar mudança de status (notificar Tramitação)
                const clienteId = await this.handleStatusChange(
                    protocolo,
                    processoExistente,
                    { ...analiseIA, classe_final: classeFinal },
                    dadosInss
                );

                // 8. Processar agendamentos (perícias e avaliações)
                if (processoExistente?.id && clienteId) {
                    await this.processarAgendamentos(
                        protocolo,
                        dadosInss.cpf,
                        dadosInss.nome,
                        dadosInss.beneficio,
                        processoExistente.id,
                        clienteId
                    );
                }

                return true;
            } else {
                logger.info(
                    `[InssWorker] Protocolo ${protocolo} sem mudanças (${novoStatus})`
                );
                return false;
            }
        } catch (error) {
            logger.error(
                `[InssWorker] Erro ao processar protocolo ${protocolo}:`,
                error
            );
            throw error;
        }
    }

    /**
     * Trata mudança de status e aciona integrações
     * @returns ID do cliente no Tramitação ou null
     */
    private async handleStatusChange(
        protocolo: string,
        processoAntigo: any | null,
        analiseIA: any,
        dadosInss: any
    ): Promise<string | null> {
        const classeFinal = analiseIA.classe_final;

        logger.info(
            `[InssWorker] Tratando mudança de status: ${classeFinal} (protocolo ${protocolo})`
        );

        try {
            // ✨ NOVO: Buscar ou criar cliente no Tramitação (Upsert)
            const cliente = await tramitacaoService.buscarOuCriarCliente({
                nome: dadosInss.nome,
                cpf: dadosInss.cpf,
                protocolo: protocolo,
                servico: dadosInss.beneficio, // "Aposentadoria por Idade Rural", etc.
            });

            if (!cliente) {
                logger.error(
                    `[InssWorker] ❌ Falha ao buscar/criar cliente ${dadosInss.nome} (CPF: ${dadosInss.cpf}) no Tramitação. Pulando notificações.`
                );
                return null;
            }

            const clienteId = cliente.id;

            logger.info(
                `[InssWorker] ✅ Cliente pronto para notificações: ${cliente.nome} (ID: ${clienteId})`
            );

            // 🏷️ NOVO: Buscar processo e responsável para gerar tags
            const processoDb = await this.buscarProcessoPorProtocolo(protocolo);
            const nomeResponsavel = processoDb ? await this.buscarNomeResponsavel(processoDb.id) : null;

            // Gerar tags consolidadas
            const tags = this.gerarTags(processoDb || dadosInss, classeFinal, nomeResponsavel);

            // Aplicar tags no Tramitação
            if (tags.length > 0) {
                await tramitacaoService.aplicarEtiquetas(clienteId, tags);
            }

            // 2. Ações específicas por tipo de status
            switch (classeFinal) {
                case ClasseFinal.EXIGENCIA:
                    await this.handleExigencia(clienteId, protocolo, analiseIA, dadosInss);
                    break;

                case ClasseFinal.DEFERIDO:
                    await this.handleDeferido(clienteId, protocolo, analiseIA);
                    break;

                case ClasseFinal.INDEFERIDO:
                    await this.handleIndeferido(clienteId, protocolo, analiseIA);
                    break;

                case ClasseFinal.CANCELADO:
                    await this.handleCancelado(clienteId, protocolo, analiseIA);
                    break;

                case ClasseFinal.DUPLICADO:
                    await this.handleDuplicado(clienteId, protocolo, analiseIA);
                    break;

                case ClasseFinal.PERICIA:
                    await this.handlePericia(clienteId, protocolo, analiseIA);
                    break;

                default:
                    // Status genérico (EM_ANALISE, RECURSO, etc)
                    await tramitacaoService.criarNota(clienteId, {
                        titulo: `📋 Atualização - Protocolo ${protocolo}`,
                        texto: `Status: ${classeFinal}\n\n${analiseIA.motivo_ia}`,
                        tipo: 'INFORMACAO',
                    });
            }

            return clienteId;
        } catch (error) {
            logger.error(
                `[InssWorker] Erro ao tratar mudança de status:`,
                error
            );
            return null;
        }
    }

    /**
     * Busca nome do responsável pela entrada do processo
     */
    private async buscarNomeResponsavel(processoId: string): Promise<string | null> {
        try {
            const result = await this.db.query(`
                SELECT u.nome
                FROM processos p
                INNER JOIN usuarios u ON p.responsavel_entrada_id = u.id
                WHERE p.id = $1
            `, [processoId]);

            if (result.length > 0) {
                return result[0].nome;
            }

            return null;
        } catch (error) {
            logger.error('[InssWorker] Erro ao buscar responsável:', error);
            return null;
        }
    }

    /**
     * Gera array de tags para aplicar no Tramitação
     */
    private gerarTags(
        processo: any,
        classeFinal: string,
        nomeResponsavel: string | null
    ): string[] {
        const tags: string[] = [];

        // 1. Responsável
        if (nomeResponsavel) {
            tags.push(`Responsável: ${nomeResponsavel}`);
        }

        // 2. Tipo de Benefício
        if (processo.tipo_beneficio) {
            tags.push(`Benefício: ${processo.tipo_beneficio}`);
        }

        // 3. Status do Processo
        if (processo.status_inss) {
            switch (processo.status_inss) {
                case 'PENDENTE':
                    tags.push('Status: Pendente');
                    break;
                case 'EM_ANALISE':
                    tags.push('Status: Em Análise');
                    break;
                case 'CUMPRIMENTO_DE_EXIGENCIA':
                    tags.push('Status: Em Exigência');
                    break;
                case 'CONCLUIDA':
                    tags.push('Status: Concluído');
                    break;
                case 'CANCELADA':
                    tags.push('Status: Cancelado');
                    break;
            }
        }

        // 4. Resultado Final e Tags Especiais
        switch (classeFinal) {
            case ClasseFinal.EXIGENCIA:
                // Para EXIGÊNCIA, sempre adicionar tag GERALDO para filtro
                tags.push('GERALDO');
                break;
            case ClasseFinal.DEFERIDO:
                tags.push('Resultado: Deferido');
                break;
            case ClasseFinal.INDEFERIDO:
                tags.push('Resultado: Indeferido');
                break;
            case ClasseFinal.DUPLICADO:
                tags.push('Resultado: Duplicado');
                break;
            case ClasseFinal.CANCELADO:
                tags.push('Resultado: Cancelado');
                break;
        }

        return tags;
    }

    /**
     * Trata status EXIGÊNCIA
     * Delega para Intermediação (função, não pessoa específica)
     */
    private async handleExigencia(
        clienteId: string,
        protocolo: string,
        analiseIA: any,
        dadosInss?: any
    ): Promise<void> {
        logger.info(`[InssWorker] Tratando EXIGÊNCIA para cliente ${clienteId}`);

        // Busca processo para identificar tipo de benefício
        const processoDb = await this.buscarProcessoPorProtocolo(protocolo);
        const tipoBeneficio = processoDb?.tipo_beneficio || analiseIA.tipo_beneficio || dadosInss?.beneficio || 'Não identificado';
        const nomeCliente = processoDb?.nome_segurado || dadosInss?.nome || 'Não informado';
        const cpfCliente = processoDb?.cpf_segurado || dadosInss?.cpf || '';

        // 🏷️ 1. Obter tags do cliente no Tramitação (para identificar parceiro)
        const tagsCliente = await tramitacaoService.obterTagsCliente(clienteId);
        const tagsNomes = tagsCliente.map((tag: any) => typeof tag === 'string' ? tag : tag.name || tag.nome || '');

        // 👥 2. Identificar parceiro usando ParceirosService
        const parceiroIdentificado = await parceirosService.identificarParceiroPorTags(tagsNomes);
        const destinatarios = await parceirosService.obterDestinatariosWhatsApp(
            parceiroIdentificado
        );

        logger.info(`[InssWorker] 📱 ${destinatarios.length} destinatário(s) identificado(s)`);

        // 📧 3. Gerar email exclusivo via TramitacaoSyncService
        let emailExclusivo: string | null = null;
        try {
            const resultadoSync = await tramitacaoSyncService.gerarEmailExclusivo(
                parseInt(clienteId),
                nomeCliente
            );

            if (resultadoSync.success && resultadoSync.data?.email) {
                emailExclusivo = resultadoSync.data.email;
                logger.info(`[InssWorker] ✅ Email exclusivo gerado: ${emailExclusivo}`);

                // Salvar no banco para referência futura
                if (processoDb?.id) {
                    await this.db.query(`
                        UPDATE processos 
                        SET email_exclusivo_tramitacao = $1
                        WHERE id = $2
                    `, [emailExclusivo, processoDb.id]).catch(() => { });
                }
            } else {
                logger.warn('[InssWorker] ⚠️ Não foi possível gerar email exclusivo');
            }
        } catch (error: any) {
            logger.error(`[InssWorker] Erro ao gerar email exclusivo: ${error.message}`);
        }

        // 📅 4. Calcular prazo e DER
        const derFormatado = processoDb?.der
            ? new Date(processoDb.der).toLocaleDateString('pt-BR')
            : new Date().toLocaleDateString('pt-BR');

        const prazoFinal = new Date();
        prazoFinal.setDate(prazoFinal.getDate() + 30);
        const diasRestantes = Math.ceil((prazoFinal.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));

        // 🔤 5. Mascarar CPF (formato: 072.xxx.xx1-83)
        const mascararCpf = (cpf: string): string => {
            const cpfLimpo = cpf.replace(/\D/g, '');
            if (cpfLimpo.length !== 11) return cpf;
            return `${cpfLimpo.substring(0, 3)}.xxx.xx${cpfLimpo.substring(8, 9)}-${cpfLimpo.substring(9, 11)}`;
        };
        const cpfMascarado = mascararCpf(cpfCliente);

        // 📝 6. Formatar texto da exigência
        let textoExigencia = analiseIA.motivo_ia || 'N/A';
        textoExigencia = textoExigencia.replace(/^Cumprir\s+exigência:\s*/i, '').trim();

        // 📱 7. Criar mensagem WhatsApp (formato igual ao teste-fluxo)
        let mensagemWhatsApp = `🔔 *NOVA EXIGÊNCIA INSS - Protocolo ${protocolo} - DER: ${derFormatado}* 🔔

*NOME*: ${nomeCliente}
*CPF*: ${cpfMascarado}
Status INSS: *Exigência*

*Exigência*: ${textoExigencia}

*Documentos exigidos*:

${analiseIA.documentos_exigidos?.map((doc: string, idx: number) => `> *${idx + 1}. ${doc}*`).join('\n') || '> *Nenhum documento especificado*'}

*Prazo limite: ${prazoFinal.toLocaleDateString('pt-BR')}*

${emailExclusivo ? `*ENVIE OS DOCUMENTOS PARA*:\n\n${emailExclusivo}\n\n` : ''}*Dias restantes para envio ${diasRestantes} dias a partir desta notificação.*

*✅ Após enviar, responda "ENVIADO" neste chat*`;

        // 📤 8. Enviar WhatsApp para cada destinatário
        for (const destinatario of destinatarios) {
            try {
                await whatsappService.enviar(
                    destinatario.telefone,
                    mensagemWhatsApp
                );

                logger.info(`[InssWorker] ✅ WhatsApp enviado para ${destinatario.nome}`);

                // Tentar salvar no banco (não bloquear se falhar)
                if (processoDb?.id) {
                    await this.db.query(`
                        INSERT INTO notificacoes_whatsapp (
                            processo_id, parceiro_id, tipo, telefone_destino, cidade, mensagem, enviada, data_envio
                        ) VALUES ($1, $2, $3, $4, $5, $6, true, NOW())
                    `, [
                        processoDb.id,
                        destinatario.nome === 'Escritório' ? null : null, // Sempre null (parceiro_id não existe para escritório)
                        'EXIGENCIA_DETECTADA',
                        destinatario.telefone,
                        'ESCRITORIO',
                        mensagemWhatsApp
                    ]).catch((err: any) => {
                        logger.warn(`[InssWorker] ⚠️ Erro ao salvar notificação no banco (não crítico): ${err.message}`);
                    });
                }
            } catch (error: any) {
                logger.error(`[InssWorker] Erro ao enviar WhatsApp para ${destinatario.nome}: ${error.message}`);
            }
        }

        // 🏷️ 9. Aplicar tags no Tramitação (já aplicado no handleStatusChange, mas garantir GERALDO)
        const responsavelExigencia = tramitacaoService.identificarResponsavel(tipoBeneficio, 'EXIGENCIA');
        const { mapearServicoParaTag } = await import('../utils/servicos-inss');
        const servicoTag = mapearServicoParaTag(tipoBeneficio || '');

        await tramitacaoService.aplicarEtiquetas(clienteId, [
            'CLIENTE_INSS',
            'ESCRITÓRIO',
            'ADMINISTRATIVO',
            'EXIGÊNCIA',
            responsavelExigencia, // GERALDO para exigências
            servicoTag
        ]);

        // 📝 10. Criar nota no Tramitação (formato igual ao teste-fluxo)
        const conteudoNota = `*NOME*: ${nomeCliente}
*CPF*: ${cpfMascarado}
Status INSS: *Exigência*

*Exigência*: ${textoExigencia}

*Documentos exigidos*:

${analiseIA.documentos_exigidos?.map((doc: string, idx: number) => `> *${idx + 1}. ${doc}*`).join('\n') || '> *Nenhum documento especificado*'}

*Prazo limite: ${prazoFinal.toLocaleDateString('pt-BR')}*

---
*ENVIE OS DOCUMENTOS PARA*:

${emailExclusivo || 'Email não disponível'}

*Dias restantes para envio ${diasRestantes} dias a partir desta notificação.*

*✅ Após enviar, responda "ENVIADO" neste chat*

---

📅 Extraído automaticamente do PAT via IA em: ${new Date().toLocaleString('pt-BR')}`;

        await tramitacaoService.criarNota(clienteId, {
            titulo: `🔔 NOVA EXIGÊNCIA INSS - Protocolo ${protocolo} - DER: ${derFormatado} 🔔`,
            texto: conteudoNota,
            tipo: 'ALERTA',
        });

        logger.info(`[InssWorker] ✅ Exigência processada: ${destinatarios.length} destinatário(s) notificado(s)`);
    }

    /**
     * Trata status DEFERIDO
     */
    private async handleDeferido(
        clienteId: string,
        protocolo: string,
        analiseIA: any
    ): Promise<void> {
        logger.info(`[InssWorker] Tratando DEFERIDO para cliente ${clienteId}`);

        // 1. Criar nota de sucesso
        await tramitacaoService.criarNota(clienteId, {
            titulo: `🎉 REQUERIMENTO DEFERIDO - Protocolo ${protocolo}`,
            texto: `Motivo: ${analiseIA.motivo_ia}\n\nO benefício foi concedido!`,
            tipo: 'INFORMACAO',
        });

        // 2. Aplicar etiqueta
        await tramitacaoService.aplicarEtiqueta(clienteId, 'Resultado: Deferido');
    }

    /**
     * Trata status INDEFERIDO
     * Decide entre Nova Entrada (falha processual) ou Judicial (falha de mérito)
     */
    private async handleIndeferido(
        clienteId: string,
        protocolo: string,
        analiseIA: any
    ): Promise<void> {
        logger.info(`[InssWorker] Tratando INDEFERIDO para cliente ${clienteId}`);

        // Busca processo no banco para identificar tipo de benefício
        const processoDb = await this.buscarProcessoPorProtocolo(protocolo);
        const tipoBeneficio = processoDb?.tipo_beneficio || analiseIA.tipo_beneficio || 'Não identificado';

        const motivoLower = (analiseIA.motivo_ia || '').toLowerCase();

        // 🔍 Identifica se é falha PROCESSUAL ou de MÉRITO
        const falhasProcessuais = [
            'não compareceu',
            'não comparecimento',
            'ausência',
            'não cumpriu',
            'exigência não cumprida',
            'prazo vencido',
            'não atendeu',
            'falta de documento',
            'documentação incompleta'
        ];

        const eFalhaProcessual = falhasProcessuais.some(termo => motivoLower.includes(termo));

        if (eFalhaProcessual) {
            // ⚠️ FALHA PROCESSUAL → Nova Entrada com Cíntia (intermediacao)
            logger.info(`[InssWorker] Indeferimento por FALHA PROCESSUAL - delegando para Intermediação`);

            await tramitacaoService.criarNota(clienteId, {
                titulo: `⚠️ INDEFERIDO por Falha Processual - Protocolo ${protocolo}`,
                texto: `Motivo: ${analiseIA.motivo_ia}\n\n⚠️ Providenciar NOVA ENTRADA no INSS.`,
                tipo: 'ALERTA',
            });

            await tramitacaoService.criarAtividade(clienteId, {
                titulo: `Nova Entrada INSS - Indeferimento Processual`,
                descricao: `Protocolo anterior: ${protocolo}\n\nMotivo do indeferimento:\n${analiseIA.motivo_ia}\n\nAção: Contatar cliente e dar nova entrada no INSS.`,
                responsavel: 'intermediacao',
                prioridade: 'ALTA',
            });

            await tramitacaoService.aplicarEtiquetas(clienteId, [
                'Resultado: Indeferido',
                'Status: Nova Entrada Necessária',
                'Responsável: Intermediação'
            ]);

            // 4. Criar tarefa no banco de dados (Sistema de Workflow)
            if (processoDb?.id) {
                try {
                    await this.db.query(`
                        INSERT INTO tarefas (
                            processo_id, tipo, prioridade, status, titulo, descricao, 
                            responsavel_perfil, created_at, updated_at
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
                    `, [
                        processoDb.id,
                        'NOVA_ENTRADA',
                        'ALTA',
                        'PENDENTE',
                        'Nova Entrada INSS - Indeferimento Processual',
                        `Protocolo anterior: ${protocolo}\nTipo de Benefício: ${tipoBeneficio}\n\nMotivo: ${analiseIA.motivo_ia}`,
                        'intermediacao'
                    ]);
                    logger.info(`[InssWorker] ✅ Tarefa criada para Intermediação - Nova Entrada (processo ${processoDb.id})`);
                } catch (error) {
                    logger.error('[InssWorker] Erro ao criar tarefa:', error);
                }
            }

        } else {
            // ⚖️ FALHA DE MÉRITO → Análise Judicial
            logger.info(`[InssWorker] Indeferimento de MÉRITO - convertendo para JUDICIAL`);

            // Define responsável jurídico baseado no tipo de benefício
            const responsavelJudicial = tramitacaoService.identificarResponsavel(tipoBeneficio, 'JUDICIAL');

            logger.info(`[InssWorker] 👨‍⚖️ Responsável judicial: ${responsavelJudicial}`);

            // 🏷️ Remover tag ADMINISTRATIVO e adicionar JUDICIAL
            const tagsAtuais = await tramitacaoService.obterTagsCliente(clienteId);
            const tagsFiltradasSemAdmin = tagsAtuais.filter(
                tag => !tag.toUpperCase().includes('ADMINISTRATIVO')
            );

            // Mapear serviço para tag normalizada usando o mapeamento oficial
            const { mapearServicoParaTag } = await import('../utils/servicos-inss');
            const servicoTag = mapearServicoParaTag(tipoBeneficio || '');

            const novasTags = [
                ...tagsFiltradasSemAdmin,
                'JUDICIAL',
                responsavelJudicial,
                'INDEFERIDO',
                servicoTag // Tag do serviço normalizada
            ];

            await tramitacaoService.aplicarEtiquetas(clienteId, novasTags);

            // 📝 Criar nota detalhada no Tramitação
            await tramitacaoService.criarNota(clienteId, {
                titulo: `⚖️ INDEFERIDO - Convertido para JUDICIAL - Protocolo ${protocolo}`,
                texto: `*Tipo de Benefício:* ${tipoBeneficio}\n\n*Motivo do Indeferimento:*\n${analiseIA.motivo_ia}\n\n*Ação:*\nProcesso convertido para fase JUDICIAL.\n\n*Responsável:* ${responsavelJudicial}\n\n*Próximos passos:*\n1. Analisar viabilidade da ação judicial\n2. Preparar documentação necessária\n3. Aguardar orientação do jurídico`,
                tipo: 'ALERTA',
            });

            // Criar tarefa no banco de dados (Sistema de Workflow)
            if (processoDb?.id) {
                try {
                    await this.db.query(`
                        INSERT INTO tarefas (
                            processo_id, tipo, prioridade, status, titulo, descricao, 
                            responsavel_perfil, created_at, updated_at
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
                    `, [
                        processoDb.id,
                        'AVALIACAO_JUDICIAL',
                        'URGENTE',
                        'PENDENTE',
                        'Avaliar Ação Judicial - Indeferimento INSS',
                        `Protocolo: ${protocolo}\nTipo de Benefício: ${tipoBeneficio}\nResponsável: ${responsavelJudicial}\n\nMotivo: ${analiseIA.motivo_ia}`,
                        'judicial'
                    ]);
                    logger.info(`[InssWorker] ✅ Tarefa criada para Judicial - ${responsavelJudicial} (processo ${processoDb.id})`);
                } catch (error) {
                    logger.error('[InssWorker] Erro ao criar tarefa:', error);
                }
            }

            logger.info(`[InssWorker] ✅ Indeferimento convertido para JUDICIAL - Responsável: ${responsavelJudicial}`);
        }
    }

    /**
     * Trata status PERÍCIA/AVALIAÇÃO
     * Cria agendamento e delega para função Administrativo (não pessoa específica)
     */
    private async handlePericia(
        clienteId: string,
        protocolo: string,
        analiseIA: any
    ): Promise<void> {
        logger.info(
            `[InssWorker] Tratando PERÍCIA/AVALIAÇÃO para cliente ${clienteId}`
        );

        if (!analiseIA.data_evento) {
            logger.warn(
                '[InssWorker] Data de perícia não detectada pela IA'
            );
            return;
        }

        // Busca processo para identificar tipo de benefício
        const processoDb = await this.buscarProcessoPorProtocolo(protocolo);
        const tipoBeneficio = processoDb?.tipo_beneficio || analiseIA.tipo_beneficio || 'Não identificado';

        // 1. Criar agendamento
        await tramitacaoService.criarAgendamento(clienteId, {
            titulo: `Perícia/Avaliação INSS - Protocolo ${protocolo}`,
            descricao: analiseIA.motivo_ia,
            data: analiseIA.data_evento,
            local: 'Agência INSS (verificar comunicado)',
        });

        // 2. Criar nota informativa
        await tramitacaoService.criarNota(clienteId, {
            titulo: `📅 Perícia Agendada - ${analiseIA.data_evento.toLocaleDateString('pt-BR')}`,
            texto: `Protocolo: ${protocolo}\nTipo: ${tipoBeneficio}\n\n${analiseIA.motivo_ia}`,
            tipo: 'ALERTA',
        });

        // 3. Criar atividade para função Administrativo
        await tramitacaoService.criarAtividade(clienteId, {
            titulo: `Preparar Cliente para Perícia/Avaliação`,
            descricao: `Protocolo: ${protocolo}\nTipo de Benefício: ${tipoBeneficio}\nData: ${analiseIA.data_evento.toLocaleDateString('pt-BR')}\n\n${analiseIA.motivo_ia}\n\nAção: Contatar cliente e orientar sobre a perícia/avaliação.`,
            responsavel: 'administrativo',
            prioridade: 'ALTA',
        });

        // 4. Aplicar etiquetas (usa função, não nome de pessoa)
        await tramitacaoService.aplicarEtiquetas(clienteId, [
            'Status: Perícia Agendada',
            'Responsável: Administrativo',
            `Benefício: ${tipoBeneficio}`,
            'Perícia Médica'
        ]);

        // 5. Criar tarefa no banco de dados (Sistema de Workflow)
        if (processoDb?.id && analiseIA.data_evento) {
            try {
                await this.db.query(`
                    INSERT INTO tarefas (
                        processo_id, tipo, prioridade, status, titulo, descricao, 
                        responsavel_perfil, prazo, created_at, updated_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
                `, [
                    processoDb.id,
                    'PREPARACAO_PERICIA',
                    'ALTA',
                    'PENDENTE',
                    'Preparar Cliente para Perícia/Avaliação',
                    `Protocolo: ${protocolo}\nTipo de Benefício: ${tipoBeneficio}\nData: ${analiseIA.data_evento.toLocaleDateString('pt-BR')}\n\n${analiseIA.motivo_ia}`,
                    'administrativo',
                    analiseIA.data_evento
                ]);
                logger.info(`[InssWorker] ✅ Tarefa criada para Administrativo (processo ${processoDb.id})`);
            } catch (error) {
                logger.error('[InssWorker] Erro ao criar tarefa:', error);
            }
        }
    }

    /**
     * Trata status CANCELADO
     */
    private async handleCancelado(
        clienteId: string,
        protocolo: string,
        analiseIA: any
    ): Promise<void> {
        logger.info(`[InssWorker] Tratando CANCELADO para cliente ${clienteId}`);

        // 1. Criar nota informativa
        await tramitacaoService.criarNota(clienteId, {
            titulo: `🚫 PROCESSO CANCELADO - Protocolo ${protocolo}`,
            texto: `Motivo: ${analiseIA.motivo_ia}\n\nO processo foi cancelado/excluído do sistema INSS.`,
            tipo: 'INFORMACAO',
        });

        // 2. Aplicar etiqueta
        await tramitacaoService.aplicarEtiqueta(clienteId, 'Status: Cancelado');
    }

    /**
     * Trata status DUPLICADO
     */
    private async handleDuplicado(
        clienteId: string,
        protocolo: string,
        analiseIA: any
    ): Promise<void> {
        logger.info(`[InssWorker] Tratando DUPLICADO para cliente ${clienteId}`);

        // 1. Criar nota de alerta
        await tramitacaoService.criarNota(clienteId, {
            titulo: `⚠️ PROCESSO DUPLICADO - Protocolo ${protocolo}`,
            texto: `${analiseIA.motivo_ia}\n\nEsse protocolo é duplicado. Verificar protocolo correto com o cliente.`,
            tipo: 'ALERTA',
        });

        // 2. Criar atividade para intermediação
        await tramitacaoService.criarAtividade(clienteId, {
            titulo: `Verificar Protocolo Duplicado - INSS`,
            descricao: `Protocolo duplicado: ${protocolo}\n\n${analiseIA.motivo_ia}\n\nAção: Verificar com cliente qual é o protocolo correto.`,
            responsavel: 'intermediacao',
            prioridade: 'MEDIA',
        });

        // 3. Aplicar etiqueta
        await tramitacaoService.aplicarEtiqueta(clienteId, 'Status: Duplicado');
    }

    /**
     * Busca processo no banco pelo protocolo
     */
    private async buscarProcessoPorProtocolo(
        protocolo: string
    ): Promise<any | null> {
        try {
            const result: QueryResult = await this.db.queryFull(
                'SELECT * FROM processos WHERE protocolo_inss = $1',
                [protocolo]
            );

            return result.rows[0] || null;
        } catch (error) {
            logger.error(
                `[InssWorker] Erro ao buscar processo ${protocolo}:`,
                error
            );
            return null;
        }
    }

    /**
     * Salva ou atualiza processo no banco
     */
    private async salvarProcesso(dados: any): Promise<void> {
        try {
            if (dados.processoExistente) {
                // UPDATE
                await this.db.query(
                    `UPDATE processos SET
            status_inss = $1,
            classe_final = $2,
            motivo_ia = $3,
            documentos_exigidos = $4,
            data_evento = $5,
            confianca_ia = $6,
            ultima_atualizacao = NOW()
          WHERE protocolo = $7`,
                    [
                        dados.status_inss,
                        dados.classe_final,
                        dados.motivo_ia,
                        dados.documentos_exigidos,
                        dados.data_evento,
                        dados.confianca_ia,
                        dados.protocolo,
                    ]
                );

                logger.info(`[InssWorker] Processo ${dados.protocolo} atualizado`);
            } else {
                // INSERT
                await this.db.query(
                    `INSERT INTO processos (
            protocolo, cpf, nome, tipo_beneficio, der,
            status_inss, classe_final, motivo_ia,
            documentos_exigidos, data_evento, confianca_ia
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                    [
                        dados.protocolo,
                        dados.cpf,
                        dados.nome,
                        dados.tipo_beneficio,
                        dados.der,
                        dados.status_inss,
                        dados.classe_final,
                        dados.motivo_ia,
                        dados.documentos_exigidos,
                        dados.data_evento,
                        dados.confianca_ia,
                    ]
                );

                logger.info(`[InssWorker] Processo ${dados.protocolo} criado`);
            }

            // Registrar no histórico
            await this.db.query(
                `INSERT INTO historico_status (processo_id, status, observacao)
         SELECT id, $1, $2 FROM processos WHERE protocolo = $3`,
                [dados.status_inss, dados.motivo_ia, dados.protocolo]
            );
        } catch (error) {
            logger.error(
                `[InssWorker] Erro ao salvar processo ${dados.protocolo}:`,
                error
            );
            throw error;
        }
    }

    /**
     * Converte string recebida da IA para o enum ClasseFinal válido
     */
    private normalizarClasseFinal(valor: string): ClasseFinal {
        const valoresValidos = Object.values(ClasseFinal) as string[];

        if (valoresValidos.includes(valor)) {
            return valor as ClasseFinal;
        }

        logger.warn(
            `[InssWorker] Classe final desconhecida recebida da IA: ${valor}. Assumindo PENDENTE.`
        );

        return ClasseFinal.PENDENTE;
    }

    /**
     * Mapeia ClasseFinal da IA para StatusINSS
     */
    private mapearClasseFinalParaStatus(classeFinal: ClasseFinal): StatusINSS {
        const mapeamento: Partial<Record<ClasseFinal, StatusINSS>> = {
            [ClasseFinal.DEFERIDO]: StatusINSS.CONCLUIDA,
            [ClasseFinal.INDEFERIDO]: StatusINSS.CONCLUIDA,
            [ClasseFinal.EXIGENCIA]: StatusINSS.EXIGENCIA,
            [ClasseFinal.PERICIA]: StatusINSS.EM_ANALISE,
            [ClasseFinal.RECURSO]: StatusINSS.EM_ANALISE,
            [ClasseFinal.CANCELADO]: StatusINSS.CANCELADA,
            [ClasseFinal.EM_ANALISE]: StatusINSS.EM_ANALISE,
        };

        return mapeamento[classeFinal] ?? StatusINSS.PENDENTE;
    }

    /**
     * Delay helper
     */
    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * Obtém período de processamento baseado na configuração
     * Por padrão: somente o dia atual (verificação incremental)
     */
    private async obterPeriodoProcessamento(): Promise<{ dataInicio: Date; dataFim: Date }> {
        try {
            // Buscar configuração no banco
            const result = await this.db.query(`
                SELECT modo_processamento, data_inicio_custom, data_fim_custom
                FROM configuracoes_sistema
                WHERE chave = 'periodo_worker'
                ORDER BY updated_at DESC
                LIMIT 1
            `);

            if (result.length > 0) {
                const config = result[0];

                if (config.modo_processamento === 'CUSTOM' && config.data_inicio_custom && config.data_fim_custom) {
                    logger.info(`[InssWorker] Modo CUSTOM ativado pelo Admin`);
                    return {
                        dataInicio: new Date(config.data_inicio_custom),
                        dataFim: new Date(config.data_fim_custom)
                    };
                }
            }

            // Padrão: somente dia atual (incremental)
            const hoje = new Date();
            hoje.setHours(0, 0, 0, 0);
            const amanha = new Date(hoje);
            amanha.setDate(amanha.getDate() + 1);

            logger.info(`[InssWorker] Modo INCREMENTAL (padrão) - processando apenas hoje`);

            return {
                dataInicio: hoje,
                dataFim: amanha
            };
        } catch (error) {
            logger.error('[InssWorker] Erro ao obter período, usando padrão (hoje):', error);

            const hoje = new Date();
            hoje.setHours(0, 0, 0, 0);
            const amanha = new Date(hoje);
            amanha.setDate(amanha.getDate() + 1);

            return {
                dataInicio: hoje,
                dataFim: amanha
            };
        }
    }

    /**
     * Registra início de execução do Worker
     */
    private async iniciarExecucao(tipo: 'AUTOMATICO' | 'MANUAL' | 'CUSTOM'): Promise<string> {
        try {
            const result = await this.db.query(`
                INSERT INTO execucoes_worker (tipo, status, data_inicio)
                VALUES ($1, 'EM_ANDAMENTO', NOW())
                RETURNING id
            `, [tipo]);

            return result[0]?.id || 'unknown';
        } catch (error) {
            logger.error('[InssWorker] Erro ao registrar execução:', error);
            return 'unknown';
        }
    }

    /**
     * Finaliza registro de execução do Worker
     */
    private async finalizarExecucao(
        execucaoId: string,
        status: 'SUCESSO' | 'ERRO',
        processados: number,
        mudancas: number,
        erros: number
    ): Promise<void> {
        try {
            await this.db.query(`
                UPDATE execucoes_worker
                SET status = $1,
                    data_fim = NOW(),
                    protocolos_processados = $2,
                    mudancas_detectadas = $3,
                    erros = $4
                WHERE id = $5
            `, [status, processados, mudancas, erros, execucaoId]);
        } catch (error) {
            logger.error('[InssWorker] Erro ao finalizar execução:', error);
        }
    }

    /**
     * Processa agendamentos de perícia e avaliação social
     */
    private async processarAgendamentos(
        protocolo: string,
        cpf: string,
        nome: string,
        tipoBeneficio: string,
        processoId: string,
        clienteIdTramitacao: string | number | null
    ): Promise<void> {
        try {
            logger.info(`[InssWorker] 🔍 Verificando agendamentos para protocolo ${protocolo}`);

            if (!clienteIdTramitacao) {
                logger.warn(`[InssWorker] ⚠️ Cliente não encontrado no Tramitação, pulando agendamentos`);
                return;
            }

            const page = puppeteerService.getPage();
            if (!page) {
                logger.warn(`[InssWorker] ⚠️ Page não disponível, pulando agendamentos`);
                return;
            }

            // Verificar se precisa de perícia/avaliação
            const { precisaPericia, precisaAvaliacao } = agendamentosService.precisaPericiaOuAvaliacao(tipoBeneficio || '');

            if (!precisaPericia && !precisaAvaliacao) {
                logger.info(`[InssWorker] ℹ️ Benefício não requer perícia ou avaliação`);
                return;
            }

            logger.info(`[InssWorker] 📅 Benefício requer ${precisaPericia ? 'PERÍCIA' : ''} ${precisaAvaliacao ? 'AVALIAÇÃO SOCIAL' : ''}`);

            // Verificar botões "Agendar"
            const tiposParaAgendar = await agendamentosService.verificarBotoesAgendar(page);

            if (tiposParaAgendar.length > 0) {
                logger.info(`[InssWorker] ⚠️ Botões "Agendar" encontrados: ${tiposParaAgendar.join(', ')}`);

                const tagsAgendar: string[] = [];
                if (tiposParaAgendar.includes('PERICIA')) {
                    tagsAgendar.push('AGENDAR_PERICIA');
                }
                if (tiposParaAgendar.includes('AVALIACAO_SOCIAL')) {
                    tagsAgendar.push('AGENDAR_AVALIACAO');
                }

                if (tagsAgendar.length > 0) {
                    await tramitacaoService.aplicarEtiquetas(clienteIdTramitacao.toString(), tagsAgendar);
                    logger.info(`[InssWorker] 🏷️ Tags aplicadas: ${tagsAgendar.join(', ')}`);

                    // Enviar WhatsApp para Geraldo
                    const cpfMascarado = cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.xxx.xx$4-$5');
                    const mensagemAgendar = `⚠️ *AGENDAMENTO NECESSÁRIO* ⚠️%0A%0A` +
                        `*Protocolo*: ${protocolo}%0A` +
                        `*Cliente*: ${nome || 'Não informado'}%0A` +
                        `*CPF*: ${cpfMascarado}%0A%0A` +
                        `*⚠️ ATENÇÃO: É necessário agendar ${tiposParaAgendar.map(t => t === 'PERICIA' ? 'PERÍCIA MÉDICA' : 'AVALIAÇÃO SOCIAL').join(' e ')}*%0A%0A` +
                        `*🔗 Acesse o processo diretamente*:%0A` +
                        `https://atendimento.inss.gov.br/tarefas/detalhar_tarefa/${protocolo}%0A%0A` +
                        `*📅 Extraído automaticamente do PAT via IA em:* ${new Date().toLocaleString('pt-BR')}`;

                    try {
                        await whatsappService.enviar(
                            '557788682628',
                            decodeURIComponent(mensagemAgendar)
                        );
                        logger.info('[InssWorker] ✅ WhatsApp enviado para Geraldo sobre necessidade de agendamento');
                    } catch (error: any) {
                        logger.warn(`[InssWorker] ⚠️ Erro ao enviar WhatsApp para Geraldo: ${error.message}`);
                    }
                }
            }

            // Processar agendamentos existentes
            const agendamentosProcessados: any[] = [];

            if (precisaAvaliacao) {
                try {
                    const avaliacoes = await agendamentosService.extrairAvaliacoesSociais(page, protocolo, cpf);
                    const agendadas = agendamentosService.filtrarAgendados(avaliacoes);
                    const remarcadas = avaliacoes.filter(a => a.status === 'REMARCADO');

                    // Processar agendamentos AGENDADOS
                    for (const agendamento of agendadas) {
                        await this.processarAgendamento(
                            agendamento,
                            'AVALIACAO_SOCIAL',
                            processoId,
                            clienteIdTramitacao.toString(),
                            protocolo,
                            cpf
                        );
                        agendamentosProcessados.push(agendamento);
                    }

                    // Verificar se há remarcações e atualizar atividades existentes
                    if (remarcadas.length > 0 && agendadas.length > 0) {
                        await this.atualizarAgendamentoRemarcado(
                            agendadas[0],
                            'AVALIACAO_SOCIAL',
                            processoId,
                            clienteIdTramitacao.toString()
                        );
                    }
                } catch (error: any) {
                    logger.warn(`[InssWorker] ⚠️ Erro ao extrair avaliações sociais: ${error.message}`);
                }
            }

            if (precisaPericia) {
                try {
                    const pericias = await agendamentosService.extrairPericiasMedicas(page, protocolo, cpf);
                    const agendadas = agendamentosService.filtrarAgendados(pericias);
                    const remarcadas = pericias.filter(a => a.status === 'REMARCADO');

                    // Processar agendamentos AGENDADOS
                    for (const agendamento of agendadas) {
                        await this.processarAgendamento(
                            agendamento,
                            'PERICIA',
                            processoId,
                            clienteIdTramitacao.toString(),
                            protocolo,
                            cpf
                        );
                        agendamentosProcessados.push(agendamento);
                    }

                    // Verificar se há remarcações e atualizar atividades existentes
                    if (remarcadas.length > 0 && agendadas.length > 0) {
                        await this.atualizarAgendamentoRemarcado(
                            agendadas[0],
                            'PERICIA',
                            processoId,
                            clienteIdTramitacao.toString()
                        );
                    }
                } catch (error: any) {
                    logger.warn(`[InssWorker] ⚠️ Erro ao extrair perícias médicas: ${error.message}`);
                }
            }

            if (agendamentosProcessados.length > 0) {
                logger.info(`[InssWorker] ✅ ${agendamentosProcessados.length} agendamento(s) processado(s)`);
            }
        } catch (error: any) {
            logger.error(`[InssWorker] ❌ Erro ao processar agendamentos: ${error.message}`);
            // Não bloquear o fluxo principal
        }
    }

    /**
     * Processa um agendamento individual (cria ou atualiza)
     */
    private async processarAgendamento(
        agendamento: any,
        tipo: 'PERICIA' | 'AVALIACAO_SOCIAL',
        processoId: string,
        clienteId: string,
        protocolo: string,
        cpf: string
    ): Promise<void> {
        try {
            const page = puppeteerService.getPage();
            if (!page) return;

            // Extrair detalhes completos
            const detalhesAgendamento = await agendamentosService.extrairDetalhesAgendamento(page, agendamento);

            if (!detalhesAgendamento) {
                logger.warn(`[InssWorker] ⚠️ Não foi possível extrair detalhes do agendamento`);
                return;
            }

            // Verificar se já existe no banco
            const agendamentoExistente = await this.db.query(`
                SELECT id, tramitacao_atividade_id
                FROM agendamentos
                WHERE processo_id = $1 AND tipo = $2 AND data_agendamento = $3
            `, [processoId, tipo, detalhesAgendamento.data]);

            if (agendamentoExistente.length > 0 && agendamentoExistente[0].tramitacao_atividade_id) {
                // Atualizar atividade existente
                logger.info(`[InssWorker] 🔄 Atualizando atividade existente (ID: ${agendamentoExistente[0].tramitacao_atividade_id})`);

                await tramitacaoSyncService.atualizarAtividade(
                    agendamentoExistente[0].tramitacao_atividade_id,
                    {
                        data: detalhesAgendamento.data,
                        hora: detalhesAgendamento.hora,
                        unidade: detalhesAgendamento.unidade
                    },
                    `Agendamento atualizado automaticamente em ${new Date().toLocaleString('pt-BR')}`
                );

                // Atualizar no banco
                await this.db.query(`
                    UPDATE agendamentos
                    SET hora_agendamento = $1,
                        unidade = $2,
                        endereco = $3,
                        status = $4,
                        servico = $5,
                        url_comprovante = $6,
                        updated_at = NOW()
                    WHERE id = $7
                `, [
                    detalhesAgendamento.hora,
                    detalhesAgendamento.unidade,
                    detalhesAgendamento.endereco || null,
                    'AGENDADO',
                    detalhesAgendamento.servico || null,
                    detalhesAgendamento.urlComprovante || null,
                    agendamentoExistente[0].id
                ]);
            } else {
                // Criar nova atividade
                logger.info(`[InssWorker] ➕ Criando nova atividade de ${tipo}`);

                const atividadeCriada = await tramitacaoSyncService.cadastrarAtividade(
                    parseInt(clienteId),
                    {
                        tipo,
                        data: detalhesAgendamento.data,
                        hora: detalhesAgendamento.hora,
                        unidade: detalhesAgendamento.unidade,
                        endereco: detalhesAgendamento.endereco,
                        servico: detalhesAgendamento.servico,
                        urlComprovante: detalhesAgendamento.urlComprovante
                    }
                );

                if (atividadeCriada) {
                    // Aplicar tag
                    const tag = tipo === 'PERICIA' ? 'PERICIA_AGENDADA' : 'AVALIACAO_AGENDADA';
                    await tramitacaoService.aplicarEtiquetas(clienteId, [tag]);

                    // Salvar no banco
                    await this.db.query(`
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
                            updated_at = NOW()
                    `, [
                        processoId,
                        protocolo,
                        cpf.replace(/\D/g, ''),
                        tipo,
                        detalhesAgendamento.data,
                        detalhesAgendamento.hora,
                        detalhesAgendamento.unidade,
                        detalhesAgendamento.endereco || null,
                        'AGENDADO',
                        detalhesAgendamento.servico || null,
                        detalhesAgendamento.urlComprovante || null
                    ]);

                    logger.info(`[InssWorker] ✅ Agendamento salvo no banco`);
                }
            }
        } catch (error: any) {
            logger.error(`[InssWorker] ❌ Erro ao processar agendamento: ${error.message}`);
        }
    }

    /**
     * Atualiza agendamento que foi remarcado
     */
    private async atualizarAgendamentoRemarcado(
        novoAgendamento: any,
        tipo: 'PERICIA' | 'AVALIACAO_SOCIAL',
        processoId: string,
        clienteId: string
    ): Promise<void> {
        try {
            // Buscar agendamento antigo no banco
            const agendamentoAntigo = await this.db.query(`
                SELECT id, tramitacao_atividade_id, data_agendamento
                FROM agendamentos
                WHERE processo_id = $1 AND tipo = $2
                ORDER BY created_at DESC
                LIMIT 1
            `, [processoId, tipo]);

            if (agendamentoAntigo.length > 0 && agendamentoAntigo[0].tramitacao_atividade_id) {
                const page = puppeteerService.getPage();
                if (!page) return;

                // Extrair detalhes do novo agendamento
                const detalhesNovo = await agendamentosService.extrairDetalhesAgendamento(page, novoAgendamento);

                if (detalhesNovo) {
                    logger.info(`[InssWorker] 🔄 Agendamento REMARCADO detectado, atualizando atividade`);

                    await tramitacaoSyncService.atualizarAtividade(
                        agendamentoAntigo[0].tramitacao_atividade_id,
                        {
                            data: detalhesNovo.data,
                            hora: detalhesNovo.hora,
                            unidade: detalhesNovo.unidade
                        },
                        `Agendamento REMARCADO. Nova data: ${detalhesNovo.data.toLocaleDateString('pt-BR')} às ${detalhesNovo.hora}. Atualizado automaticamente em ${new Date().toLocaleString('pt-BR')}`
                    );

                    // Atualizar no banco
                    await this.db.query(`
                        UPDATE agendamentos
                        SET data_agendamento = $1,
                            hora_agendamento = $2,
                            unidade = $3,
                            endereco = $4,
                            status = 'AGENDADO',
                            updated_at = NOW()
                        WHERE id = $5
                    `, [
                        detalhesNovo.data,
                        detalhesNovo.hora,
                        detalhesNovo.unidade,
                        detalhesNovo.endereco || null,
                        agendamentoAntigo[0].id
                    ]);

                    logger.info(`[InssWorker] ✅ Agendamento atualizado após remarcação`);
                }
            }
        } catch (error: any) {
            logger.error(`[InssWorker] ❌ Erro ao atualizar agendamento remarcado: ${error.message}`);
        }
    }

    /**
     * Para o Worker (para testes/manutenção)
     */
    stop(): void {
        logger.info('[InssWorker] Worker parado');
        // Implementar lógica de parada se necessário
    }
}

export default new InssWorker();
