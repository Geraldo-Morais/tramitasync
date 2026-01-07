/**
 * Serviço unificado para gerenciar lembretes de exigências e agendamentos
 * - Exigências: lembretes 7 dias antes do prazo
 * - Agendamentos: lembretes 30 e 7 dias antes da data
 */

import Database from '../database';
import logger from '../utils/logger';
import TramitacaoService from './TramitacaoService';
import ParceirosService from './ParceirosService';
import whatsappService from './WhatsAppService';
import AgendamentosService from './AgendamentosService';
import PuppeteerService from './PuppeteerService';
import { format, addDays, differenceInDays } from 'date-fns';
import { ptBR } from 'date-fns/locale';

interface ExigenciaParaLembrete {
    id: string;
    processo_id: string;
    protocolo_inss: string;
    nome_segurado: string;
    cpf_segurado: string;
    prazo: Date;
    resumo_exigencia: string;
    documentos_exigidos: string[];
    tramitacao_cliente_id: number | null;
    email_unico: string | null;
}

interface AgendamentoParaLembrete {
    id: string;
    processo_id: string;
    protocolo_inss: string;
    nome_segurado: string;
    cpf_segurado: string;
    tipo: 'PERICIA' | 'AVALIACAO_SOCIAL';
    data_agendamento: Date;
    hora_agendamento: string;
    unidade: string;
    url_comprovante?: string | null;
    tramitacao_cliente_id: number | null;
}

class LembretesService {

    /**
     * Verifica se uma exigência foi cumprida verificando:
     * 1. Se data_cumprimento está preenchida
     * 2. Se a tag EXIGENCIA foi removida do Tramitação
     * 3. Se o status mudou para EM_ANALISE ou CONCLUIDA
     */
    private async verificarSeExigenciaFoiCumprida(
        exigencia: ExigenciaParaLembrete
    ): Promise<boolean> {
        try {
            // 1. Verificar se data_cumprimento está preenchida
            const result: any = await Database.query(`
                SELECT data_cumprimento, status
                FROM exigencias
                WHERE id = $1
            `, [exigencia.id]);

            if (result && result.length > 0) {
                const exigenciaDb = result[0];

                // Se tem data_cumprimento, foi cumprida
                if (exigenciaDb.data_cumprimento) {
                    logger.info(`[LembretesService] Exigência ${exigencia.id} já foi cumprida (data: ${exigenciaDb.data_cumprimento})`);
                    return true;
                }

                // Se status não é mais PENDENTE, foi cumprida
                if (exigenciaDb.status !== 'PENDENTE') {
                    logger.info(`[LembretesService] Exigência ${exigencia.id} não está mais pendente (status: ${exigenciaDb.status})`);
                    return true;
                }
            }

            // 2. Verificar tags no Tramitação (se cliente existe)
            if (exigencia.tramitacao_cliente_id) {
                try {
                    const tagsCliente = await TramitacaoService.obterTagsCliente(
                        exigencia.tramitacao_cliente_id
                    );

                    // Se não tem mais tag EXIGENCIA, provavelmente foi cumprida
                    const temExigencia = tagsCliente.some(tag =>
                        tag.toUpperCase().includes('EXIGENCIA') ||
                        tag.toUpperCase().includes('EXIGÊNCIA')
                    );

                    if (!temExigencia) {
                        logger.info(`[LembretesService] Exigência ${exigencia.id} - tag EXIGENCIA removida do Tramitação`);
                        return true;
                    }

                    // Se tem tag EM_ANALISE ou CONCLUIDA, foi cumprida
                    const temStatusFinal = tagsCliente.some(tag => {
                        const tagUpper = tag.toUpperCase();
                        return tagUpper.includes('EM_ANALISE') ||
                            tagUpper.includes('EM_ANÁLISE') ||
                            tagUpper.includes('CONCLUIDA') ||
                            tagUpper.includes('CONCLUÍDA');
                    });

                    if (temStatusFinal) {
                        logger.info(`[LembretesService] Exigência ${exigencia.id} - status final detectado no Tramitação`);
                        return true;
                    }
                } catch (error: any) {
                    logger.warn(`[LembretesService] Erro ao verificar tags do Tramitação: ${error.message}`);
                    // Continuar com outras verificações
                }
            }

            // 3. Verificar status do processo
            const processoResult: any = await Database.query(`
                SELECT status_inss
                FROM processos
                WHERE id = $1
            `, [exigencia.processo_id]);

            if (processoResult && processoResult.length > 0) {
                const statusInss = processoResult[0].status_inss;

                // Se não está mais em CUMPRIMENTO_DE_EXIGENCIA, foi cumprida
                if (statusInss !== 'CUMPRIMENTO_DE_EXIGENCIA') {
                    logger.info(`[LembretesService] Exigência ${exigencia.id} - processo não está mais em exigência (status: ${statusInss})`);
                    return true;
                }
            }

            // Se chegou aqui, não foi cumprida
            return false;
        } catch (error: any) {
            logger.error(`[LembretesService] Erro ao verificar se exigência foi cumprida: ${error.message}`);
            // Em caso de erro, assumir que não foi cumprida (mais seguro enviar lembrete)
            return false;
        }
    }

