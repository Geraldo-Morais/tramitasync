/**
 * Serviço para extrair e gerenciar agendamentos de Perícia Médica e Avaliação Social do PAT
 */

import logger from '../utils/logger';
import PuppeteerService from './PuppeteerService';
import backblazeService from './BackblazeService';
import { Page } from 'puppeteer';
import { parse, format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

export interface Agendamento {
    id: string; // ID do agendamento (usado na URL de detalhes)
    tipo: 'PERICIA' | 'AVALIACAO_SOCIAL';
    data: Date;
    hora: string; // Formato HH:mm
    unidade: string; // Ex: "APS ITAPETINGA"
    endereco?: string;
    status: 'AGENDADO' | 'REMARCADO' | 'CANCELADO' | 'CUMPRIDO';
    etapa: string; // Ex: "Aguardando comparecimento"
    protocolo: string;
    cpf: string;
    linhaIndex?: number; // Índice da linha na tabela (para identificar qual botão clicar)
}

export interface AgendamentoDetalhado extends Agendamento {
    servico: string; // Ex: "Avaliação Social BPC/LOAS - Inicial (Presencial)"
    urlComprovante?: string; // URL para baixar PDF do comprovante
}

class AgendamentosService {
    /**
     * Extrai agendamentos de Avaliação Social do PAT
     */
    async extrairAvaliacoesSociais(
        page: Page,
        protocolo: string,
        cpf: string
    ): Promise<Agendamento[]> {
        try {
            logger.info(`[AgendamentosService] Extraindo avaliações sociais para protocolo ${protocolo}`);

            // XPath da tabela de avaliações sociais
            const xpathTabela = '/html/body/div[1]/div[2]/div/div[2]/main/div/div[2]/div[2]/div/div[1]/section[7]/div[3]/div[2]/div[1]/div/table/tbody';

            // XPath da etapa (para verificar se falta)
            const xpathEtapa = '/html/body/div[1]/div[2]/div/div[2]/main/div/div[2]/div[2]/div/div[1]/section[7]/div[2]/div';

            const agendamentos = await page.evaluate((xpathTabela, xpathEtapa, protocolo, cpf) => {
                const agendamentos: any[] = [];

                // Buscar tabela
                const tabela = document.evaluate(
                    xpathTabela,
                    document,
                    null,
                    XPathResult.FIRST_ORDERED_NODE_TYPE,
                    null
                ).singleNodeValue as HTMLTableSectionElement;

                if (!tabela) {
                    return agendamentos;
                }

                // Buscar etapa
                const etapaElement = document.evaluate(
                    xpathEtapa,
                    document,
                    null,
                    XPathResult.FIRST_ORDERED_NODE_TYPE,
                    null
                ).singleNodeValue as HTMLElement;

                const etapa = etapaElement?.textContent?.trim() || '';

                // Extrair linhas da tabela
                const linhas = tabela.querySelectorAll('tr');

                linhas.forEach((linha) => {
                    const colunas = linha.querySelectorAll('td');
                    if (colunas.length < 3) return;

                    // Coluna 0: Data e hora (ex: "16/12/2025 (Terça-feira) às 11:30")
                    const dataHoraTexto = colunas[0].textContent?.trim() || '';

                    // Coluna 1: Unidade (ex: "APS ITAPETINGA")
                    const unidade = colunas[1].querySelector('div')?.textContent?.trim() || colunas[1].textContent?.trim() || '';

                    // Coluna 2: Status (ex: "AGENDADO", "REMARCADO", "CANCELADO")
                    const statusTexto = colunas[2].textContent?.trim() || '';

                    // Coluna 3: Botão detalhar - extrair ID do onclick ou href do link pai
                    const botaoDetalhar = colunas[3]?.querySelector('button#btn-detalhar, button.get-link-button');
                    let idAgendamento = '';

                    // Tentar extrair do onclick do botão
                    if (botaoDetalhar) {
                        const onclick = botaoDetalhar.getAttribute('onclick') || '';
                        // Procurar padrões como: agendamento/123456 ou agendamento/pmf/123456 ou similar
                        const matchOnclick = onclick.match(/agendamento[\/]pmf?[\/]?(\d+)/) ||
                            onclick.match(/agendamento[\/](\d+)/) ||
                            onclick.match(/['"](\d+)['"]/);
                        if (matchOnclick && matchOnclick[1]) {
                            idAgendamento = matchOnclick[1];
                        } else {
                            // Tentar do data-id (não usar o id do botão que é sempre "btn-detalhar")
                            idAgendamento = botaoDetalhar.getAttribute('data-id') || '';
                        }
                    }

                    // Se não encontrou, tentar extrair da linha (pode ter data-attribute)
                    if (!idAgendamento) {
                        const linhaDataId = linha.getAttribute('data-id') || linha.getAttribute('data-agendamento-id') || '';
                        if (linhaDataId) idAgendamento = linhaDataId;
                    }

                    // Se ainda não encontrou, usar índice da linha como fallback (será usado para identificar qual botão clicar)
                    if (!idAgendamento) {
                        idAgendamento = `linha-${agendamentos.length}`;
                    }

                    // Extrair data e hora
                    const matchDataHora = dataHoraTexto.match(/(\d{2}\/\d{2}\/\d{4}).*?(\d{2}:\d{2})/);
                    if (!matchDataHora) return;

                    const dataStr = matchDataHora[1]; // "16/12/2025"
                    const horaStr = matchDataHora[2]; // "11:30"

                    // Determinar status
                    let status: string = 'AGENDADO';
                    if (statusTexto.includes('REMARCADO')) status = 'REMARCADO';
                    else if (statusTexto.includes('CANCELADO')) status = 'CANCELADO';
                    else if (statusTexto.includes('CUMPRIDO')) status = 'CUMPRIDO';
                    else if (statusTexto.includes('AGENDADO')) status = 'AGENDADO';

                    agendamentos.push({
                        id: idAgendamento,
                        tipo: 'AVALIACAO_SOCIAL',
                        dataStr,
                        horaStr,
                        unidade,
                        status,
                        etapa,
                        protocolo,
                        cpf,
                        linhaIndex: agendamentos.length // Índice da linha para identificar depois
                    });
                });

                return agendamentos;
            }, xpathTabela, xpathEtapa, protocolo, cpf);

            // Converter strings de data para Date
            const agendamentosFormatados: Agendamento[] = agendamentos.map((ag: any) => {
                const data = parse(ag.dataStr, 'dd/MM/yyyy', new Date());
                return {
                    id: ag.id,
                    tipo: ag.tipo,
                    data,
                    hora: ag.horaStr,
                    unidade: ag.unidade,
                    status: ag.status as Agendamento['status'],
                    etapa: ag.etapa,
                    protocolo: ag.protocolo,
                    cpf: ag.cpf
                };
            });

            logger.info(`[AgendamentosService] Encontradas ${agendamentosFormatados.length} avaliação(ões) social(is)`);
            return agendamentosFormatados;
        } catch (error: any) {
            logger.error(`[AgendamentosService] Erro ao extrair avaliações sociais: ${error.message}`);
            return [];
        }
    }

    /**
     * Extrai agendamentos de Perícia Médica do PAT
     */
    async extrairPericiasMedicas(
        page: Page,
        protocolo: string,
        cpf: string
    ): Promise<Agendamento[]> {
        try {
            logger.info(`[AgendamentosService] Extraindo perícias médicas para protocolo ${protocolo}`);

            // XPath da tabela de perícias
            const xpathTabela = '/html/body/div[1]/div[2]/div/div[2]/main/div/div[2]/div[2]/div/div[1]/section[8]/div[3]/div[2]/div[1]/div/table/tbody';

            // XPath da etapa (para verificar se falta)
            const xpathEtapa = '/html/body/div[1]/div[2]/div/div[2]/main/div/div[2]/div[2]/div/div[1]/section[8]/div[2]/div';

            const agendamentos = await page.evaluate((xpathTabela, xpathEtapa, protocolo, cpf) => {
                const agendamentos: any[] = [];

                // Buscar tabela
                const tabela = document.evaluate(
                    xpathTabela,
                    document,
                    null,
                    XPathResult.FIRST_ORDERED_NODE_TYPE,
                    null
                ).singleNodeValue as HTMLTableSectionElement;

                if (!tabela) {
                    return agendamentos;
                }

                // Buscar etapa
                const etapaElement = document.evaluate(
                    xpathEtapa,
                    document,
                    null,
                    XPathResult.FIRST_ORDERED_NODE_TYPE,
                    null
                ).singleNodeValue as HTMLElement;

                const etapa = etapaElement?.textContent?.trim() || '';

                // Extrair linhas da tabela
                const linhas = tabela.querySelectorAll('tr');

                linhas.forEach((linha) => {
                    const colunas = linha.querySelectorAll('td');
                    if (colunas.length < 3) return;

                    // Coluna 0: Data e hora
                    const dataHoraTexto = colunas[0].textContent?.trim() || '';

                    // Coluna 1: Unidade
                    const unidade = colunas[1].querySelector('div')?.textContent?.trim() || colunas[1].textContent?.trim() || '';

                    // Coluna 2: Status
                    const statusTexto = colunas[2].textContent?.trim() || '';

                    // Coluna 3: Botão detalhar - extrair ID do onclick ou href do link pai
                    const botaoDetalhar = colunas[3]?.querySelector('button#btn-detalhar, button.get-link-button');
                    let idAgendamento = '';

                    // Tentar extrair do onclick do botão
                    if (botaoDetalhar) {
                        const onclick = botaoDetalhar.getAttribute('onclick') || '';
                        // Procurar padrões como: agendamento/123456 ou agendamento/pmf/123456 ou similar
                        const matchOnclick = onclick.match(/agendamento[\/]pmf?[\/]?(\d+)/) ||
                            onclick.match(/agendamento[\/](\d+)/) ||
                            onclick.match(/['"](\d+)['"]/);
                        if (matchOnclick && matchOnclick[1]) {
                            idAgendamento = matchOnclick[1];
                        } else {
                            // Tentar do data-id (não usar o id do botão que é sempre "btn-detalhar")
                            idAgendamento = botaoDetalhar.getAttribute('data-id') || '';
                        }
                    }

                    // Se não encontrou, tentar extrair da linha (pode ter data-attribute)
                    if (!idAgendamento) {
                        const linhaDataId = linha.getAttribute('data-id') || linha.getAttribute('data-agendamento-id') || '';
                        if (linhaDataId) idAgendamento = linhaDataId;
                    }

                    // Se ainda não encontrou, usar índice da linha como fallback (será usado para identificar qual botão clicar)
                    if (!idAgendamento) {
                        idAgendamento = `linha-${agendamentos.length}`;
                    }

                    // Extrair data e hora
                    const matchDataHora = dataHoraTexto.match(/(\d{2}\/\d{2}\/\d{4}).*?(\d{2}:\d{2})/);
                    if (!matchDataHora) return;

                    const dataStr = matchDataHora[1];
                    const horaStr = matchDataHora[2];

                    // Determinar status
                    let status: string = 'AGENDADO';
                    if (statusTexto.includes('REMARCADO')) status = 'REMARCADO';
                    else if (statusTexto.includes('CANCELADO')) status = 'CANCELADO';
                    else if (statusTexto.includes('CUMPRIDO')) status = 'CUMPRIDO';
                    else if (statusTexto.includes('AGENDADO')) status = 'AGENDADO';

                    agendamentos.push({
                        id: idAgendamento,
                        tipo: 'PERICIA',
                        dataStr,
                        horaStr,
                        unidade,
                        status,
                        etapa,
                        protocolo,
                        cpf,
                        linhaIndex: agendamentos.length // Índice da linha para identificar depois
                    });
                });

                return agendamentos;
            }, xpathTabela, xpathEtapa, protocolo, cpf);

            // Converter strings de data para Date
            const agendamentosFormatados: Agendamento[] = agendamentos.map((ag: any) => {
                const data = parse(ag.dataStr, 'dd/MM/yyyy', new Date());
                return {
                    id: ag.id,
                    tipo: ag.tipo,
                    data,
                    hora: ag.horaStr,
                    unidade: ag.unidade,
                    status: ag.status as Agendamento['status'],
                    etapa: ag.etapa,
                    protocolo: ag.protocolo,
                    cpf: ag.cpf
                };
            });

            logger.info(`[AgendamentosService] Encontradas ${agendamentosFormatados.length} perícia(s) médica(s)`);
            return agendamentosFormatados;
        } catch (error: any) {
            logger.error(`[AgendamentosService] Erro ao extrair perícias médicas: ${error.message}`);
            return [];
        }
    }

    /**
     * Extrai detalhes completos de um agendamento (clicando no botão Detalhar dentro do card)
     */
    async extrairDetalhesAgendamento(
        page: Page,
        agendamento: Agendamento
    ): Promise<AgendamentoDetalhado | null> {
        try {
            logger.info(`[AgendamentosService] Extraindo detalhes do agendamento ${agendamento.id}`);

            // Primeiro, garantir que estamos na página de detalhes do protocolo
            // Se estivermos em uma página de agendamento, fechar e voltar para o protocolo
            const urlProtocolo = `https://atendimento.inss.gov.br/tarefas/detalhar_tarefa/${agendamento.protocolo}`;
            const urlAtual = page.url();

            // Se estivermos em uma página de agendamento, precisamos voltar para a página do protocolo
            // Verificar se há outras páginas abertas (pode ser que a página de agendamento tenha aberto em nova aba)
            if (urlAtual.includes('/agendamento/')) {
                logger.info(`[AgendamentosService] Estamos em página de agendamento, verificando outras páginas...`);
                const browser = page.browser();
                const pages = await browser.pages();

                // Procurar página que está no protocolo
                let paginaProtocolo: Page | null = null;
                for (const p of pages) {
                    const urlP = p.url();
                    if (urlP.includes(`detalhar_tarefa/${agendamento.protocolo}`)) {
                        paginaProtocolo = p;
                        break;
                    }
                }

                if (paginaProtocolo) {
                    logger.info(`[AgendamentosService] Página do protocolo encontrada, usando ela...`);
                    // Não podemos substituir o parâmetro, mas podemos usar a página correta
                    // Por enquanto, vamos navegar na página atual de volta
                    await page.goto(urlProtocolo, { waitUntil: 'networkidle2', timeout: 60000 });
                    await page.waitForTimeout(3000);
                } else {
                    logger.info(`[AgendamentosService] Navegando de volta para protocolo...`);
                    await page.goto(urlProtocolo, { waitUntil: 'networkidle2', timeout: 60000 });
                    await page.waitForTimeout(5000); // Aguardar mais tempo para página carregar completamente

                    // Aguardar spinner desaparecer
                    try {
                        await page.waitForSelector('.dtp-block-ui.blocked', { timeout: 5000, hidden: true });
                    } catch (error) {
                        // Ignorar se spinner não aparecer
                    }

                    // Aguardar elementos essenciais aparecerem
                    try {
                        await page.waitForSelector('.dtp-datagrid-label, label', { timeout: 10000 });
                    } catch (error) {
                        logger.warn(`[AgendamentosService] ⚠️ Elementos podem não ter carregado completamente`);
                    }
                }
            } else if (!urlAtual.includes(`detalhar_tarefa/${agendamento.protocolo}`)) {
                logger.info(`[AgendamentosService] Navegando para página do protocolo...`);
                await page.goto(urlProtocolo, { waitUntil: 'networkidle2', timeout: 60000 });
                await page.waitForTimeout(5000);

                // Aguardar spinner desaparecer
                try {
                    await page.waitForSelector('.dtp-block-ui.blocked', { timeout: 5000, hidden: true });
                } catch (error) {
                    // Ignorar se spinner não aparecer
                }

                // Aguardar elementos essenciais aparecerem
                try {
                    await page.waitForSelector('.dtp-datagrid-label, label', { timeout: 10000 });
                } catch (error) {
                    logger.warn(`[AgendamentosService] ⚠️ Elementos podem não ter carregado completamente`);
                }
            }

            // Determinar XPath da tabela baseado no tipo
            const xpathTabela = agendamento.tipo === 'AVALIACAO_SOCIAL'
                ? '/html/body/div[1]/div[2]/div/div[2]/main/div/div[2]/div[2]/div/div[1]/section[7]/div[3]/div[2]/div[1]/div/table/tbody'
                : '/html/body/div[1]/div[2]/div/div[2]/main/div/div[2]/div[2]/div/div[1]/section[8]/div[3]/div[2]/div[1]/div/table/tbody';

            // Variável para armazenar a página de detalhes (pode ser nova aba ou mesma página)
            let paginaDetalhes: Page = page;

            // Encontrar e clicar no botão "Detalhar" do agendamento específico
            // Usar data e hora para identificar a linha correta (mais confiável que ID)
            const dataFormatada = agendamento.data.toLocaleDateString('pt-BR'); // "01/12/2025"
            logger.info(`[AgendamentosService] 🔍 Procurando botão "Detalhar" para agendamento de ${dataFormatada} às ${agendamento.hora}...`);

            // Encontrar o índice da linha que corresponde a este agendamento
            const linhaIndexEncontrado = await page.evaluate((xpathTabela, dataFormatada, horaFormatada, linhaIndex) => {
                // Buscar tabela
                const tabela = document.evaluate(
                    xpathTabela,
                    document,
                    null,
                    XPathResult.FIRST_ORDERED_NODE_TYPE,
                    null
                ).singleNodeValue as HTMLTableSectionElement;

                if (!tabela) {
                    return -1;
                }

                // Buscar linha específica (por índice ou por data/hora)
                const linhas = tabela.querySelectorAll('tr');

                if (linhaIndex !== undefined && linhaIndex >= 0 && linhaIndex < linhas.length) {
                    // Verificar se a linha no índice corresponde à data/hora
                    const linha = linhas[linhaIndex];
                    const colunas = linha.querySelectorAll('td');
                    if (colunas.length > 0) {
                        const dataHoraTexto = colunas[0].textContent || '';
                        if (dataHoraTexto.includes(dataFormatada) && dataHoraTexto.includes(horaFormatada)) {
                            return linhaIndex;
                        }
                    }
                }

                // Procurar pela linha que contém a data e hora específicas
                for (let i = 0; i < linhas.length; i++) {
                    const linha = linhas[i];
                    const colunas = linha.querySelectorAll('td');
                    if (colunas.length > 0) {
                        const dataHoraTexto = colunas[0].textContent || '';
                        // Formato esperado: "01/12/2025 (Segunda-feira) às 10:00"
                        if (dataHoraTexto.includes(dataFormatada) && dataHoraTexto.includes(horaFormatada)) {
                            return i;
                        }
                    }
                }

                return -1;
            }, xpathTabela, dataFormatada, agendamento.hora, agendamento.linhaIndex);

            if (linhaIndexEncontrado === -1) {
                logger.warn(`[AgendamentosService] ⚠️ Linha não encontrada para ${dataFormatada} às ${agendamento.hora}, tentando URL direta...`);
                // Fallback: tentar URL direta se tiver ID válido
                if (agendamento.id && !agendamento.id.startsWith('linha-')) {
                    let urlDetalhes: string;
                    if (agendamento.tipo === 'AVALIACAO_SOCIAL') {
                        urlDetalhes = `https://atendimento.inss.gov.br/requerimentos/agendamento/${agendamento.id}`;
                    } else {
                        urlDetalhes = `https://atendimento.inss.gov.br/requerimentos/agendamento/pmf/${agendamento.id}/${agendamento.cpf}`;
                    }
                    await page.goto(urlDetalhes, { waitUntil: 'networkidle2', timeout: 60000 });
                    paginaDetalhes = page;
                } else {
                    throw new Error(`Não foi possível identificar a linha do agendamento ${dataFormatada} às ${agendamento.hora}`);
                }
            } else {
                // Linha encontrada, clicar no botão
                // Clicar no botão da linha específica usando XPath direto
                const xpathBotao = `${xpathTabela}/tr[${linhaIndexEncontrado + 1}]/td[4]/button`;
                logger.info(`[AgendamentosService] Clicando no botão da linha ${linhaIndexEncontrado + 1}...`);

                // Primeiro, verificar informações do botão
                const infoBotao = await page.evaluate((xpath) => {
                    const botao = document.evaluate(
                        xpath,
                        document,
                        null,
                        XPathResult.FIRST_ORDERED_NODE_TYPE,
                        null
                    ).singleNodeValue as HTMLElement;

                    if (!botao) {
                        return { encontrado: false };
                    }

                    const estilo = window.getComputedStyle(botao);
                    const onclick = botao.getAttribute('onclick') || '';
                    const href = (botao.closest('a') as HTMLAnchorElement)?.href || '';

                    return {
                        encontrado: true,
                        visivel: estilo.display !== 'none' && estilo.visibility !== 'hidden',
                        onclick: onclick.substring(0, 200),
                        href: href
                    };
                }, xpathBotao);

                logger.info(`[AgendamentosService] Informações do botão: ${JSON.stringify(infoBotao)}`);

                if (!infoBotao.encontrado) {
                    throw new Error(`Botão "Detalhar" não encontrado na linha ${linhaIndexEncontrado + 1}`);
                }

                // Usar Puppeteer para encontrar e clicar no botão diretamente
                // Primeiro, encontrar o elemento usando XPath
                const elementos = await page.$x(xpathBotao);

                if (elementos.length === 0) {
                    throw new Error(`Botão "Detalhar" não encontrado no XPath: ${xpathBotao}`);
                }

                const botaoElement = elementos[0] as any;

                // Scroll para o botão
                await botaoElement.scrollIntoView();
                await page.waitForTimeout(500);

                // Clicar usando Puppeteer (mais confiável que evaluate)
                await botaoElement.click({ delay: 100 });

                logger.info(`[AgendamentosService] ✅ Clique executado via Puppeteer`);

                // Aguardar um pouco após o clique para garantir que o evento foi processado
                await page.waitForTimeout(1000);

                logger.info(`[AgendamentosService] ✅ Botão "Detalhar" clicado, aguardando modal/loading desaparecer...`);

                // Configurar listener para detectar quando uma nova página é criada
                const novaPaginaPromise = new Promise<Page | null>((resolve) => {
                    const timeout = setTimeout(() => resolve(null), 10000);

                    const listener = async (target: any) => {
                        try {
                            const novaPage = await target.page();
                            if (novaPage) {
                                clearTimeout(timeout);
                                page.browser().off('targetcreated', listener);
                                await novaPage.waitForTimeout(2000);
                                const url = novaPage.url();
                                if (url.includes('/agendamento/')) {
                                    logger.info(`[AgendamentosService] ✅ Nova página detectada via listener: ${url}`);
                                    resolve(novaPage);
                                } else {
                                    resolve(null);
                                }
                            }
                        } catch (error) {
                            // Ignorar erros
                        }
                    };

                    page.browser().on('targetcreated', listener);
                });

                // Aguardar modal/loading desaparecer (spinner)
                try {
                    await page.waitForSelector('.dtp-block-ui.blocked', { timeout: 5000, hidden: true });
                    logger.info(`[AgendamentosService] ✅ Spinner desapareceu`);
                } catch (error) {
                    logger.warn(`[AgendamentosService] ⚠️ Spinner não detectado ou já desapareceu`);
                }

                // Aguardar navegação acontecer (pode abrir em nova aba ou na mesma)
                // Aguardar mais tempo para garantir que a nova aba abriu
                await page.waitForTimeout(2000);

                // Verificar se detectou nova página via listener
                const novaPaginaDetectada = await novaPaginaPromise;
                if (novaPaginaDetectada) {
                    paginaDetalhes = novaPaginaDetectada;
                } else {
                    // Verificar se abriu em nova aba (verificar múltiplas vezes)
                    let tentativasAba = 0;
                    while (tentativasAba < 5) {
                        const pages = await page.browser().pages();

                        if (pages.length > 1) {
                            // Verificar se alguma das páginas tem a URL de agendamento
                            for (const p of pages) {
                                const url = p.url();
                                if (url.includes('/agendamento/')) {
                                    paginaDetalhes = p;
                                    logger.info(`[AgendamentosService] ✅ Página de detalhes encontrada em nova aba: ${url}`);
                                    break;
                                }
                            }

                            // Se encontrou, sair do loop
                            if (paginaDetalhes !== page) {
                                break;
                            }
                        }

                        // Se não encontrou, aguardar mais um pouco
                        await page.waitForTimeout(1000);
                        tentativasAba++;
                    }
                }

                // Se não encontrou em nova aba, verificar se a URL mudou na mesma página
                if (paginaDetalhes === page) {
                    try {
                        await page.waitForFunction(
                            () => window.location.href.includes('/agendamento/'),
                            { timeout: 5000 }
                        );
                        logger.info(`[AgendamentosService] ✅ Página de detalhes carregada na mesma aba: ${page.url()}`);
                    } catch (error) {
                        // Se não mudou a URL, pode ser que tenha aberto em modal/popup ou iframe
                        logger.warn(`[AgendamentosService] ⚠️ URL não mudou, verificando se abriu em modal/iframe...`);

                        // Aguardar um pouco para modal aparecer
                        await page.waitForTimeout(2000);

                        // Verificar se há um modal ou iframe com a página de detalhes
                        const modalOuIframe = await page.evaluate(() => {
                            // Procurar por iframe
                            const iframes = Array.from(document.querySelectorAll('iframe'));
                            for (const iframe of iframes) {
                                try {
                                    const src = iframe.getAttribute('src') || '';
                                    if (src.includes('/agendamento/')) {
                                        return { tipo: 'iframe', elemento: iframe };
                                    }
                                } catch (e) { }
                            }

                            // Procurar por modal com conteúdo de agendamento
                            const modals = Array.from(document.querySelectorAll('.modal, .dialog, [role="dialog"]'));
                            for (const modal of modals) {
                                const texto = modal.textContent || '';
                                if (texto.includes('Agendamento') || texto.includes('Comprovante')) {
                                    return { tipo: 'modal', elemento: modal };
                                }
                            }

                            return null;
                        });

                        if (modalOuIframe) {
                            logger.info(`[AgendamentosService] ✅ Encontrado ${modalOuIframe.tipo}, continuando...`);
                        } else {
                            logger.warn(`[AgendamentosService] ⚠️ Modal/iframe não encontrado, assumindo que página carregou`);
                        }
                    }
                }

                logger.info(`[AgendamentosService] Usando página: ${paginaDetalhes.url()}`);
            }

            // Usar a página correta (pode ser nova aba ou mesma página)
            const pageParaUsar = paginaDetalhes;

            // Aguardar página carregar completamente
            await pageParaUsar.waitForTimeout(2000);

            // Se ainda estamos na mesma página, pode ter aberto em modal/popup
            // Verificar se há um botão "Gerar Comprovante" visível na página atual
            if (pageParaUsar.url().includes('detalhar_tarefa')) {
                logger.info(`[AgendamentosService] ⚠️ Ainda na página de detalhes do protocolo, verificando se modal/popup abriu...`);

                // Tentar encontrar o botão "Gerar Comprovante" diretamente na página atual
                const botaoComprovanteExiste = await pageParaUsar.evaluate(() => {
                    const xpathBotao = '/html/body/div/div[2]/div/div[2]/main/div/div/div[11]/div[2]/button';
                    const botao = document.evaluate(
                        xpathBotao,
                        document,
                        null,
                        XPathResult.FIRST_ORDERED_NODE_TYPE,
                        null
                    ).singleNodeValue as HTMLElement;

                    return !!botao;
                });

                if (botaoComprovanteExiste) {
                    logger.info(`[AgendamentosService] ✅ Botão "Gerar Comprovante" encontrado na página atual!`);
                    // Continuar com a extração de detalhes e clique no botão
                } else {
                    logger.warn(`[AgendamentosService] ⚠️ Botão "Gerar Comprovante" não encontrado, tentando extrair detalhes mesmo assim...`);
                }
            }

            // Aguardar elementos aparecerem
            try {
                await pageParaUsar.waitForSelector('.dtp-datagrid-label, label', { timeout: 10000 });
            } catch (error) {
                logger.warn(`[AgendamentosService] Elementos não apareceram, continuando mesmo assim...`);
            }

            // Extrair detalhes da página
            const detalhes = await pageParaUsar.evaluate(() => {
                // Tentar múltiplos XPaths possíveis para os detalhes
                const xpathsPossiveis = [
                    '/html/body/div/div[2]/div/div[2]/main/div/div/div[3]/div[2]',
                    '/html/body/div[1]/div[2]/div/div[2]/main/div/div/div[3]/div[2]',
                    '//div[contains(@class, "dtp-datagrid")]',
                    '//section[contains(., "Agendamento")]'
                ];

                let detalhesElement: HTMLElement | null = null;

                for (const xpath of xpathsPossiveis) {
                    try {
                        const elemento = document.evaluate(
                            xpath,
                            document,
                            null,
                            XPathResult.FIRST_ORDERED_NODE_TYPE,
                            null
                        ).singleNodeValue as HTMLElement;

                        if (elemento) {
                            detalhesElement = elemento;
                            break;
                        }
                    } catch (e) {
                        continue;
                    }
                }

                if (!detalhesElement) return null;

                const divs = detalhesElement.querySelectorAll('div');
                const dados: any = {};

                divs.forEach((div) => {
                    const label = div.querySelector('label')?.textContent?.trim();
                    // Pegar valor do próximo elemento (span ou div) após o label
                    const valorElement = div.querySelector('span, div.dtp-datagrid-value');
                    const valor = valorElement?.textContent?.trim() || div.textContent?.replace(label || '', '').trim();

                    if (label && valor) {
                        if (label.includes('Serviço')) dados.servico = valor;
                        if (label.includes('Status')) dados.status = valor;
                        if (label.includes('Data e Hora') || label.includes('Data')) {
                            dados.dataHora = valor;
                            // Extrair data e hora separadamente
                            const matchDataHora = valor.match(/(\d{2}\/\d{2}\/\d{4}).*?(\d{2}:\d{2})/);
                            if (matchDataHora) {
                                dados.data = matchDataHora[1];
                                dados.hora = matchDataHora[2];
                            }
                        }
                        if (label.includes('Endereço')) dados.endereco = valor;
                        if (label.includes('Unidade')) dados.unidade = valor;
                    }
                });

                return dados;
            });

            if (!detalhes) {
                logger.warn(`[AgendamentosService] Não foi possível extrair detalhes do agendamento ${agendamento.id}`);
                return null;
            }

            // Baixar PDF clicando no botão "Gerar comprovante" e fazer upload para Backblaze B2
            let urlComprovantePublica: string | null = null;
            try {
                const tipoTexto = agendamento.tipo === 'PERICIA' ? 'pericia' : 'avaliacao';
                const fileName = `comprovante-${tipoTexto}-${agendamento.id}-${agendamento.protocolo}.pdf`;

                logger.info(`[AgendamentosService] 🔍 Procurando botão "Gerar comprovante" na página...`);

                // Configurar listener para capturar resposta PDF ANTES de clicar
                let pdfBuffer: Buffer | null = null;
                let pdfCapturado = false;

                const responseHandler = async (response: any) => {
                    try {
                        const contentType = response.headers()['content-type'] || '';
                        const url = response.url();

                        logger.info(`[AgendamentosService] 📡 Resposta recebida: ${url.substring(0, 100)} - Content-Type: ${contentType}`);

                        if ((contentType.includes('application/pdf') || url.includes('comprovante')) && !pdfCapturado) {
                            pdfCapturado = true;
                            logger.info(`[AgendamentosService] 📥 PDF detectado na resposta, capturando...`);

                            try {
                                // Verificar se a resposta tem body disponível
                                const request = response.request();
                                const method = request.method();

                                if (method === 'OPTIONS') {
                                    logger.warn(`[AgendamentosService] ⚠️ Ignorando requisição OPTIONS (preflight)`);
                                    pdfCapturado = false; // Resetar para tentar novamente
                                    return;
                                }

                                // Verificar status da resposta
                                const status = response.status();
                                if (status !== 200) {
                                    logger.warn(`[AgendamentosService] ⚠️ Status da resposta não é 200: ${status}`);
                                    pdfCapturado = false;
                                    return;
                                }

                                logger.info(`[AgendamentosService] 📥 Lendo buffer do PDF (método: ${method}, status: ${status})...`);
                                const buffer = await response.buffer();

                                if (buffer && Buffer.isBuffer(buffer) && buffer.length > 0) {
                                    // Validar se é um PDF válido antes de considerar capturado
                                    const header = buffer.toString('ascii', 0, Math.min(4, buffer.length));
                                    if (header === '%PDF') {
                                        pdfBuffer = buffer;
                                        pdfCapturado = true;
                                        logger.info(`[AgendamentosService] ✅ PDF capturado e validado via listener! (${(pdfBuffer.length / 1024).toFixed(2)} KB)`);
                                    } else {
                                        logger.warn(`[AgendamentosService] ⚠️ Buffer não é PDF válido! Header: ${header} (esperado: %PDF)`);
                                        logger.warn(`[AgendamentosService] Primeiros 50 bytes: ${buffer.toString('hex', 0, Math.min(50, buffer.length))}`);
                                        pdfCapturado = false;
                                    }
                                } else {
                                    logger.warn(`[AgendamentosService] ⚠️ Buffer vazio ou inválido`);
                                    pdfCapturado = false;
                                }
                            } catch (bufferError: any) {
                                logger.error(`[AgendamentosService] ❌ Erro ao ler buffer: ${bufferError.message}`);
                                logger.error(`[AgendamentosService] Stack: ${bufferError.stack}`);
                                pdfCapturado = false; // Resetar para tentar novamente
                            }
                        }
                    } catch (error: any) {
                        logger.warn(`[AgendamentosService] ⚠️ Erro ao processar resposta: ${error.message}`);
                    }
                };

                // Registrar listener ANTES de clicar (na página correta)
                pageParaUsar.on('response', responseHandler);

                // Procurar e clicar no botão "Gerar comprovante" usando o seletor específico
                logger.info(`[AgendamentosService] 🔍 Buscando botão "Gerar Comprovante"...`);

                // Aguardar botão aparecer
                try {
                    await pageParaUsar.waitForSelector('button.br-button.primary', { timeout: 10000 });
                } catch (error) {
                    logger.warn(`[AgendamentosService] ⚠️ Botão não encontrado com seletor específico, tentando alternativas...`);
                }

                // Tentar clicar usando o XPath específico fornecido pelo usuário
                const xpathBotaoComprovante = '/html/body/div/div[2]/div/div[2]/main/div/div/div[11]/div[2]/button';
                let botaoClicado = await pageParaUsar.evaluate((xpath: string) => {
                    const botao = document.evaluate(
                        xpath,
                        document,
                        null,
                        XPathResult.FIRST_ORDERED_NODE_TYPE,
                        null
                    ).singleNodeValue as HTMLElement;

                    if (!botao) return false;

                    const texto = (botao.textContent || botao.innerText || '').trim();
                    if (!texto.toLowerCase().includes('comprovante')) {
                        return false;
                    }

                    // Scroll e clique
                    botao.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    botao.click();
                    return true;
                }, xpathBotaoComprovante);

                // Se não encontrou pelo XPath, tentar por seletor CSS
                if (!botaoClicado) {
                    logger.info(`[AgendamentosService] Tentando buscar por seletor CSS...`);
                    botaoClicado = await pageParaUsar.evaluate(() => {
                        const buttons = Array.from(document.querySelectorAll('button.br-button.primary'));
                        const botaoComprovante = buttons.find((btn: any) => {
                            const texto = (btn.textContent || btn.innerText || '').toLowerCase();
                            return texto.includes('comprovante') || texto.includes('gerar');
                        });

                        if (botaoComprovante) {
                            (botaoComprovante as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
                            (botaoComprovante as HTMLElement).click();
                            return true;
                        }
                        return false;
                    });
                }

                if (!botaoClicado) {
                    pageParaUsar.off('response', responseHandler);
                    throw new Error('Botão "Gerar comprovante" não encontrado na página');
                }

                logger.info(`[AgendamentosService] ✅ Botão clicado, aguardando download do PDF...`);

                // Aguardar especificamente pela resposta do PDF usando waitForResponse
                try {
                    logger.info(`[AgendamentosService] ⏳ Aguardando resposta do PDF (tipo: ${agendamento.tipo})...`);

                    const pdfResponse = await pageParaUsar.waitForResponse(
                        (response: any) => {
                            const contentType = response.headers()['content-type'] || '';
                            const url = response.url();
                            const method = response.request().method();
                            const status = response.status();

                            const isPDF = (contentType.includes('application/pdf') ||
                                contentType.includes('application/octet-stream') ||
                                url.includes('comprovante')) &&
                                status === 200 &&
                                method !== 'OPTIONS';

                            if (isPDF) {
                                logger.info(`[AgendamentosService] 📡 PDF detectado: ${url.substring(0, 100)} - Content-Type: ${contentType} - Status: ${status} - Method: ${method}`);
                            }

                            return isPDF;
                        },
                        { timeout: 30000 }
                    );

                    logger.info(`[AgendamentosService] 📥 Resposta PDF recebida, aguardando body estar disponível...`);

                    // Aguardar mais tempo para garantir que o body está completamente carregado
                    // Avaliação Social pode demorar mais para gerar o PDF
                    await pageParaUsar.waitForTimeout(agendamento.tipo === 'AVALIACAO_SOCIAL' ? 2000 : 1000);

                    // Ler o buffer diretamente da resposta
                    logger.info(`[AgendamentosService] 📥 Lendo buffer do PDF...`);
                    const buffer = await pdfResponse.buffer();

                    if (buffer && Buffer.isBuffer(buffer) && buffer.length > 0) {
                        // Validar header do PDF antes de considerar capturado
                        const header = buffer.toString('ascii', 0, Math.min(4, buffer.length));
                        if (header === '%PDF') {
                            pdfBuffer = buffer;
                            pdfCapturado = true;
                            logger.info(`[AgendamentosService] ✅ PDF capturado e validado! (${(pdfBuffer.length / 1024).toFixed(2)} KB)`);
                        } else {
                            logger.error(`[AgendamentosService] ❌ Buffer não é um PDF válido! Header: ${header} (esperado: %PDF)`);
                            logger.error(`[AgendamentosService] Primeiros 50 bytes: ${buffer.toString('hex', 0, Math.min(50, buffer.length))}`);
                            throw new Error(`PDF inválido capturado (header: ${header})`);
                        }
                    } else {
                        throw new Error('Buffer vazio ou inválido');
                    }
                } catch (waitError: any) {
                    logger.warn(`[AgendamentosService] ⚠️ waitForResponse falhou, tentando método alternativo: ${waitError.message}`);

                    // Fallback: aguardar PDF ser capturado pelo listener (máximo 30s)
                    let tentativas = 0;
                    while (!pdfCapturado && tentativas < 30) {
                        await pageParaUsar.waitForTimeout(1000);
                        tentativas++;
                        if (tentativas % 5 === 0) {
                            logger.info(`[AgendamentosService] ⏳ Aguardando PDF... (${tentativas}s)`);
                        }
                    }

                    // Se ainda não capturou, tentar retry do clique
                    if (!pdfCapturado) {
                        logger.warn(`[AgendamentosService] ⚠️ PDF não capturado após 30s, tentando retry do clique...`);
                        // Aguardar um pouco antes de tentar novamente
                        await pageParaUsar.waitForTimeout(2000);

                        // Tentar clicar novamente (apenas uma vez)
                        const retryClick = await pageParaUsar.evaluate((xpath: string) => {
                            const botao = document.evaluate(
                                xpath,
                                document,
                                null,
                                XPathResult.FIRST_ORDERED_NODE_TYPE,
                                null
                            ).singleNodeValue as HTMLElement;

                            if (botao) {
                                botao.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                botao.click();
                                return true;
                            }
                            return false;
                        }, xpathBotaoComprovante);

                        if (retryClick) {
                            logger.info(`[AgendamentosService] ✅ Retry do clique executado, aguardando PDF...`);
                            // Aguardar mais 15s após retry
                            tentativas = 0;
                            while (!pdfCapturado && tentativas < 15) {
                                await pageParaUsar.waitForTimeout(1000);
                                tentativas++;
                            }
                        }
                    }
                }

                // Remover listener
                pageParaUsar.off('response', responseHandler);

                // Verificar se PDF foi capturado
                if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) {
                    throw new Error('PDF não foi capturado após clicar no botão');
                }

                // TypeScript agora sabe que pdfBuffer é Buffer
                const bufferFinal: Buffer = pdfBuffer;
                const bufferSize = bufferFinal.length;

                if (bufferSize === 0) {
                    throw new Error('PDF capturado está vazio');
                }

                // Validar se é um PDF válido (deve começar com %PDF)
                const pdfHeader = bufferFinal.toString('ascii', 0, Math.min(4, bufferSize));
                if (pdfHeader !== '%PDF') {
                    logger.error(`[AgendamentosService] ❌ PDF inválido! Header: ${pdfHeader} (esperado: %PDF)`);
                    logger.error(`[AgendamentosService] Primeiros 100 bytes: ${bufferFinal.toString('hex', 0, Math.min(100, bufferSize))}`);
                    throw new Error(`PDF capturado não é um PDF válido (header: ${pdfHeader})`);
                }

                // Verificar tamanho mínimo (um PDF válido deve ter pelo menos alguns KB)
                if (bufferSize < 1000) {
                    logger.warn(`[AgendamentosService] ⚠️ PDF muito pequeno (${bufferSize} bytes), pode estar corrompido`);
                }

                logger.info(`[AgendamentosService] 📦 PDF baixado e validado (${(bufferSize / 1024).toFixed(2)} KB), fazendo upload para Backblaze...`);

                // Fazer upload para Backblaze
                urlComprovantePublica = await backblazeService.uploadPDF(bufferFinal, fileName);

                if (urlComprovantePublica) {
                    logger.info(`[AgendamentosService] ✅ Comprovante disponível publicamente: ${urlComprovantePublica}`);
                } else {
                    throw new Error('Falha ao fazer upload para Backblaze');
                }
            } catch (error: any) {
                logger.error(`[AgendamentosService] ❌ Erro ao processar comprovante: ${error.message}`);
                urlComprovantePublica = null;
            }

            // Atualizar dados do agendamento com detalhes extraídos
            const agendamentoAtualizado: AgendamentoDetalhado = {
                ...agendamento,
                servico: detalhes.servico || agendamento.unidade || '',
                endereco: detalhes.endereco || agendamento.endereco,
                // Atualizar hora e unidade se encontrados nos detalhes
                hora: detalhes.hora || agendamento.hora,
                unidade: detalhes.unidade || agendamento.unidade,
                urlComprovante: urlComprovantePublica || undefined
            };

            return agendamentoAtualizado;
        } catch (error: any) {
            logger.error(`[AgendamentosService] Erro ao extrair detalhes: ${error.message}`);
            return null;
        }
    }

    /**
     * Filtra apenas agendamentos AGENDADOS (ignora REMARCADO, CANCELADO, CUMPRIDO)
     */
    filtrarAgendados(agendamentos: Agendamento[]): Agendamento[] {
        const agendados = agendamentos.filter(ag => ag.status === 'AGENDADO');
        logger.info(`[AgendamentosService] Filtrando agendamentos: ${agendamentos.length} total → ${agendados.length} AGENDADO(s)`);
        return agendados;
    }

    /**
     * Verifica se existe botão "Agendar" para Perícia ou Avaliação Social
     * @returns Array com tipos que precisam agendamento manual
     */
    async verificarBotoesAgendar(
        page: Page
    ): Promise<Array<'PERICIA' | 'AVALIACAO_SOCIAL'>> {
        try {
            logger.info('[AgendamentosService] Verificando botões "Agendar"...');

            const tiposParaAgendar: Array<'PERICIA' | 'AVALIACAO_SOCIAL'> = [];

            // Verificar botão de agendar Perícia
            const xpathBtnAgendarPericia = '/html/body/div[1]/div[2]/div/div[2]/main/div/div[2]/div[2]/div/div[1]/section[8]/div[1]/button';
            const temBtnPericia = await page.evaluate((xpath) => {
                const element = document.evaluate(
                    xpath,
                    document,
                    null,
                    XPathResult.FIRST_ORDERED_NODE_TYPE,
                    null
                ).singleNodeValue as HTMLElement;
                return element !== null && element.textContent?.includes('Agendar');
            }, xpathBtnAgendarPericia);

            if (temBtnPericia) {
                logger.info('[AgendamentosService] Botão "Agendar" encontrado para PERÍCIA');
                tiposParaAgendar.push('PERICIA');
            }

            // Verificar botão de agendar Avaliação Social
            const xpathBtnAgendarAvaliacao = '/html/body/div[1]/div[2]/div/div[2]/main/div/div[2]/div[2]/div/div[1]/section[7]/div[1]/button';
            const temBtnAvaliacao = await page.evaluate((xpath) => {
                const element = document.evaluate(
                    xpath,
                    document,
                    null,
                    XPathResult.FIRST_ORDERED_NODE_TYPE,
                    null
                ).singleNodeValue as HTMLElement;
                return element !== null && element.textContent?.includes('Agendar');
            }, xpathBtnAgendarAvaliacao);

            if (temBtnAvaliacao) {
                logger.info('[AgendamentosService] Botão "Agendar" encontrado para AVALIAÇÃO SOCIAL');
                tiposParaAgendar.push('AVALIACAO_SOCIAL');
            }

            return tiposParaAgendar;
        } catch (error: any) {
            logger.error(`[AgendamentosService] Erro ao verificar botões Agendar: ${error.message}`);
            return [];
        }
    }

    /**
     * Identifica se um benefício precisa de perícia/avaliação baseado no tipo
     */
    precisaPericiaOuAvaliacao(tipoBeneficio: string): {
        precisaPericia: boolean;
        precisaAvaliacao: boolean;
    } {
        const tipoUpper = tipoBeneficio.toUpperCase();

        // BPC sempre tem os dois
        if (tipoUpper.includes('BPC') ||
            tipoUpper.includes('PRESTAÇÃO CONTINUADA') ||
            tipoUpper.includes('LOAS')) {
            return {
                precisaPericia: true,
                precisaAvaliacao: true
            };
        }

        // Benefício por incapacidade pode ter perícia
        if (tipoUpper.includes('INCAPACIDADE') ||
            tipoUpper.includes('AUXÍLIO-DOENÇA') ||
            tipoUpper.includes('AUXILIO-DOENÇA')) {
            return {
                precisaPericia: true,
                precisaAvaliacao: false
            };
        }

        // Pensão para maior inválido tem os dois
        if (tipoUpper.includes('PENSÃO') && tipoUpper.includes('INVÁLIDO')) {
            return {
                precisaPericia: true,
                precisaAvaliacao: true
            };
        }

        return {
            precisaPericia: false,
            precisaAvaliacao: false
        };
    }
}

export default new AgendamentosService();
