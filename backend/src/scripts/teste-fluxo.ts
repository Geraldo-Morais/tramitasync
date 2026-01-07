import puppeteerService from '../services/PuppeteerService';
import aiService from '../services/AIService';
import tramitacaoService from '../services/TramitacaoService';
import whatsappService from '../services/WhatsAppService';
import tramitacaoSyncService from '../services/TramitacaoSyncService';
import agendamentosService from '../services/AgendamentosService';
import Database from '../database';
import logger from '../utils/logger';
import * as fs from 'fs';
import * as path from 'path';
import { mapearServicoParaTag } from '../utils/servicos-inss';
import config from '../config';

/**
 * Analisa se um indeferimento foi por culpa do cliente/escritório ou por mérito (critérios não atendidos)
 * @param textoDespacho Texto completo do despacho de indeferimento
 * @returns 'CULPA' se for por culpa (nova entrada administrativa) ou 'MERITO' se for por mérito (judicial)
 */
function analisarTipoIndeferimento(textoDespacho: string): 'CULPA' | 'MERITO' {
    const textoLower = textoDespacho.toLowerCase();

    // Palavras-chave que indicam culpa do CLIENTE/ESCRITÓRIO
    const palavrasCulpa = [
        'não compareceu',
        'nao compareceu',
        'ausência',
        'ausencia',
        'não apresentou',
        'nao apresentou',
        'não cumpriu',
        'nao cumpriu',
        'exigência não atendida',
        'exigencia nao atendida',
        'exigência não cumprida',
        'exigencia nao cumprida',
        'prazo vencido',
        'desistência',
        'desistencia',
        'faltou',
        'falta de documento',
        'documentação incompleta',
        'documentacao incompleta'
    ];

    // Palavras-chave que indicam CRITÉRIO/MÉRITO não atendido
    const palavrasMerito = [
        'não reconhec',
        'nao reconhec',
        'não comprovou',
        'nao comprovou',
        'renda',
        'miserabilidade',
        'deficiência não caracterizada',
        'deficiencia nao caracterizada',
        'impedimento de longo prazo não',
        'não atende critério',
        'nao atende criterio',
        'não atende requisito',
        'nao atende requisito',
        'critério',
        'criterio',
        'requisito',
        'incapacidade não',
        'incapacidade nao',
        'não caracteriza',
        'nao caracteriza'
    ];

    let pontosCulpa = 0;
    let pontosMerito = 0;

    for (const palavra of palavrasCulpa) {
        if (textoLower.includes(palavra)) pontosCulpa++;
    }

    for (const palavra of palavrasMerito) {
        if (textoLower.includes(palavra)) pontosMerito++;
    }

    // Se tiver evidência clara, retornar automaticamente
    if (pontosCulpa > pontosMerito && pontosCulpa >= 1) {
        logger.info(`🤖 Indeferimento detectado como CULPA (pontos: ${pontosCulpa} vs ${pontosMerito})`);
        return 'CULPA';
    }

    if (pontosMerito > pontosCulpa && pontosMerito >= 1) {
        logger.info(`🤖 Indeferimento detectado como MÉRITO (pontos: ${pontosMerito} vs ${pontosCulpa})`);
        return 'MERITO';
    }

    // Se ambíguo, assumir MÉRITO (mais conservador - vai para judicial)
    logger.warn(`⚠️ Indeferimento ambíguo (pontos: culpa=${pontosCulpa}, mérito=${pontosMerito}). Assumindo MÉRITO (judicial).`);
    return 'MERITO';
}