    /**
     * Busca exigências que precisam de lembrete (7 dias antes do prazo)
     */
    async buscarExigenciasParaLembrete(): Promise<ExigenciaParaLembrete[]> {
        try {
            const hoje = new Date();
            const seteDiasDepois = addDays(hoje, 7);

            // Buscar exigências pendentes com prazo entre hoje e 7 dias
            const result: any = await Database.query(`
                SELECT 
                    e.id,
                    e.processo_id,
                    e.prazo,
                    e.resumo_exigencia,
                    e.documentos_exigidos,
                    e.ultimo_lembrete_enviado,
                    p.protocolo_inss,
                    p.nome_segurado,
                    p.cpf_segurado,
                    p.tramitacao_cliente_id,
                    p.email_unico
                FROM exigencias e
                INNER JOIN processos p ON p.id = e.processo_id
                WHERE e.status = 'PENDENTE'
                  AND e.data_cumprimento IS NULL
                  AND e.prazo >= $1
                  AND e.prazo <= $2
                  AND (e.ultimo_lembrete_enviado IS NULL 
                       OR e.ultimo_lembrete_enviado < $1)
            `, [hoje, seteDiasDepois]);

            if (!result || result.length === 0) {
                logger.info('[LembretesService] Nenhuma exigência encontrada para lembrete');
                return [];
            }

            logger.info(`[LembretesService] Encontradas ${result.length} exigência(s) para lembrete`);

            // Converter documentos_exigidos de JSON para array
            const exigencias: ExigenciaParaLembrete[] = result.map((row: any) => ({
                id: row.id,
                processo_id: row.processo_id,
                protocolo_inss: row.protocolo_inss,
                nome_segurado: row.nome_segurado,
                cpf_segurado: row.cpf_segurado,
                prazo: new Date(row.prazo),
                resumo_exigencia: row.resumo_exigencia || '',
                documentos_exigidos: Array.isArray(row.documentos_exigidos)
                    ? row.documentos_exigidos
                    : (row.documentos_exigidos ? JSON.parse(row.documentos_exigidos) : []),
                tramitacao_cliente_id: row.tramitacao_cliente_id,
                email_unico: row.email_unico
            }));

            return exigencias;
        } catch (error: any) {
            logger.error(`[LembretesService] Erro ao buscar exigências para lembrete: ${error.message}`);
            return [];
        }
    }

    /**
     * Envia lembrete para uma exigência específica
     */
    async enviarLembrete(exigencia: ExigenciaParaLembrete): Promise<boolean> {
        try {
            // Verificar se foi cumprida antes de enviar
            const foiCumprida = await this.verificarSeExigenciaFoiCumprida(exigencia);

            if (foiCumprida) {
                logger.info(`[LembretesService] ⏭️ Exigência ${exigencia.id} já foi cumprida, pulando lembrete`);

                // Atualizar ultimo_lembrete_enviado para evitar novas tentativas
                await Database.query(`
                    UPDATE exigencias
                    SET ultimo_lembrete_enviado = NOW()
                    WHERE id = $1
                `, [exigencia.id]);

                return false;
            }

            // Buscar tags do cliente no Tramitação para identificar parceiro
            let tagsCliente: string[] = [];
            if (exigencia.tramitacao_cliente_id) {
                try {
                    tagsCliente = await TramitacaoService.obterTagsCliente(
                        exigencia.tramitacao_cliente_id
                    );
                } catch (error: any) {
                    logger.warn(`[LembretesService] Erro ao buscar tags do cliente: ${error.message}`);
                }
            }

            // Identificar parceiro
            const parceiroIdentificado = await ParceirosService.identificarParceiroPorTags(tagsCliente);

            // Obter destinatários
            const destinatarios = ParceirosService.obterDestinatariosWhatsApp(parceiroIdentificado);

            // Calcular dias restantes
            const diasRestantes = differenceInDays(exigencia.prazo, new Date());

            // Formatar documentos exigidos
            const documentosTexto = exigencia.documentos_exigidos && exigencia.documentos_exigidos.length > 0
                ? exigencia.documentos_exigidos.map((doc, idx) => `> *${idx + 1}. ${doc}*`).join('%0A')
                : 'Não especificados';

            // Montar mensagem de lembrete
            const mensagemLembrete = `⏰ *LEMBRETE: EXIGÊNCIA PRÓXIMA DO PRAZO* ⏰%0A%0A` +
                `*Protocolo*: ${exigencia.protocolo_inss}%0A` +
                `*Cliente*: ${exigencia.nome_segurado}%0A` +
                // Mascarar CPF para WhatsApp (padrão: 000.XXX.X0X-00)
                `*CPF*: ${(() => {
                    const cpfLimpo = exigencia.cpf_segurado.replace(/\D/g, '');
                    if (cpfLimpo.length !== 11) return exigencia.cpf_segurado;
                    return `${cpfLimpo.substring(0, 3)}.XXX.X${cpfLimpo.substring(8, 9)}X-${cpfLimpo.substring(9, 11)}`;
                })()}%0A%0A` +
                `*⚠️ ATENÇÃO: Faltam apenas ${diasRestantes} dia(s) para o prazo!*%0A%0A` +
                `*Prazo limite*: ${format(exigencia.prazo, 'dd/MM/yyyy', { locale: ptBR })}%0A%0A` +
                `*Exigência*: ${exigencia.resumo_exigencia}%0A%0A` +
                `*Documentos exigidos*:%0A%0A${documentosTexto}%0A%0A`;

            const mensagemComEmail = exigencia.email_unico
                ? mensagemLembrete + `*ENVIE OS DOCUMENTOS PARA*:%0A%0A${exigencia.email_unico}%0A%0A` +
                `*✅ Após enviar, responda "ENVIADO" neste chat*`
                : mensagemLembrete + `*⚠️ Entre em contato com o escritório para enviar os documentos*`;

            // Enviar para cada destinatário
            let sucesso = false;
            for (const destinatario of destinatarios) {
                try {
                    const enviado = await whatsappService.enviar(
                        destinatario.telefone,
                        decodeURIComponent(mensagemComEmail)
                    );

                    if (enviado) {
                        sucesso = true;
                        logger.info(`[LembretesService] ✅ Lembrete enviado para ${destinatario.nome} (${destinatario.telefone})`);

                        // Registrar notificação no banco
                        await Database.query(`
                            INSERT INTO notificacoes_whatsapp (
                                processo_id, tipo, telefone_destino, cidade, mensagem, enviada, data_envio
                            ) VALUES ($1, $2, $3, $4, $5, true, NOW())
                        `, [
                            exigencia.processo_id,
                            'LEMBRETE_PRAZO',
                            destinatario.telefone,
                            destinatario.tipo === 'PARCEIRO' ? 'PARCEIRO' : 'ESCRITORIO',
                            decodeURIComponent(mensagemComEmail)
                        ]);
                    }
                } catch (error: any) {
                    logger.error(`[LembretesService] Erro ao enviar lembrete para ${destinatario.nome}: ${error.message}`);
                }
            }

            // Atualizar ultimo_lembrete_enviado
            if (sucesso) {
                await Database.query(`
                    UPDATE exigencias
                    SET ultimo_lembrete_enviado = NOW()
                    WHERE id = $1
                `, [exigencia.id]);
            }

            return sucesso;
        } catch (error: any) {
            logger.error(`[LembretesService] Erro ao enviar lembrete: ${error.message}`);
            return false;
        }
    }