async function testarFluxoCompleto() {
    try {
        // Limpar logs antes do teste
        const logsDir = path.join(process.cwd(), 'logs');
        if (fs.existsSync(logsDir)) {
            const files = fs.readdirSync(logsDir);
            for (const file of files) {
                if (file.endsWith('.png') || file.endsWith('.html')) {
                    try {
                        fs.unlinkSync(path.join(logsDir, file));
                    } catch (err) {
                        // Ignorar erros ao deletar
                    }
                }
            }
            logger.info(`🧹 Limpeza de logs: ${files.filter(f => f.endsWith('.png') || f.endsWith('.html')).length} arquivos removidos`);
        }

        logger.info('========== TESTE MANUAL INICIADO ==========');

        await puppeteerService.initialize();
        // Novo token do PAT (válido por ~30 minutos)
        const novoToken = config.inss.accessToken;
        if (!novoToken) {
            throw new Error('INSS_ACCESS_TOKEN não configurado no .env');
        }
        await puppeteerService.login(novoToken);

        // Data range: 01/07/2025 até 21/10/2025
        const dataInicio = new Date('2025-07-01');
        dataInicio.setHours(0, 0, 0, 0);
        const dataFim = new Date('2025-10-21');
        dataFim.setHours(23, 59, 59, 999);

        logger.info(`Coletando protocolos (${dataInicio.toLocaleDateString('pt-BR')} a ${dataFim.toLocaleDateString('pt-BR')}, EXIGENCIA)...`);

        const protocolos = await puppeteerService.coletarProtocolos(
            dataInicio,
            dataFim,
            'EXIGENCIA'
        );

        if (protocolos.length === 0) {
            logger.warn('⚠️ Nenhum protocolo encontrado com status EXIGENCIA nos últimos 7 dias');
            await puppeteerService.close();
            return;
        }

        logger.info(`✅ ${protocolos.length} protocolo(s) encontrado(s)`);

        // Função auxiliar para enviar notificação de agendamento e registrar nas notas
        const enviarNotificacaoAgendamento = async (
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
            processoId?: string | null
        ) => {
            try {
                const tipoTexto = tipo === 'PERICIA' ? 'PERÍCIA MÉDICA' : 'AVALIAÇÃO SOCIAL';
                const cpfMascarado = cpfCliente.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.xxx.xx$4-$5');
                const dataFormatada = data.toLocaleDateString('pt-BR');
                const dataHoraAtual = new Date().toLocaleString('pt-BR');

                // Montar mensagem WhatsApp
                let mensagemWhatsApp = `📅 *AGENDAMENTO CONFIRMADO* 📅%0A%0A` +
                    `🏛️ *Serviço*: ${tipoTexto}%0A` +
                    `👤 *Cliente*: ${nomeCliente} (CPF: ${cpfMascarado})%0A` +
                    `🔢 *Protocolo*: ${protocolo}%0A%0A` +
                    `📆 *Data*: ${dataFormatada}%0A` +
                    `⏰ *Hora*: ${hora}%0A` +
                    `📍 *Local*: ${unidade}%0A`;

                if (endereco) {
                    mensagemWhatsApp += `🗺️ *Endereço*: ${endereco}%0A`;
                }

                if (urlComprovante) {
                    mensagemWhatsApp += `%0A📄 *Comprovante*:%0A${urlComprovante}%0A`;
                }

                mensagemWhatsApp += `%0A🔗 *Link do Processo*:%0A` +
                    `https://atendimento.inss.gov.br/tarefas/detalhar_tarefa/${protocolo}%0A%0A` +
                    `🤖 *Agendamento cadastrado automaticamente em:* ${dataHoraAtual}`;

                // Enviar para escritório (não tem parceiro ainda)
                const telefoneEscritorio = '+557788682628';
                const apiKeyEscritorio = '5547794';
                const enviado = await whatsappService.enviar(
                    telefoneEscritorio.replace('+', ''),
                    decodeURIComponent(mensagemWhatsApp)
                );

                if (enviado) {
                    logger.info(`✅ Notificação de ${tipoTexto} enviada para escritório`);

                    // Registrar nas notas
                    const conteudoNota = `📅 *AGENDAMENTO CONFIRMADO - ${tipoTexto}*%0A%0A` +
                        `🔢 *Protocolo*: ${protocolo}%0A` +
                        `👤 *Cliente*: ${nomeCliente} (CPF: ${cpfMascarado})%0A%0A` +
                        `📆 *Data*: ${dataFormatada}%0A` +
                        `⏰ *Hora*: ${hora}%0A` +
                        `📍 *Local*: ${unidade}%0A` +
                        (endereco ? `🗺️ *Endereço*: ${endereco}%0A` : '') +
                        (urlComprovante ? `%0A📄 *Comprovante*: ${urlComprovante}%0A` : '') +
                        `%0A📱 *Notificação WhatsApp*: Enviada para Escritório (${telefoneEscritorio}) em ${dataHoraAtual}%0A%0A` +
                        `🔗 *Link do Processo*: https://atendimento.inss.gov.br/tarefas/detalhar_tarefa/${protocolo}%0A%0A` +
                        `---%0A🤖 *Extraído automaticamente via IA* em ${dataHoraAtual}`;

                    await tramitacaoService.criarNota(clienteId, {
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
                                telefoneEscritorio,
                                'ESCRITORIO',
                                decodeURIComponent(mensagemWhatsApp)
                            ]);
                        } catch (error: any) {
                            logger.warn(`⚠️ Erro ao salvar notificação no banco: ${error.message}`);
                        }
                    }
                } else {
                    logger.warn(`⚠️ Falha ao enviar notificação de ${tipoTexto} para escritório`);
                }
            } catch (error: any) {
                logger.error(`❌ Erro ao enviar notificação de agendamento: ${error.message}`);
            }
        };

        // Processar apenas os protocolos encontrados na busca
        logger.info(`📋 Processando ${protocolos.length} protocolo(s) encontrado(s)`);

        // Processar cada protocolo
        for (let idx = 0; idx < protocolos.length; idx++) {
            const protocolo = protocolos[idx];
            const status = 'EXIGENCIA'; // Status padrão para protocolos encontrados na busca de exigências
            logger.info(`\n${'='.repeat(80)}`);
            logger.info(`📋 PROCESSANDO PROTOCOLO ${idx + 1}/${protocolos.length}: ${protocolo} (${status})`);
            logger.info(`${'='.repeat(80)}\n`);

            // 🔥 CRÍTICO: Garantir que estamos na aba do PAT antes de processar cada protocolo
            // O PAT só carrega dados quando está na aba ativa
            if (idx > 0) {
                logger.info('🔄 Garantindo que estamos na aba do PAT antes de processar protocolo...');
                const patPage = puppeteerService.getPage();
                if (patPage) {
                    try {
                        await patPage.bringToFront();
                        logger.info('✅ Aba do PAT ativada antes de processar protocolo');
                        // Aguardar um pouco para garantir que está ativa
                        await patPage.waitForTimeout(1000);
                    } catch (err: any) {
                        logger.warn(`⚠️ Erro ao voltar para aba do PAT (não crítico): ${err.message}`);
                    }
                } else {
                    logger.warn('⚠️ Página do PAT não encontrada (PuppeteerService)');
                }
            }

            const servicoDaLista = puppeteerService.obterServicoPorProtocolo(protocolo);
            if (servicoDaLista) {
                logger.info(`📋 Serviço extraído da lista: ${servicoDaLista}`);
            }

            logger.info('Extraindo detalhes COMPLETOS...');
            const detalhes = await puppeteerService.extrairDetalhesProtocolo(protocolo, {
                dataInicio,
                dataFim,
                status: status
            });

            logger.info(`CPF: ${detalhes.cpf} | Nome: ${detalhes.nome} | Benefício: ${detalhes.servico}`);
            logger.info(`Status: ${detalhes.statusAtual} | Comentários: ${detalhes.comentarios.length}`);

            // Extrair últimos 3 comentários (mais recentes) para análise com contexto
            const ultimosComentarios = detalhes.comentarios.slice(-3);

            if (ultimosComentarios.length === 0) {
                logger.error(`❌ Protocolo ${protocolo} não tem comentários, pulando...`);
                continue; // Pular para o próximo protocolo
            }

            // Preparar array de cards para IA (com data formatada)
            const cardsParaIA = ultimosComentarios.map(comentario => ({
                data: comentario.data.toLocaleDateString('pt-BR'),
                texto: comentario.texto
            }));

            logger.info(`Analisando últimos ${cardsParaIA.length} card(s) com contexto completo...`);
            const analiseIA = await aiService.analisarTextoInss(
                cardsParaIA,
                protocolo,
                detalhes.dataNascimento
            );
            logger.info(`Classe: ${analiseIA.classe_final} | Docs: ${analiseIA.documentos_exigidos?.length || 0}`);

            // Calcular prazo baseado na data do card que contém a exigência
            // Se a IA retornou data_evento, usar ela. Caso contrário, procurar o card com exigência real
            let prazoFinal: Date;
            let diasPrazo: number;

            if (analiseIA.data_evento) {
                // IA calculou o prazo corretamente
                prazoFinal = new Date(analiseIA.data_evento);
                const hoje = new Date();
                diasPrazo = Math.ceil((prazoFinal.getTime() - hoje.getTime()) / (1000 * 60 * 60 * 24));
                logger.info(`📅 Prazo calculado pela IA: ${prazoFinal.toLocaleDateString('pt-BR')} (${diasPrazo} dias restantes)`);
            } else {
                // Procurar o card que contém a exigência real (não "tarefa transferida", "agendamento realizado", etc.)
                let cardComExigencia = ultimosComentarios[ultimosComentarios.length - 1]; // Por padrão, último

                // Se o último card não parece ter exigência, procurar nos anteriores
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
                            logger.info(`📋 Exigência real encontrada no card anterior (${cardComExigencia.data.toLocaleDateString('pt-BR')})`);
                            break;
                        }
                    }
                }

                // Usar data do card com exigência + 30 dias (padrão)
                prazoFinal = new Date(cardComExigencia.data);
                prazoFinal.setDate(prazoFinal.getDate() + 30);
                diasPrazo = 30;

                // Tentar extrair prazo específico do texto (ex: "120 dias", "até 20/11/2025")
                const textoExigencia = cardComExigencia.texto;
                const matchPrazoEspecifico = textoExigencia.match(/(\d{1,3})\s*dias/);
                const matchDataEspecifica = textoExigencia.match(/até\s+(\d{2}\/\d{2}\/\d{4})/i);

                if (matchDataEspecifica) {
                    // Data específica mencionada
                    const [dia, mes, ano] = matchDataEspecifica[1].split('/').map(Number);
                    prazoFinal = new Date(ano, mes - 1, dia);
                    const hoje = new Date();
                    diasPrazo = Math.ceil((prazoFinal.getTime() - hoje.getTime()) / (1000 * 60 * 60 * 24));
                    logger.info(`📅 Prazo específico encontrado no texto: ${prazoFinal.toLocaleDateString('pt-BR')}`);
                } else if (matchPrazoEspecifico) {
                    // Prazo específico em dias mencionado
                    const diasMencionados = parseInt(matchPrazoEspecifico[1]);
                    prazoFinal = new Date(cardComExigencia.data);
                    prazoFinal.setDate(prazoFinal.getDate() + diasMencionados);
                    diasPrazo = diasMencionados;
                    logger.info(`📅 Prazo específico encontrado: ${diasMencionados} dias a partir de ${cardComExigencia.data.toLocaleDateString('pt-BR')}`);
                } else {
                    logger.info(`📅 Usando prazo padrão: 30 dias a partir de ${cardComExigencia.data.toLocaleDateString('pt-BR')}`);
                }
            }

            logger.info('Criando/Buscando cliente no Tramitação...');
            let clienteId = await tramitacaoService.buscarCliente(detalhes.cpf);

            if (!clienteId) {
                clienteId = await tramitacaoService.criarCliente({
                    nome: detalhes.nome,
                    cpf: detalhes.cpf,
                    protocolo: protocolo,
                    servico: detalhes.servico
                });
                logger.info(`Cliente criado: ${typeof clienteId === 'string' ? clienteId : clienteId?.id}`);
            } else {
                logger.info(`Cliente encontrado: ${typeof clienteId === 'string' ? clienteId : clienteId?.id}`);
            }

            const idCliente = typeof clienteId === 'string' ? clienteId : (clienteId?.id || '');

            if (!idCliente) {
                logger.error(`Falha ao obter ID do cliente para protocolo ${protocolo}, pulando...`);
                continue; // Pular para o próximo protocolo
            }

            logger.info('🏷️ Sincronizando tags com Tramitação...');

            // Detectar tipo de status ANTES de montar tags
            const statusNormalizadoUpper = (detalhes.statusAtual || '').toUpperCase();
            const classeFinalUpper = (analiseIA.classe_final || '').toUpperCase();
            const ehExigencia = statusNormalizadoUpper.includes('EXIGENCIA') || statusNormalizadoUpper.includes('EXIGÊNCIA') || classeFinalUpper === 'EXIGENCIA' || classeFinalUpper === 'EXIGÊNCIA';
            const ehDeferido = statusNormalizadoUpper.includes('DEFERIDO') || classeFinalUpper === 'DEFERIDO' || statusNormalizadoUpper.includes('CONCLUIDA') && classeFinalUpper === 'DEFERIDO';
            const ehIndeferido = statusNormalizadoUpper.includes('INDEFERIDO') || classeFinalUpper === 'INDEFERIDO';

            // Para indeferimento, usar classificação da IA (mais precisa que palavras-chave)
            let tipoIndeferimento: 'CULPA' | 'MERITO' | null = null;
            if (ehIndeferido) {
                // Priorizar classificação da IA se disponível
                if (analiseIA.tipo_indeferimento) {
                    tipoIndeferimento = analiseIA.tipo_indeferimento;
                    logger.info(`🤖 Tipo de indeferimento detectado pela IA: ${tipoIndeferimento}`);
                } else {
                    // Fallback: usar função de palavras-chave se IA não classificou
                    const ultimoComentarioTexto = ultimosComentarios[ultimosComentarios.length - 1]?.texto || '';
                    const textoCompleto = ultimoComentarioTexto || analiseIA.motivo_ia || '';
                    tipoIndeferimento = analisarTipoIndeferimento(textoCompleto);
                    logger.info(`🔍 Tipo de indeferimento detectado por palavras-chave (fallback): ${tipoIndeferimento}`);
                }
            }

            // Determinar fase (ADMINISTRATIVO ou JUDICIAL)
            // Se for indeferimento por mérito, mudar para JUDICIAL
            // Se for indeferimento por culpa (FAZER_NOVO_REQ_ADMINISTRATIVO), SEMPRE ADMINISTRATIVO
            let fase = detalhes.statusAtual.toUpperCase().includes('JUDICIAL') ? 'JUDICIAL' : 'ADMINISTRATIVO';
            if (ehIndeferido && tipoIndeferimento === 'MERITO') {
                fase = 'JUDICIAL';
                logger.info('⚖️ Indeferimento por mérito: convertendo fase para JUDICIAL');
            } else if (ehIndeferido && tipoIndeferimento === 'CULPA') {
                // Indeferimento por culpa sempre é ADMINISTRATIVO (nova entrada administrativa)
                fase = 'ADMINISTRATIVO';
                logger.info('📋 Indeferimento por culpa: fase ADMINISTRATIVO (nova entrada)');
            }

            // Normalizar status para tag
            const statusNormalizado = detalhes.statusAtual.toUpperCase().includes('EXIGENCIA') ||
                detalhes.statusAtual.toUpperCase().includes('EXIGÊNCIA')
                ? 'EXIGÊNCIA'
                : detalhes.statusAtual.replace(/\s+/g, '_').toUpperCase();

            // Mapear serviço para tag normalizada usando o mapeamento oficial
            const { mapearServicoParaTag, servicoEstaMapeado, normalizarServico } = await import('../utils/servicos-inss');

            // Se o serviço não está mapeado, normalizar o nome do serviço para tag
            // Se serviço estiver vazio, não criar tag de serviço
            // Usar serviço da lista se disponível, senão usar do detalhes
            const servicoParaTag = servicoDaLista || detalhes.servico || '';
            let servicoTag: string | null = null;
            if (servicoParaTag && servicoParaTag.trim()) {
                if (servicoEstaMapeado(servicoParaTag)) {
                    servicoTag = mapearServicoParaTag(servicoParaTag);
                } else {
                    // Normalizar serviço não-benefício para tag (ex: "Atualizar Procurador" -> "ATUALIZAR_PROCURADOR")
                    servicoTag = normalizarServico(servicoParaTag);
                    logger.info(`[Script] ⚠️ Serviço não mapeado, normalizado para tag: ${servicoTag}`);
                }
            } else {
                logger.info(`[Script] ⚠️ Serviço não informado, não será adicionada tag de serviço`);
            }

            // Buscar responsável usando TramitacaoService (método já implementado)
            // NÃO definir responsável se for OUTROS_PEDIDOS (serviço não é benefício)
            let responsavel = 'A DEFINIR';
            const servicoFinal = servicoDaLista || detalhes.servico || '';
            const ehOutrosPedidos = servicoFinal && !servicoEstaMapeado(servicoFinal);

            if (!ehOutrosPedidos) {
                try {
                    // Garantir que fase seja um dos tipos esperados
                    const faseTipo: 'ADMINISTRATIVO' | 'JUDICIAL' | 'EXIGENCIA' = fase === 'JUDICIAL' ? 'JUDICIAL' : 'ADMINISTRATIVO';

                    // Usar a tag normalizada do serviço para identificar responsável (mais confiável)
                    const servicoTagNormalizada = servicoTag || servicoFinal;
                    responsavel = tramitacaoService.identificarResponsavel(servicoTagNormalizada, faseTipo);
                    logger.info(`✅ Responsável identificado: ${responsavel} (serviço: ${servicoTagNormalizada}, fase: ${faseTipo})`);
                } catch (error) {
                    logger.warn(`⚠️ Erro ao identificar responsável: ${error}`);
                }
            } else {
                logger.info(`ℹ️ Serviço "${servicoFinal}" não é benefício mapeado, não definindo responsável`);
            }

            // Verificar se é um benefício ou serviço não-benefício (só se servicoTag não for null)
            const ehBeneficio = servicoTag ? (
                servicoEstaMapeado(detalhes.servico || '') ||
                servicoTag.startsWith('BENEFICIO_') ||
                servicoTag.startsWith('APOSENTADORIA_') ||
                servicoTag.startsWith('PENSAO_') ||
                servicoTag.startsWith('SALARIO_') ||
                servicoTag.startsWith('AUXILIO_')
            ) : false;

            // Montar lista completa de tags
            // IMPORTANTE: Todos importados do atendimento devem ter tag ESCRITÓRIO
            const todasTags: string[] = [
                'CLIENTE_INSS',
                'ESCRITÓRIO', // SEMPRE adicionar para clientes importados do atendimento
                'TESTE_INTEGRACAO_COMPLETO', // Tag específica para testes de integração completa
                fase,
                statusNormalizado
            ];

            // Adicionar responsável apenas se não for OUTROS_PEDIDOS E não for deferido
            // Quando deferido, não adicionar responsável
            if (responsavel !== 'A DEFINIR' && !ehDeferido) {
                todasTags.push(responsavel);
            } else if (ehDeferido) {
                logger.info('ℹ️ Deferido: removendo responsável das tags');
            }

            // Adicionar tag de serviço apenas se existir
            if (servicoTag) {
                todasTags.push(servicoTag);
            }

            // Se não for um benefício E tiver serviço, adicionar tag OUTROS_PEDIDOS
            // Se não tiver serviço, também adicionar OUTROS_PEDIDOS
            if (!ehBeneficio && servicoTag) {
                todasTags.push('OUTROS_PEDIDOS');
                logger.info(`⚠️ Serviço não é um benefício, adicionando tag OUTROS_PEDIDOS`);
            } else if (!servicoTag) {
                // Se não conseguiu extrair serviço, adicionar OUTROS_PEDIDOS e não mostrar tag de serviço
                todasTags.push('OUTROS_PEDIDOS');
                logger.info(`⚠️ Serviço não informado, adicionando apenas tag OUTROS_PEDIDOS`);
            }

            // Adicionar tags específicas baseado no status
            if (ehExigencia) {
                // Para EXIGÊNCIA, sempre adicionar tag GERALDO para filtro
                todasTags.push('GERALDO');
                logger.info('🏷️ Adicionando tag GERALDO (exigência - responsável)');
            } else if (ehDeferido) {
                // Se deferido, usar tag específica baseada na fase
                if (fase === 'ADMINISTRATIVO') {
                    todasTags.push('DEFERIDO_ADMINISTRATIVO');
                    logger.info('🏷️ Adicionando tag DEFERIDO_ADMINISTRATIVO');
                } else if (fase === 'JUDICIAL') {
                    todasTags.push('DEFERIDO_JUDICIAL');
                    logger.info('🏷️ Adicionando tag DEFERIDO_JUDICIAL');
                } else {
                    // Fallback: usar DEFERIDO genérico se fase não identificada
                    todasTags.push('DEFERIDO');
                    logger.info('🏷️ Adicionando tag DEFERIDO (fase não identificada)');
                }
            } else if (ehIndeferido) {
                todasTags.push('INDEFERIDO');
                if (tipoIndeferimento === 'CULPA') {
                    todasTags.push('FAZER_NOVO_REQ_ADMINISTRATIVO');
                    logger.info('🏷️ Adicionando tag FAZER_NOVO_REQ_ADMINISTRATIVO (indeferimento por culpa)');
                } else if (tipoIndeferimento === 'MERITO') {
                    // Remover ADMINISTRATIVO se estiver presente (já foi ajustado acima)
                    const indexAdmin = todasTags.indexOf('ADMINISTRATIVO');
                    if (indexAdmin > -1) {
                        todasTags.splice(indexAdmin, 1);
                    }
                    // Adicionar JUDICIAL (já deve estar na fase, mas garantir)
                    if (!todasTags.includes('JUDICIAL')) {
                        todasTags.push('JUDICIAL');
                    }
                    logger.info('🏷️ Adicionando tag JUDICIAL (indeferimento por mérito)');
                }
            }

            logger.info(`Tags a aplicar: ${todasTags.join(', ')}`);

            // 🔥 CRÍTICO: Aplicar tags ANTES de qualquer outra operação
            // Garantir que ESCRITÓRIO e outras tags estejam aplicadas antes de criar nota/enviar WhatsApp
            logger.info('🏷️ Aplicando tags no Tramitação (OBRIGATÓRIO antes de continuar)...');
            const tagsAplicadas = await tramitacaoService.aplicarEtiquetas(idCliente, todasTags);

            if (!tagsAplicadas) {
                logger.error('❌ FALHA CRÍTICA: Não foi possível aplicar tags no Tramitação!');
                logger.error('❌ Não é possível continuar sem as tags (especialmente ESCRITÓRIO)');
                await puppeteerService.close();
                return;
            }

            logger.info(`✅ Tags aplicadas com sucesso: ${todasTags.join(', ')}`);

            // Verificar se tag ESCRITÓRIO foi aplicada (obrigatória)
            logger.info('🔍 Verificando se tag ESCRITÓRIO foi aplicada...');
            const tagsCliente = await tramitacaoService.obterTagsCliente(idCliente);
            const temEscritorio = tagsCliente.some(tag => tag.toUpperCase().includes('ESCRITÓRIO') || tag.toUpperCase().includes('ESCRITORIO'));

            if (!temEscritorio) {
                logger.error('❌ FALHA CRÍTICA: Tag ESCRITÓRIO não foi aplicada!');
                logger.error('❌ Não é possível enviar WhatsApp sem a tag ESCRITÓRIO');
                // Tentar aplicar novamente apenas ESCRITÓRIO
                await tramitacaoService.aplicarEtiquetas(idCliente, ['ESCRITÓRIO']);
                logger.info('🔄 Tentativa de aplicar tag ESCRITÓRIO novamente...');

                // Verificar novamente
                const tagsClienteNovo = await tramitacaoService.obterTagsCliente(idCliente);
                const temEscritorioNovo = tagsClienteNovo.some(tag => tag.toUpperCase().includes('ESCRITÓRIO') || tag.toUpperCase().includes('ESCRITORIO'));

                if (!temEscritorioNovo) {
                    logger.error('❌ FALHA CRÍTICA: Tag ESCRITÓRIO não pôde ser aplicada após retry!');
                    await puppeteerService.close();
                    return;
                }
            }

            logger.info(`✅ Tag ESCRITÓRIO confirmada! Tags atuais: ${tagsCliente.join(', ') || 'Nenhuma'}`);

            // Extrair cidade das tags (padrão do fluxo-completo-interativo)
            const cidade = tramitacaoService.extrairCidadeDasTags(tagsCliente) || 'GERALDO';
            logger.info(`📍 Cidade identificada: ${cidade}`);

            // Buscar parceiros WhatsApp
            logger.info('📞 Buscando parceiros para WhatsApp...');
            let parceiros: any[] = [];

            // SEMPRE usar número do escritório (7798868-2628) como padrão para clientes importados do atendimento
            // Isso garante que todas as atualizações sejam recebidas pelo escritório
            const telefoneEscritorio = '+557788682628';

            if (cidade === 'WPP ESCRITORIO' || cidade === 'GERALDO' || !cidade) {
                parceiros = [{
                    id: 0,
                    nome: 'Escritório',
                    telefone_whatsapp: telefoneEscritorio,
                    cidade: 'ESCRITÓRIO'
                }];
                logger.info(`📱 Usando número padrão do escritório: ${telefoneEscritorio}`);
            } else {
                // Buscar parceiros da cidade, mas sempre incluir escritório como fallback
                const result: any = await Database.query(`
                SELECT id, nome, telefone_whatsapp, cidade
                FROM parceiros
                WHERE UPPER(cidade) = UPPER($1) AND ativo = true
            `, [cidade]);
                parceiros = result.rows;

                // Se não encontrou parceiros específicos, usar escritório
                if (parceiros.length === 0) {
                    logger.info(`⚠️ Nenhum parceiro encontrado para ${cidade}, usando escritório como padrão`);
                    parceiros = [{
                        id: 0,
                        nome: 'Escritório',
                        telefone_whatsapp: telefoneEscritorio,
                        cidade: 'ESCRITÓRIO'
                    }];
                }
            }

            logger.info(`✅ ${parceiros.length} parceiro(s) encontrado(s)`);

            // 💾 Salvar processo no banco (tentar, mas não bloquear se falhar)
            logger.info('💾 Tentando salvar processo no banco de dados (não crítico)...');
            let processoId: string | null = null;

            // Executar em background (não bloquear) - mas capturar processoId se conseguir
            const salvarProcessoPromise = (async () => {
                try {
                    // Validar e garantir data válida
                    let dataSolicitacaoValida: Date;
                    if (detalhes.dataSolicitacao && detalhes.dataSolicitacao instanceof Date && !isNaN(detalhes.dataSolicitacao.getTime())) {
                        dataSolicitacaoValida = detalhes.dataSolicitacao;
                    } else {
                        dataSolicitacaoValida = new Date();
                        logger.warn(`⚠️ Data de solicitação inválida para protocolo ${protocolo}, usando data atual`);
                    }

                    // Mapear classe_final para valores permitidos no banco
                    // Valores permitidos: 'DEFERIDO', 'INDEFERIDO', 'DUPLICADO', 'CANCELADO', 'PENDENTE'
                    let classeFinalMapeada: string = analiseIA.classe_final || 'PENDENTE';
                    const classeFinalUpper = classeFinalMapeada.toUpperCase();
                    if (classeFinalUpper === 'EXIGENCIA' || classeFinalUpper === 'EXIGÊNCIA') {
                        classeFinalMapeada = 'PENDENTE';
                    } else if (!['DEFERIDO', 'INDEFERIDO', 'DUPLICADO', 'CANCELADO', 'PENDENTE'].includes(classeFinalMapeada)) {
                        classeFinalMapeada = 'PENDENTE';
                    }

                    // Mapear tipo_beneficio para valores permitidos no banco
                    // Valores permitidos: 'BPC', 'SALÁRIO MATERNIDADE', 'PENSÃO', 'APOSENTADORIAS', 'AUX DOENÇA'
                    let tipoBeneficioMapeado: string = detalhes.servico || 'APOSENTADORIAS';
                    const servicoLower = tipoBeneficioMapeado.toLowerCase();

                    // Mapear para valores válidos do banco
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
                        // Para serviços não-benefícios, usar APOSENTADORIAS como padrão
                        tipoBeneficioMapeado = 'APOSENTADORIAS';
                    }

                    // Mapear status_inss para valores permitidos no banco
                    // Valores permitidos: 'PENDENTE', 'EM_ANALISE', 'CUMPRIMENTO_DE_EXIGENCIA', 'CONCLUIDA', 'CANCELADA'
                    let statusInssMapeado = detalhes.statusAtual || 'CUMPRIMENTO_DE_EXIGENCIA';
                    const statusUpper = statusInssMapeado.toUpperCase();
                    if (!['PENDENTE', 'EM_ANALISE', 'CUMPRIMENTO_DE_EXIGENCIA', 'CONCLUIDA', 'CANCELADA'].includes(statusUpper)) {
                        // Mapear variações comuns
                        if (statusUpper.includes('EXIGENCIA') || statusUpper.includes('EXIGÊNCIA')) {
                            statusInssMapeado = 'CUMPRIMENTO_DE_EXIGENCIA';
                        } else if (statusUpper.includes('ANALISE') || statusUpper.includes('ANÁLISE')) {
                            statusInssMapeado = 'EM_ANALISE';
                        } else if (statusUpper.includes('CONCLUIDO') || statusUpper.includes('CONCLUÍDO')) {
                            statusInssMapeado = 'CONCLUIDA';
                        } else {
                            statusInssMapeado = 'PENDENTE'; // Fallback
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
                        detalhes.cpf.replace(/\D/g, ''), // Remover formatação do CPF
                        detalhes.nome,
                        tipoBeneficioMapeado, // Usar valor mapeado para valores válidos do banco
                        dataSolicitacaoValida,
                        statusInssMapeado,
                        classeFinalMapeada,
                        analiseIA.motivo_ia || '',
                        idCliente
                    ]);

                    // Database.query retorna array diretamente (result.rows)
                    if (Array.isArray(resultProcesso) && resultProcesso.length > 0) {
                        processoId = resultProcesso[0].id;
                        logger.info(`✅ Processo salvo no banco (ID: ${processoId})`);
                    } else {
                        logger.warn(`⚠️ Nenhum ID retornado ao inserir processo (não crítico)`);
                    }
                } catch (error: any) {
                    logger.warn(`⚠️ Erro ao salvar processo no banco (não crítico, continuando): ${error.message}`);
                }
            })();

            // Aguardar um pouco para ver se consegue salvar (mas não bloquear muito)
            await Promise.race([
                salvarProcessoPromise,
                new Promise(resolve => setTimeout(resolve, 2000)) // Timeout de 2s
            ]);

            logger.info('📧 Gerando email exclusivo via Tramitação (scraping)...');
            let emailExclusivo: string | null = null;

            try {
                // 🔥 SEMPRE fazer scraping (não verificar banco durante testes)
                // Quando tivermos API, podemos verificar pelo ID do cliente no Tramitação
                logger.info('🔍 Gerando email via TramitacaoSyncService (scraping)...');
                try {
                    // Usar ID do cliente diretamente (formato: /clientes/{id}-{nome-slug}/emails)
                    logger.info(`📧 Usando ID do cliente: ${idCliente}`);

                    const resultadoSync = await tramitacaoSyncService.gerarEmailExclusivo(
                        idCliente,
                        detalhes.nome
                    );

                    if (resultadoSync.success && resultadoSync.data?.email) {
                        emailExclusivo = resultadoSync.data.email;
                        logger.info(`✅ Email gerado via TramitacaoSyncService: ${emailExclusivo}`);

                        // Tentar salvar email no banco (não bloquear se falhar)
                        if (processoId) {
                            Database.query(`
                            UPDATE processos 
                            SET email_exclusivo_tramitacao = $1
                            WHERE id = $2
                        `, [emailExclusivo, processoId]).catch((err) => {
                                logger.warn(`⚠️ Erro ao salvar email no processo (não crítico): ${err}`);
                            });
                        }
                    } else {
                        logger.warn(`⚠️ TramitacaoSyncService não conseguiu gerar email: ${resultadoSync.error || 'Erro desconhecido'}`);
                        // Fallback: tentar PuppeteerService diretamente
                        logger.info('🔄 Tentando fallback via PuppeteerService...');
                        emailExclusivo = await puppeteerService.obterEmailExclusivo(idCliente);
                        if (emailExclusivo) {
                            logger.info(`✅ Email gerado via PuppeteerService: ${emailExclusivo}`);
                            // Tentar salvar email no banco (não bloquear se falhar)
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
                    logger.error(`❌ Erro ao usar TramitacaoSyncService: ${error.message}`);
                    logger.error(`Stack: ${error.stack}`);
                    // Fallback: tentar PuppeteerService diretamente
                    logger.info('🔄 Tentando fallback via PuppeteerService...');
                    try {
                        emailExclusivo = await puppeteerService.obterEmailExclusivo(idCliente);
                        if (emailExclusivo) {
                            logger.info(`✅ Email gerado via PuppeteerService: ${emailExclusivo}`);
                            // Tentar salvar email no banco (não bloquear se falhar)
                            if (processoId) {
                                Database.query(`
                                UPDATE processos 
                                SET email_exclusivo_tramitacao = $1
                                WHERE id = $2
                            `, [emailExclusivo, processoId]).catch(() => { });
                            }
                        }
                    } catch (fallbackError: any) {
                        logger.error(`❌ Fallback também falhou: ${fallbackError.message}`);
                    }
                }
            } catch (error) {
                logger.error(`❌ Erro ao obter email: ${error}`);
            }

            // Formatar DER (data de solicitação)
            const derFormatado = detalhes.dataSolicitacao && !isNaN(detalhes.dataSolicitacao.getTime())
                ? detalhes.dataSolicitacao.toLocaleDateString('pt-BR')
                : 'Não informado';

            // Calcular dias restantes até o prazo (prazoFinal já foi calculado acima)
            const hojeCalculo = new Date();
            const diasRestantes = Math.ceil((prazoFinal.getTime() - hojeCalculo.getTime()) / (1000 * 60 * 60 * 24));

            // Função para mascarar CPF (072.xxx.xx1-83)
            const mascararCpf = (cpf: string): string => {
                const cpfLimpo = cpf.replace(/\D/g, '');
                if (cpfLimpo.length !== 11) return cpf;
                // Formato: 072.xxx.xx1-83 (primeiros 3, mascarar 5 do meio, penúltimo dígito, últimos 2)
                return `${cpfLimpo.substring(0, 3)}.xxx.xx${cpfLimpo.substring(8, 9)}-${cpfLimpo.substring(9, 11)}`;
            };

            // Formatar CPF mascarado
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
                    if (ehMenor) {
                        logger.info(`👶 Requerente é menor de idade (${idade} anos)`);
                    }
                } catch (error) {
                    logger.warn(`⚠️ Erro ao calcular idade: ${error}`);
                }
            }

            // Formar texto da exigência/motivo (usar versão resumida da IA, removendo "Cumprir exigência:" se presente)
            let textoExigencia = analiseIA.motivo_ia || ultimosComentarios[ultimosComentarios.length - 1]?.texto || 'N/A';
            // Remover prefixo "Cumprir exigência:" se presente
            textoExigencia = textoExigencia.replace(/^Cumprir\s+exigência:\s*/i, '').trim();

            // Adicionar menção a representante legal se for menor
            if (ehMenor && (textoExigencia.includes('assin') || textoExigencia.includes('termo') || textoExigencia.includes('biometria'))) {
                textoExigencia = textoExigencia.replace(/(assinado|assinada|assinatura|termo|biometria)/gi, (match) => {
                    return match + ' pelo representante legal';
                });
            }

            // Link direto para o processo no PAT
            const linkProcesso = `https://atendimento.inss.gov.br/tarefas/detalhar_tarefa/${protocolo}`;

            logger.info(`📊 Status detectado: ${ehExigencia ? 'EXIGÊNCIA' : ehDeferido ? 'DEFERIDO' : ehIndeferido ? 'INDEFERIDO' : 'OUTRO'}`);

            // Array para coletar links de comprovantes dos agendamentos (declarado antes de usar)
            const comprovantesAgendamentos: Array<{ tipo: string; data: string; hora?: string; unidade?: string; endereco?: string; url: string }> = [];

            // 🧪 TESTE TEMPORÁRIO: Processar perícia médica para protocolos de teste
            // TODO: Remover após validação - este bloco processa agendamentos mesmo que não sejam detectados como precisando perícia
            if (protocolo === '593664108' || protocolo === '966962310' || protocolo === '1750383164') {
                try {
                    const page = puppeteerService.getPage();
                    if (page) {
                        logger.info(`🧪 [TESTE] Processando perícia médica para protocolo ${protocolo}...`);

                        // Criar agendamento simulado baseado em dados reais
                        const agendamentoTeste = {
                            id: protocolo === '593664108' ? '593664108' : protocolo,
                            tipo: 'PERICIA' as const,
                            data: new Date('2026-03-13'),
                            hora: '13:50',
                            unidade: 'AGÊNCIA DA PREVIDÊNCIA SOCIAL VITÓRIA DA CONQUISTA',
                            endereco: undefined,
                            status: 'AGENDADO' as const,
                            etapa: 'Aguardando comparecimento',
                            protocolo: protocolo,
                            cpf: detalhes.cpf.replace(/\D/g, '')
                        };

                        // Extrair detalhes completos (incluindo download do PDF e upload para Backblaze)
                        const detalhesAgendamentoTeste = await agendamentosService.extrairDetalhesAgendamento(page, agendamentoTeste);

                        if (detalhesAgendamentoTeste && detalhesAgendamentoTeste.urlComprovante) {
                            logger.info(`🧪 [TESTE] ✅ PDF baixado e enviado para Backblaze: ${detalhesAgendamentoTeste.urlComprovante}`);

                            // Cadastrar atividade no Tramitação (como no fluxo normal)
                            const atividadeCriada = await tramitacaoSyncService.cadastrarAtividade(
                                parseInt(idCliente),
                                {
                                    tipo: 'PERICIA',
                                    data: detalhesAgendamentoTeste.data,
                                    hora: detalhesAgendamentoTeste.hora,
                                    unidade: detalhesAgendamentoTeste.unidade,
                                    endereco: detalhesAgendamentoTeste.endereco,
                                    servico: detalhesAgendamentoTeste.servico,
                                    urlComprovante: detalhesAgendamentoTeste.urlComprovante
                                }
                            );

                            if (atividadeCriada) {
                                logger.info('🧪 [TESTE] ✅ Atividade de PERÍCIA MÉDICA cadastrada no Tramitação');

                                // Aplicar tag
                                await tramitacaoService.aplicarEtiquetas(idCliente, ['PERICIA_AGENDADA']);

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
                                            detalhesAgendamentoTeste.data,
                                            detalhesAgendamentoTeste.hora,
                                            detalhesAgendamentoTeste.unidade,
                                            detalhesAgendamentoTeste.endereco || null,
                                            'AGENDADO',
                                            detalhesAgendamentoTeste.servico || null,
                                            detalhesAgendamentoTeste.urlComprovante || null
                                        ]);
                                        logger.info('🧪 [TESTE] ✅ Agendamento salvo no banco');
                                    } catch (error: any) {
                                        logger.warn(`🧪 [TESTE] ⚠️ Erro ao salvar agendamento no banco: ${error.message}`);
                                    }
                                }

                                // Criar nota SEPARADA para a perícia médica
                                const dataFormatada = detalhesAgendamentoTeste.data.toLocaleDateString('pt-BR');
                                const conteudoNotaPericia = `📅 *PERÍCIA MÉDICA AGENDADA* 📅

*Protocolo*: ${protocolo}
*Cliente*: ${detalhes.nome || 'Não informado'}
*CPF*: ${cpfMascarado}

*Data*: ${dataFormatada}${detalhesAgendamentoTeste.hora ? ` às ${detalhesAgendamentoTeste.hora}` : ''}
${detalhesAgendamentoTeste.unidade ? `*Unidade*: ${detalhesAgendamentoTeste.unidade}\n` : ''}${detalhesAgendamentoTeste.endereco ? `*Endereço*: ${detalhesAgendamentoTeste.endereco}\n` : ''}${detalhesAgendamentoTeste.servico ? `*Serviço*: ${detalhesAgendamentoTeste.servico}\n` : ''}
*📄 Comprovante*:
${detalhesAgendamentoTeste.urlComprovante}

*🔗 Acesse o processo diretamente*:
https://atendimento.inss.gov.br/tarefas/detalhar_tarefa/${protocolo}

---
📅 Extraído automaticamente do PAT via IA em: ${new Date().toLocaleString('pt-BR')}`;

                                await tramitacaoService.criarNota(idCliente, {
                                    titulo: `📅 PERÍCIA MÉDICA Agendada - ${dataFormatada}`,
                                    texto: conteudoNotaPericia,
                                    tipo: 'INFORMACAO'
                                });

                                logger.info('🧪 [TESTE] ✅ Nota de perícia médica criada separadamente');

                                // Adicionar aos comprovantes para WhatsApp (mas não na nota de exigência)
                                comprovantesAgendamentos.push({
                                    tipo: 'PERÍCIA MÉDICA',
                                    data: dataFormatada,
                                    hora: detalhesAgendamentoTeste.hora || '',
                                    unidade: detalhesAgendamentoTeste.unidade || '',
                                    endereco: detalhesAgendamentoTeste.endereco || '',
                                    url: detalhesAgendamentoTeste.urlComprovante || ''
                                });
                            } else {
                                logger.warn(`🧪 [TESTE] ⚠️ Não foi possível criar atividade no Tramitação`);
                            }
                        } else {
                            logger.warn(`🧪 [TESTE] ⚠️ Não foi possível baixar PDF para teste`);
                        }
                    }
                } catch (error: any) {
                    logger.error(`🧪 [TESTE] ❌ Erro ao processar teste: ${error.message}`);
                }
            }

            // 🔥 CRÍTICO: Criar nota ANTES de enviar WhatsApp
            logger.info('📝 Criando nota no Tramitação com dados da IA...');

            let tituloNota = '';
            let conteudoNota = '';
            let tipoNota: 'INFORMACAO' | 'ALERTA' | 'URGENTE' = 'ALERTA';

            if (ehExigencia) {
                // NOTA DE EXIGÊNCIA (formato padronizado)
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

                // Links de comprovantes serão adicionados após processar agendamentos
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
                    // NOTA DE INDEFERIMENTO POR CULPA (Nova Entrada Administrativa)
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
                    // NOTA DE INDEFERIMENTO POR MÉRITO (Judicial)
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

            // NÃO adicionar comprovantes na nota de exigência - serão criadas notas separadas
            // Criar nota de EXIGÊNCIA (sem comprovantes)
            const notaCriada = await tramitacaoService.criarNota(idCliente, {
                titulo: tituloNota,
                texto: conteudoNota,
                tipo: tipoNota,
            });

            if (!notaCriada) {
                logger.error('❌ FALHA CRÍTICA: Não foi possível criar nota no Tramitação!');
                logger.error('❌ Não é possível enviar WhatsApp sem a nota criada');
                await puppeteerService.close();
                return;
            }

            logger.info(`✅ Nota criada com sucesso (ID: ${notaCriada})`);

            // ========== PROCESSAR AGENDAMENTOS (PERÍCIAS E AVALIAÇÕES) ==========
            logger.info('🔍 Verificando agendamentos de perícia/avaliação...');

            try {
                const page = puppeteerService.getPage();
                if (page) {
                    // Verificar se precisa de perícia/avaliação baseado no tipo de benefício
                    const { precisaPericia, precisaAvaliacao } = agendamentosService.precisaPericiaOuAvaliacao(detalhes.servico || '');

                    // Flag para evitar processar perícia real se já processamos o teste
                    const testePericiaSimulada = comprovantesAgendamentos.some(c => c.tipo.includes('TESTE'));

                    if (precisaPericia || precisaAvaliacao) {
                        logger.info(`📅 Benefício requer ${precisaPericia ? 'PERÍCIA' : ''} ${precisaAvaliacao ? 'AVALIAÇÃO SOCIAL' : ''}`);

                        // Verificar botões "Agendar"
                        const tiposParaAgendar = await agendamentosService.verificarBotoesAgendar(page);

                        if (tiposParaAgendar.length > 0) {
                            logger.info(`⚠️ Botões "Agendar" encontrados: ${tiposParaAgendar.join(', ')}`);

                            // Adicionar tags AGENDAR_PERICIA ou AGENDAR_AVALIACAO
                            const tagsAgendar: string[] = [];
                            if (tiposParaAgendar.includes('PERICIA')) {
                                tagsAgendar.push('AGENDAR_PERICIA');
                            }
                            if (tiposParaAgendar.includes('AVALIACAO_SOCIAL')) {
                                tagsAgendar.push('AGENDAR_AVALIACAO');
                            }

                            if (tagsAgendar.length > 0) {
                                await tramitacaoService.aplicarEtiquetas(idCliente, tagsAgendar);
                                logger.info(`🏷️ Tags aplicadas: ${tagsAgendar.join(', ')}`);

                                // Enviar WhatsApp para Geraldo avisando que precisa agendar
                                const mensagemAgendar = `⚠️ *AGENDAMENTO NECESSÁRIO* ⚠️%0A%0A` +
                                    `*Protocolo*: ${protocolo}%0A` +
                                    `*Cliente*: ${detalhes.nome || 'Não informado'}%0A` +
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
                                    logger.info('✅ WhatsApp enviado para Geraldo sobre necessidade de agendamento');
                                } catch (error: any) {
                                    logger.warn(`⚠️ Erro ao enviar WhatsApp para Geraldo: ${error.message}`);
                                }
                            }
                        }

                        // Extrair agendamentos existentes
                        const agendamentosProcessados: any[] = [];

                        if (precisaAvaliacao) {
                            try {
                                const avaliacoes = await agendamentosService.extrairAvaliacoesSociais(page, protocolo, detalhes.cpf);
                                const agendadas = agendamentosService.filtrarAgendados(avaliacoes);

                                for (const agendamento of agendadas) {
                                    logger.info(`📅 Avaliação Social agendada: ${agendamento.data.toLocaleDateString('pt-BR')} às ${agendamento.hora}`);

                                    // Extrair detalhes completos
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

                                        // Cadastrar atividade no Tramitação
                                        const atividadeCriada = await tramitacaoSyncService.cadastrarAtividade(
                                            parseInt(idCliente),
                                            {
                                                tipo: 'AVALIACAO_SOCIAL',
                                                data: detalhesAgendamento.data,
                                                hora: detalhesAgendamento.hora,
                                                unidade: detalhesAgendamento.unidade,
                                                endereco: detalhesAgendamento.endereco,
                                                servico: detalhesAgendamento.servico,
                                                urlComprovante: detalhesAgendamento.urlComprovante
                                            }
                                        );

                                        if (atividadeCriada) {
                                            logger.info('✅ Atividade de AVALIAÇÃO SOCIAL cadastrada no Tramitação');

                                            // Aplicar tag
                                            await tramitacaoService.aplicarEtiquetas(idCliente, ['AVALIACAO_AGENDADA']);

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
                                                    logger.info('✅ Agendamento salvo no banco');
                                                } catch (error: any) {
                                                    logger.warn(`⚠️ Erro ao salvar agendamento no banco: ${error.message}`);
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

                                            await tramitacaoService.criarNota(idCliente, {
                                                titulo: `📅 AVALIAÇÃO SOCIAL Agendada - ${dataFormatadaAvaliacao}`,
                                                texto: conteudoNotaAvaliacao,
                                                tipo: 'INFORMACAO'
                                            });

                                            logger.info('✅ Nota de avaliação social criada separadamente');

                                            // Enviar notificação WhatsApp para escritório (não tem parceiro ainda)
                                            await enviarNotificacaoAgendamento(
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
                                                processoId
                                            );
                                        }

                                        agendamentosProcessados.push(detalhesAgendamento);
                                    }
                                }
                            } catch (error: any) {
                                logger.warn(`⚠️ Erro ao extrair avaliações sociais: ${error.message}`);
                            }
                        }

                        if (precisaPericia && !testePericiaSimulada) {
                            try {
                                const pericias = await agendamentosService.extrairPericiasMedicas(page, protocolo, detalhes.cpf);
                                const agendadas = agendamentosService.filtrarAgendados(pericias);

                                for (const agendamento of agendadas) {
                                    logger.info(`📅 Perícia Médica agendada: ${agendamento.data.toLocaleDateString('pt-BR')} às ${agendamento.hora}`);

                                    // Extrair detalhes completos
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

                                        // Cadastrar atividade no Tramitação
                                        const atividadeCriada = await tramitacaoSyncService.cadastrarAtividade(
                                            parseInt(idCliente),
                                            {
                                                tipo: 'PERICIA',
                                                data: detalhesAgendamento.data,
                                                hora: detalhesAgendamento.hora,
                                                unidade: detalhesAgendamento.unidade,
                                                endereco: detalhesAgendamento.endereco,
                                                servico: detalhesAgendamento.servico,
                                                urlComprovante: detalhesAgendamento.urlComprovante
                                            }
                                        );

                                        if (atividadeCriada) {
                                            logger.info('✅ Atividade de PERÍCIA MÉDICA cadastrada no Tramitação');

                                            // Aplicar tag
                                            await tramitacaoService.aplicarEtiquetas(idCliente, ['PERICIA_AGENDADA']);

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
                                                    logger.info('✅ Agendamento salvo no banco');
                                                } catch (error: any) {
                                                    logger.warn(`⚠️ Erro ao salvar agendamento no banco: ${error.message}`);
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

                                            await tramitacaoService.criarNota(idCliente, {
                                                titulo: `📅 PERÍCIA MÉDICA Agendada - ${dataFormatadaPericia}`,
                                                texto: conteudoNotaPericia,
                                                tipo: 'INFORMACAO'
                                            });

                                            logger.info('✅ Nota de perícia médica criada separadamente');

                                            // Enviar notificação WhatsApp para escritório (não tem parceiro ainda)
                                            await enviarNotificacaoAgendamento(
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
                                                processoId
                                            );
                                        }

                                        agendamentosProcessados.push(detalhesAgendamento);
                                    }
                                }
                            } catch (error: any) {
                                logger.warn(`⚠️ Erro ao extrair perícias médicas: ${error.message}`);
                            }
                        }

                        if (agendamentosProcessados.length > 0) {
                            logger.info(`✅ ${agendamentosProcessados.length} agendamento(s) processado(s)`);
                        } else {
                            logger.info('ℹ️ Nenhum agendamento AGENDADO encontrado');
                        }
                    } else {
                        logger.info('ℹ️ Benefício não requer perícia ou avaliação social');
                    }
                } else {
                    logger.warn('⚠️ Page não disponível para extrair agendamentos');
                }
            } catch (error: any) {
                logger.error(`❌ Erro ao processar agendamentos: ${error.message}`);
                // Não bloquear o fluxo principal se houver erro
            }

            // Preparar mensagens WhatsApp e destinatários baseado no tipo
            let destinatarios: Array<{ telefone: string; mensagem: string; apiKey?: string; nome: string }> = [];

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

                logger.info('📱 Preparando mensagem de EXIGÊNCIA para escritório...');
                for (const parceiro of parceiros) {
                    destinatarios.push({
                        telefone: parceiro.telefone_whatsapp,
                        mensagem: mensagemWhatsApp,
                        nome: parceiro.nome,
                        apiKey: '5547794' // API key específica para escritório (557788682628)
                    });
                }
            } else if (ehDeferido) {
                // DEFERIDO: enviar para número específico de deferimento
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

                logger.info('📱 Preparando mensagem de DEFERIDO...');
                destinatarios.push({
                    telefone: '557788484798',
                    mensagem: mensagemDeferido,
                    nome: 'Deferimento',
                    apiKey: '7339533'
                });
            } else if (ehIndeferido) {
                if (tipoIndeferimento === 'CULPA') {
                    // INDEFERIDO POR CULPA: Nova entrada administrativa
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

                    logger.info('📱 Preparando mensagem de INDEFERIDO (por culpa - nova entrada)...');
                    destinatarios.push({
                        telefone: '557799271876',
                        mensagem: mensagemIndeferidoCulpa,
                        nome: 'Indeferimento',
                        apiKey: '6708443'
                    });
                } else {
                    // INDEFERIDO POR MÉRITO: Judicial
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

                    logger.info('📱 Preparando mensagem de INDEFERIDO (por mérito - judicial)...');
                    destinatarios.push({
                        telefone: '557799271876',
                        mensagem: mensagemIndeferidoMerito,
                        nome: 'Indeferimento',
                        apiKey: '6708443'
                    });
                }
            } else {
                logger.warn(`⚠️ Status não reconhecido: ${detalhes.statusAtual}. Não enviando WhatsApp.`);
            }

            // 🔥 VALIDAÇÃO CRÍTICA: Verificar se WhatsApp Service está configurado ANTES de continuar
            if (destinatarios.length === 0) {
                logger.warn('⚠️ Nenhum destinatário configurado para este tipo de status. Pulando envio de WhatsApp.');
            } else if (!whatsappService.isConfigured()) {
                logger.error('❌ WhatsApp Service não está configurado!');
                logger.error('   Inicialize o WhatsApp Service primeiro');
                await puppeteerService.close();
                return;
            }

            logger.info('✅ WhatsApp Service configurado e pronto para enviar');

            logger.info(`📤 Enviando WhatsApp para ${destinatarios.length} destinatário(s)...`);
            let totalEnviados = 0;
            let totalFalhas = 0;

            for (const destinatario of destinatarios) {
                try {
                    logger.info(`📱 Enviando para ${destinatario.nome} (${destinatario.telefone})...`);

                    // Enviar via WhatsApp Service
                    const enviado = await whatsappService.enviarComDelay(
                        destinatario.telefone,
                        destinatario.mensagem
                    );

                    if (enviado) {
                        logger.info(`✅ Mensagem enviada com sucesso para ${destinatario.nome}`);
                        totalEnviados++;

                        // Tentar salvar no banco (não bloquear se falhar)
                        if (processoId) {
                            Database.query(`
                            INSERT INTO notificacoes_whatsapp (
                                processo_id, parceiro_id, tipo, telefone_destino, cidade, mensagem, enviada, data_envio
                            ) VALUES ($1, $2, $3, $4, $5, $6, true, NOW())
                        `, [
                                processoId,
                                destinatario.nome === 'Escritório' ? null : null, // Sempre null para escritório (não existe parceiro_id = 0)
                                ehExigencia ? 'EXIGENCIA_DETECTADA' : ehDeferido ? 'RESULTADO_DEFERIDO' : 'RESULTADO_INDEFERIDO',
                                destinatario.telefone,
                                'ESCRITORIO',
                                destinatario.mensagem
                            ]).catch((err) => {
                                logger.warn(`⚠️ Erro ao salvar notificação no banco (não crítico): ${err.message}`);
                            });
                        }
                    } else {
                        logger.error(`❌ Falha ao enviar mensagem para ${destinatario.nome}`);
                        totalFalhas++;

                        // Tentar salvar no banco como falha (não bloquear se falhar)
                        if (processoId) {
                            Database.query(`
                            INSERT INTO notificacoes_whatsapp (
                                processo_id, parceiro_id, tipo, telefone_destino, cidade, mensagem, enviada
                            ) VALUES ($1, $2, $3, $4, $5, $6, false)
                        `, [
                                processoId,
                                destinatario.nome === 'Escritório' ? null : null, // Sempre null para escritório (não existe parceiro_id = 0)
                                ehExigencia ? 'EXIGENCIA_DETECTADA' : ehDeferido ? 'RESULTADO_DEFERIDO' : 'RESULTADO_INDEFERIDO',
                                destinatario.telefone,
                                'ESCRITORIO',
                                destinatario.mensagem
                            ]).catch((err) => {
                                logger.warn(`⚠️ Erro ao salvar notificação no banco (não crítico): ${err.message}`);
                            });
                        }
                    }
                } catch (error: any) {
                    logger.error(`❌ Erro ao processar notificação para ${destinatario.nome}: ${error.message}`);
                    totalFalhas++;
                }
            }

            logger.info(`📊 Resumo protocolo ${protocolo}: ${totalEnviados} enviado(s), ${totalFalhas} falha(s)`);

            // Aguardar um pouco antes de processar o próximo protocolo
            if (idx < protocolos.length - 1) {
                logger.info('⏳ Aguardando 3 segundos antes de processar próximo protocolo...');
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }

        await puppeteerService.close();

        logger.info('========== TESTE CONCLUÍDO ==========');

    } catch (error) {
        logger.error('ERRO:', error);
        await puppeteerService.close();
    }
}

testarFluxoCompleto()
    .then(() => {
        logger.info('Script finalizado');
        process.exit(0);
    })
    .catch((error) => {
        logger.error('Erro fatal:', error);
        process.exit(1);
    });