    /**
     * Verifica se um agendamento ainda está válido no PAT (não foi cancelado/remarcado)
     */
    private async verificarAgendamentoValido(
        protocolo: string,
        cpf: string,
        tipo: 'PERICIA' | 'AVALIACAO_SOCIAL'
    ): Promise<boolean> {
        try {
            logger.info(`[LembretesService] Verificando agendamento ${tipo} para protocolo ${protocolo}`);

            const page = await PuppeteerService.getPage();
            if (!page) {
                logger.warn('[LembretesService] Page não disponível, assumindo válido');
                return true;
            }

            await page.goto(`https://atendimento.inss.gov.br/tarefas/detalhar_tarefa/${protocolo}`, {
                waitUntil: 'networkidle2'
            });
            await page.waitForTimeout(2000);

            let agendamentos;
            if (tipo === 'PERICIA') {
                agendamentos = await AgendamentosService.extrairPericiasMedicas(page, protocolo, cpf);
            } else {
                agendamentos = await AgendamentosService.extrairAvaliacoesSociais(page, protocolo, cpf);
            }

            const agendados = AgendamentosService.filtrarAgendados(agendamentos);

            if (agendados.length === 0) {
                logger.info(`[LembretesService] Agendamento ${tipo} não está mais AGENDADO`);
                return false;
            }

            return true;
        } catch (error: any) {
            logger.error(`[LembretesService] Erro ao verificar agendamento: ${error.message}`);
            return true; // Assumir válido em caso de erro
        }
    }

    /**
     * Busca agendamentos que precisam de lembrete (30 dias antes)
     */
    async buscarAgendamentosParaLembrete30d(): Promise<AgendamentoParaLembrete[]> {
        try {
            const hoje = new Date();
            const trintaDiasDepois = addDays(hoje, 30);

            const result: any = await Database.query(`
                SELECT 
                    a.id,
                    a.processo_id,
                    a.protocolo_inss,
                    p.nome_segurado,
                    a.cpf_segurado,
                    a.tipo,
                    a.data_agendamento,
                    a.hora_agendamento,
                    a.unidade,
                    a.url_comprovante,
                    p.tramitacao_cliente_id
                FROM agendamentos a
                INNER JOIN processos p ON p.id = a.processo_id
                WHERE a.status = 'AGENDADO'
                  AND a.data_agendamento >= $1
                  AND a.data_agendamento <= $2
                  AND (a.ultimo_lembrete_30d IS NULL 
                       OR a.ultimo_lembrete_30d < $1)
            `, [hoje, trintaDiasDepois]);

            if (!result || result.length === 0) {
                return [];
            }

            return result.map((row: any) => ({
                id: row.id,
                processo_id: row.processo_id,
                protocolo_inss: row.protocolo_inss,
                nome_segurado: row.nome_segurado,
                cpf_segurado: row.cpf_segurado,
                tipo: row.tipo,
                data_agendamento: new Date(row.data_agendamento),
                hora_agendamento: row.hora_agendamento,
                unidade: row.unidade,
                url_comprovante: row.url_comprovante,
                tramitacao_cliente_id: row.tramitacao_cliente_id
            }));
        } catch (error: any) {
            logger.error(`[LembretesService] Erro ao buscar agendamentos para lembrete 30d: ${error.message}`);
            return [];
        }
    }

    /**
     * Busca agendamentos que precisam de lembrete (7 dias antes)
     */
    async buscarAgendamentosParaLembrete7d(): Promise<AgendamentoParaLembrete[]> {
        try {
            const hoje = new Date();
            const seteDiasDepois = addDays(hoje, 7);

            const result: any = await Database.query(`
                SELECT 
                    a.id,
                    a.processo_id,
                    a.protocolo_inss,
                    p.nome_segurado,
                    a.cpf_segurado,
                    a.tipo,
                    a.data_agendamento,
                    a.hora_agendamento,
                    a.unidade,
                    a.url_comprovante,
                    p.tramitacao_cliente_id
                FROM agendamentos a
                INNER JOIN processos p ON p.id = a.processo_id
                WHERE a.status = 'AGENDADO'
                  AND a.data_agendamento >= $1
                  AND a.data_agendamento <= $2
                  AND (a.ultimo_lembrete_7d IS NULL 
                       OR a.ultimo_lembrete_7d < $1)
            `, [hoje, seteDiasDepois]);

            if (!result || result.length === 0) {
                return [];
            }

            return result.map((row: any) => ({
                id: row.id,
                processo_id: row.processo_id,
                protocolo_inss: row.protocolo_inss,
                nome_segurado: row.nome_segurado,
                cpf_segurado: row.cpf_segurado,
                tipo: row.tipo,
                data_agendamento: new Date(row.data_agendamento),
                hora_agendamento: row.hora_agendamento,
                unidade: row.unidade,
                url_comprovante: row.url_comprovante,
                tramitacao_cliente_id: row.tramitacao_cliente_id
            }));
        } catch (error: any) {
            logger.error(`[LembretesService] Erro ao buscar agendamentos para lembrete 7d: ${error.message}`);
            return [];
        }
    }

    /**
     * Envia lembrete para um agendamento específico
     */
    async enviarLembreteAgendamento(
        agendamento: AgendamentoParaLembrete,
        diasAntes: 30 | 7
    ): Promise<boolean> {
        try {
            // Verificar se ainda está válido no PAT
            const aindaValido = await this.verificarAgendamentoValido(
                agendamento.protocolo_inss,
                agendamento.cpf_segurado,
                agendamento.tipo
            );

            if (!aindaValido) {
                logger.info(`[LembretesService] ⏭️ Agendamento não está mais válido, pulando lembrete`);

                await Database.query(`
                    UPDATE agendamentos
                    SET status = 'CANCELADO',
                        updated_at = NOW()
                    WHERE id = $1
                `, [agendamento.id]);

                return false;
            }

            // Buscar tags do cliente
            let tagsCliente: string[] = [];
            if (agendamento.tramitacao_cliente_id) {
                try {
                    tagsCliente = await TramitacaoService.obterTagsCliente(
                        agendamento.tramitacao_cliente_id
                    );
                } catch (error: any) {
                    logger.warn(`[LembretesService] Erro ao buscar tags: ${error.message}`);
                }
            }

            // Identificar parceiro (verificar se já tem tag de parceiro)
            const parceiroIdentificado = await ParceirosService.identificarParceiroPorTags(tagsCliente);
            const destinatarios = ParceirosService.obterDestinatariosWhatsApp(parceiroIdentificado);

            // Calcular dias restantes
            const diasRestantes = differenceInDays(agendamento.data_agendamento, new Date());

            // Formatar tipo
            const tipoTexto = agendamento.tipo === 'PERICIA' ? 'PERÍCIA MÉDICA' : 'AVALIAÇÃO SOCIAL';

            // Função para mascarar CPF corretamente (000.XXX.X0X-00) - WhatsApp
            const mascararCpf = (cpf: string): string => {
                const cpfLimpo = cpf.replace(/\D/g, '');
                if (cpfLimpo.length !== 11) return cpf;
                // Formato: 000.XXX.X0X-00 (primeiros 3, XXX maiúsculo, penúltimo dígito, últimos 2)
                return `${cpfLimpo.substring(0, 3)}.XXX.X${cpfLimpo.substring(8, 9)}X-${cpfLimpo.substring(9, 11)}`;
            };

            const cpfMascarado = mascararCpf(agendamento.cpf_segurado);

            // Enviar para cada destinatário e coletar informações para nota
            let sucesso = false;
            const destinatariosNotificados: Array<{ nome: string; telefone: string }> = [];
            const dataHoraAtual = format(new Date(), 'dd/MM/yyyy, HH:mm', { locale: ptBR });

            for (const destinatario of destinatarios) {
                try {
                    // Montar mensagem diferente para parceiro e escritório
                    let mensagem: string;

                    if (destinatario.tipo === 'PARCEIRO') {
                        // Parceiro: SEM link do PAT, APENAS link do comprovante (se houver)
                        mensagem = `⏰ *LEMBRETE: ${tipoTexto} PRÓXIMA* ⏰%0A%0A` +
                            `*Cliente*: ${agendamento.nome_segurado}%0A` +
                            `*CPF*: ${cpfMascarado}%0A%0A` +
                            `*⚠️ ATENÇÃO: Faltam ${diasRestantes} dia(s) para a ${tipoTexto.toLowerCase()}!*%0A%0A` +
                            `*Data e Hora*: ${format(agendamento.data_agendamento, 'dd/MM/yyyy', { locale: ptBR })} às ${agendamento.hora_agendamento}%0A` +
                            `*Unidade*: ${agendamento.unidade}%0A`;

                        if (agendamento.url_comprovante) {
                            mensagem += `%0A*📄 Comprovante*:%0A${agendamento.url_comprovante}%0A`;
                        }

                        mensagem += `%0A*📅 Lembrete automático enviado em:* ${format(new Date(), 'dd/MM/yyyy, HH:mm', { locale: ptBR })}`;
                    } else {
                        // Escritório: COM link do PAT e comprovante (se houver)
                        mensagem = `⏰ *LEMBRETE: ${tipoTexto} PRÓXIMA* ⏰%0A%0A` +
                            `*Protocolo*: ${agendamento.protocolo_inss}%0A` +
                            `*Cliente*: ${agendamento.nome_segurado}%0A` +
                            `*CPF*: ${cpfMascarado}%0A%0A` +
                            `*⚠️ ATENÇÃO: Faltam ${diasRestantes} dia(s) para a ${tipoTexto.toLowerCase()}!*%0A%0A` +
                            `*Data e Hora*: ${format(agendamento.data_agendamento, 'dd/MM/yyyy', { locale: ptBR })} às ${agendamento.hora_agendamento}%0A` +
                            `*Unidade*: ${agendamento.unidade}%0A`;

                        if (agendamento.url_comprovante) {
                            mensagem += `%0A*📄 Comprovante*:%0A${agendamento.url_comprovante}%0A`;
                        }

                        mensagem += `%0A*🔗 Acesse o processo diretamente*:%0A` +
                            `https://atendimento.inss.gov.br/tarefas/detalhar_tarefa/${agendamento.protocolo_inss}%0A%0A` +
                            `*📅 Lembrete automático enviado em:* ${format(new Date(), 'dd/MM/yyyy, HH:mm', { locale: ptBR })}`;
                    }

                    const enviado = await whatsappService.enviar(
                        destinatario.telefone,
                        decodeURIComponent(mensagem)
                    );

                    if (enviado) {
                        sucesso = true;
                        logger.info(`[LembretesService] ✅ Lembrete ${diasAntes}d enviado para ${destinatario.nome}`);
                        destinatariosNotificados.push({
                            nome: destinatario.nome,
                            telefone: destinatario.telefone
                        });

                        await Database.query(`
                            INSERT INTO notificacoes_whatsapp (
                                processo_id, tipo, telefone_destino, cidade, mensagem, enviada, data_envio
                            ) VALUES ($1, $2, $3, $4, $5, true, NOW())
                        `, [
                            agendamento.processo_id,
                            `LEMBRETE_AGENDAMENTO_${diasAntes}D`,
                            destinatario.telefone,
                            destinatario.tipo === 'PARCEIRO' ? 'PARCEIRO' : 'ESCRITORIO',
                            decodeURIComponent(mensagem)
                        ]);
                    }
                } catch (error: any) {
                    logger.error(`[LembretesService] Erro ao enviar para ${destinatario.nome}: ${error.message}`);
                }
            }

            // Registrar nas notas se enviou com sucesso
            if (sucesso && agendamento.tramitacao_cliente_id) {
                try {
                    const destinatariosTexto = destinatariosNotificados.map(d =>
                        `${d.nome} (${d.telefone})`
                    ).join(', ');

                    let conteudoNota = `*⏰ LEMBRETE: ${tipoTexto} PRÓXIMA*%0A%0A` +
                        `*Protocolo*: ${agendamento.protocolo_inss}%0A` +
                        `*Cliente*: ${agendamento.nome_segurado}%0A` +
                        `*CPF*: ${cpfMascarado}%0A%0A` +
                        `*⚠️ ATENÇÃO: Faltam ${diasRestantes} dia(s) para a ${tipoTexto.toLowerCase()}!*%0A%0A` +
                        `*Data e Hora*: ${format(agendamento.data_agendamento, 'dd/MM/yyyy', { locale: ptBR })} às ${agendamento.hora_agendamento}%0A` +
                        `*Unidade*: ${agendamento.unidade}%0A`;

                    if (agendamento.url_comprovante) {
                        conteudoNota += `%0A*📄 Comprovante*:%0A${agendamento.url_comprovante}%0A`;
                    }

                    conteudoNota += `%0A*📱 Notificação WhatsApp enviada para:* ${destinatariosTexto} em ${dataHoraAtual}%0A%0A` +
                        `*🔗 Acesse o processo diretamente*:%0A` +
                        `https://atendimento.inss.gov.br/tarefas/detalhar_tarefa/${agendamento.protocolo_inss}%0A%0A` +
                        `---%0A%0A📅 Lembrete automático enviado em: ${dataHoraAtual}`;

                    await TramitacaoService.criarNota(agendamento.tramitacao_cliente_id.toString(), {
                        titulo: `⏰ Lembrete ${diasAntes}d - ${tipoTexto} - ${format(agendamento.data_agendamento, 'dd/MM/yyyy', { locale: ptBR })}`,
                        texto: decodeURIComponent(conteudoNota),
                        tipo: 'ALERTA'
                    });

                    logger.info(`[LembretesService] ✅ Nota registrada para lembrete ${diasAntes}d`);
                } catch (error: any) {
                    logger.warn(`[LembretesService] ⚠️ Erro ao registrar nota: ${error.message}`);
                }
            }

            // Atualizar último lembrete enviado
            if (sucesso) {
                const campoLembrete = diasAntes === 30 ? 'ultimo_lembrete_30d' : 'ultimo_lembrete_7d';
                await Database.query(`
                    UPDATE agendamentos
                    SET ${campoLembrete} = NOW(),
                        updated_at = NOW()
                    WHERE id = $1
                `, [agendamento.id]);
            }

            return sucesso;
        } catch (error: any) {
            logger.error(`[LembretesService] Erro ao enviar lembrete de agendamento: ${error.message}`);
            return false;
        }
    }

    /**
     * Processa todos os lembretes pendentes (exigências e agendamentos)
     */
    async processarLembretes(): Promise<{
        exigencias: { processadas: number; enviadas: number; puladas: number };
        agendamentos30d: { processadas: number; enviadas: number; puladas: number };
        agendamentos7d: { processadas: number; enviadas: number; puladas: number };
    }> {
        logger.info('[LembretesService] Iniciando processamento de lembretes (exigências + agendamentos)...');

        // 1. Processar lembretes de exigências (7 dias antes)
        const exigencias = await this.buscarExigenciasParaLembrete();
        let enviadasExigencias = 0;
        let puladasExigencias = 0;

        for (const exigencia of exigencias) {
            const enviado = await this.enviarLembrete(exigencia);
            if (enviado) enviadasExigencias++;
            else puladasExigencias++;
            await new Promise(resolve => setTimeout(resolve, 10000));
        }

        // 2. Processar lembretes de agendamentos (30 dias antes)
        const agendamentos30d = await this.buscarAgendamentosParaLembrete30d();
        let enviadas30d = 0;
        let puladas30d = 0;

        for (const agendamento of agendamentos30d) {
            const enviado = await this.enviarLembreteAgendamento(agendamento, 30);
            if (enviado) enviadas30d++;
            else puladas30d++;
            await new Promise(resolve => setTimeout(resolve, 10000));
        }

        // 3. Processar lembretes de agendamentos (7 dias antes)
        const agendamentos7d = await this.buscarAgendamentosParaLembrete7d();
        let enviadas7d = 0;
        let puladas7d = 0;

        for (const agendamento of agendamentos7d) {
            const enviado = await this.enviarLembreteAgendamento(agendamento, 7);
            if (enviado) enviadas7d++;
            else puladas7d++;
            await new Promise(resolve => setTimeout(resolve, 10000));
        }

        logger.info(`[LembretesService] Processamento concluído:`);
        logger.info(`  - Exigências: ${enviadasExigencias} enviadas, ${puladasExigencias} puladas`);
        logger.info(`  - Agendamentos 30d: ${enviadas30d} enviadas, ${puladas30d} puladas`);
        logger.info(`  - Agendamentos 7d: ${enviadas7d} enviadas, ${puladas7d} puladas`);

        return {
            exigencias: {
                processadas: exigencias.length,
                enviadas: enviadasExigencias,
                puladas: puladasExigencias
            },
            agendamentos30d: {
                processadas: agendamentos30d.length,
                enviadas: enviadas30d,
                puladas: puladas30d
            },
            agendamentos7d: {
                processadas: agendamentos7d.length,
                enviadas: enviadas7d,
                puladas: puladas7d
            }
        };
    }
}

export default new LembretesService();

