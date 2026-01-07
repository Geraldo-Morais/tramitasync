import puppeteerService from './PuppeteerService';
import logger from '../utils/logger';
import fs from 'fs';
import path from 'path';

interface FiltrosBusca {
    dataInicio: Date;
    dataFim: Date;
    status?: string[];
}

interface TarefaINSS {
    protocolo: string;
    cpf: string;
    nome: string;
    status: string;
    servico: string;
    dataCriacao: string;
}

interface DadosGerais {
    nome: string;
    cpf: string;
    protocolo: string;
    situacao: string;
    dataCriacao: string;
}

interface HistoricoItem {
    titulo: string;
    data: string;
    descricao: string;
}

interface ResultadoHistorico {
    temExigencia: boolean;
    cards: HistoricoItem[];
}

interface ResultadoProcessamento {
    dadosGerais: DadosGerais | null;
    agendamento: {
        subProtocolo: string;
        dataHora: string;
        unidade: string;
        endereco: string;
        tipo: 'PERICIA' | 'SOCIAL';
        comprovanteSalvo: boolean;
    } | null;
    historico: ResultadoHistorico | null;
}

export class PatSyncService {
    private downloadPath: string;

    constructor() {
        this.downloadPath = path.join(process.cwd(), 'downloads', 'comprovantes');
        if (!fs.existsSync(this.downloadPath)) {
            fs.mkdirSync(this.downloadPath, { recursive: true });
        }
    }

    /**
     * Busca tarefas no INSS usando abordagem híbrida (Visual + Interceptação)
     */
    async buscarTarefasHibrido(filtros: FiltrosBusca): Promise<{ token: string; tarefas: TarefaINSS[] } | null> {
        const page = puppeteerService.getPage();
        if (!page) {
            logger.error('[PatSync] Navegador não inicializado');
            return null;
        }

        logger.info('[PatSync] Iniciando busca híbrida de tarefas...');

        let authToken: string | null = null;
        let tarefasEncontradas: TarefaINSS[] = [];

        const responseHandler = async (response: any) => {
            const url = response.url();
            if (url.includes('/tarefa/consulta') && response.request().method() === 'POST') {
                try {
                    const requestHeaders = response.request().headers();
                    if (requestHeaders['authorization']) {
                        authToken = requestHeaders['authorization'].replace('Bearer ', '');
                        logger.info('[PatSync] 🔑 Token de autorização capturado!');
                    }

                    const data = await response.json();
                    if (data && data.tarefas) {
                        tarefasEncontradas = data.tarefas.map((t: any) => ({
                            protocolo: t.protocolo,
                            cpf: t.cpf,
                            nome: t.nome,
                            status: t.status,
                            servico: t.servico,
                            dataCriacao: t.dataCriacao
                        }));
                        logger.info(`[PatSync] 📋 ${tarefasEncontradas.length} tarefas interceptadas.`);
                    }
                } catch (e) {
                    logger.warn('[PatSync] Erro ao processar resposta interceptada:', e);
                }
            }
        };

        page.on('response', responseHandler);

        try {
            await page.goto('https://atendimento.inss.gov.br/tarefas', { waitUntil: 'networkidle2' });

            // TODO: Implementar preenchimento visual de filtros se necessário

            const btnConsultar = await page.$('button[type="submit"], button:contains("Consultar")');
            if (btnConsultar) {
                await btnConsultar.click();
                await page.waitForResponse(res => res.url().includes('/tarefa/consulta'), { timeout: 10000 });
            } else {
                logger.warn('[PatSync] Botão Consultar não encontrado, tentando extrair da tela atual...');
            }

            page.off('response', responseHandler);

            if (authToken) {
                return { token: authToken, tarefas: tarefasEncontradas };
            } else {
                logger.error('[PatSync] ❌ Não foi possível capturar o token de autorização.');
                return null;
            }

        } catch (error: any) {
            page.off('response', responseHandler);
            logger.error(`[PatSync] Erro na busca híbrida: ${error.message}`);
            return null;
        }
    }

    /**
     * Extrai dados gerais do cabeçalho do protocolo
     */
    async extrairDadosGerais(): Promise<DadosGerais | null> {
        const page = puppeteerService.getPage();
        if (!page) return null;

        try {
            return await page.evaluate(() => {
                const getText = (selector: string) => document.querySelector(selector)?.textContent?.trim() || '';

                // Tentar encontrar labels específicos
                const labels = Array.from(document.querySelectorAll('label, span.label'));
                const getByLabel = (text: string) => {
                    const label = labels.find(l => l.textContent?.toUpperCase().includes(text));
                    return label?.parentElement?.textContent?.replace(label.textContent || '', '').trim() || '';
                };

                return {
                    protocolo: getText('span.protocolo-numero') || getByLabel('PROTOCOLO'),
                    situacao: getText('.br-tag.status') || getByLabel('SITUAÇÃO'),
                    nome: getByLabel('TITULAR') || getByLabel('NOME'),
                    cpf: getByLabel('CPF'),
                    dataCriacao: getByLabel('DATA DE CRIAÇÃO') || getByLabel('DER')
                };
            });
        } catch (error) {
            logger.error('[PatSync] Erro ao extrair dados gerais:', error);
            return null;
        }
    }

    /**
     * Extrai histórico e verifica exigências
     */
    async extrairHistorico(): Promise<ResultadoHistorico | null> {
        const page = puppeteerService.getPage();
        if (!page) return null;

        try {
            return await page.evaluate(() => {
                const cards = Array.from(document.querySelectorAll('.br-card'));
                const historico: any[] = [];
                let temExigencia = false;

                cards.forEach(card => {
                    const titulo = card.querySelector('.card-title')?.textContent?.trim() || '';
                    const data = card.querySelector('.card-date, .data')?.textContent?.trim() || '';
                    const descricao = card.querySelector('.card-content, .description')?.textContent?.trim() || '';

                    if (titulo.toUpperCase().includes('EXIGÊNCIA') || descricao.toUpperCase().includes('EXIGÊNCIA')) {
                        temExigencia = true;
                    }

                    historico.push({ titulo, data, descricao });
                });

                // Pegar os 3 mais recentes (assumindo ordem cronológica inversa ou direta, pegamos os primeiros se for lista recente no topo)
                // Geralmente INSS mostra mais recente no topo.
                const ultimos = historico.slice(0, 3);

                return {
                    temExigencia,
                    cards: ultimos
                };
            });
        } catch (error) {
            logger.error('[PatSync] Erro ao extrair histórico:', error);
            return null;
        }
    }

    /**
     * Processa uma tarefa completa: Dados Gerais, Histórico e Agendamentos
     */
    async processarTarefa(mainProtocol: string, cpf: string, token: string): Promise<ResultadoProcessamento | null> {
        const page = puppeteerService.getPage();
        if (!page) return null;

        try {
            logger.info(`[PatSync] 🔍 Processando tarefa ${mainProtocol}...`);

            // 1. Navegar para Detalhes
            const urlDetalhes = `https://atendimento.inss.gov.br/tarefas/detalhar_tarefa/${mainProtocol}`;
            await page.goto(urlDetalhes, { waitUntil: 'networkidle2' });

            // 2. Extrair Dados Gerais
            const dadosGerais = await this.extrairDadosGerais();
            logger.info(`[PatSync] Dados Gerais: ${dadosGerais?.nome} - ${dadosGerais?.situacao}`);

            // 3. Extrair Histórico
            const historico = await this.extrairHistorico();
            if (historico?.temExigencia) {
                logger.warn(`[PatSync] ⚠️ Exigência detectada no histórico!`);
            }

            // 4. Identificar e Processar Agendamentos
            let agendamentoResult = null;

            const dadosAgendamento = await page.evaluate(() => {
                const containers = Array.from(document.querySelectorAll('.dtp-detalhamento-container'));
                for (const container of containers) {
                    const titulo = container.querySelector('h3, h4')?.textContent?.toUpperCase() || '';
                    const isPericia = titulo.includes('PERÍCIA') || titulo.includes('PERICIA');
                    const isSocial = titulo.includes('SOCIAL') || titulo.includes('AVALIAÇÃO');

                    if (isPericia || isSocial) {
                        const etapa = container.querySelector('#sag-etapa')?.textContent || '';
                        if (!etapa.includes('Aguardando comparecimento')) continue;

                        const rows = Array.from(container.querySelectorAll('table tbody tr'));
                        for (const row of rows) {
                            if (row.textContent?.includes('AGENDADO')) {
                                const btn = row.querySelector('#btn-detalhar, button.btn-primary') as HTMLElement;
                                if (btn) {
                                    btn.click();
                                    return { found: true, tipo: isPericia ? 'PERICIA' : 'SOCIAL' };
                                }
                            }
                        }
                    }
                }
                return { found: false, tipo: null };
            });

            if (dadosAgendamento.found) {
                await page.waitForNavigation({ waitUntil: 'networkidle2' });

                const currentUrl = page.url();
                const match = currentUrl.match(/\/agendamento\/(?:pmf\/)?(\d+)/);

                if (match && match[1]) {
                    const subProtocoloId = match[1];

                    const detalhes = await page.evaluate(() => {
                        const labels = Array.from(document.querySelectorAll('label'));
                        let dataHora = '';
                        let endereco = '';
                        let unidade = '';

                        labels.forEach(label => {
                            const text = label.textContent?.trim().toUpperCase() || '';
                            const value = label.parentElement?.textContent?.replace(text, '').trim() || '';
                            if (text.includes('DATA') && text.includes('HORA')) dataHora = value;
                            if (text.includes('ENDEREÇO') || text.includes('ENDERECO')) endereco = value;
                            if (text.includes('UNIDADE')) unidade = value;
                        });
                        return { dataHora, endereco, unidade };
                    });

                    const sucessoDownload = await this.baixarComprovante(
                        subProtocoloId,
                        cpf,
                        dadosAgendamento.tipo as 'PERICIA' | 'SOCIAL',
                        token
                    );

                    agendamentoResult = {
                        subProtocolo: subProtocoloId,
                        dataHora: detalhes.dataHora,
                        unidade: detalhes.unidade,
                        endereco: detalhes.endereco,
                        tipo: dadosAgendamento.tipo as 'PERICIA' | 'SOCIAL',
                        comprovanteSalvo: sucessoDownload
                    };
                }
            }

            return {
                dadosGerais,
                agendamento: agendamentoResult,
                historico
            };

        } catch (error: any) {
            logger.error(`[PatSync] Erro ao processar tarefa ${mainProtocol}: ${error.message}`);
            return null;
        }
    }

    /**
     * Baixa o comprovante PDF via Fetch Injection
     */
    async baixarComprovante(
        subId: string,
        cpf: string,
        tipo: 'PERICIA' | 'SOCIAL',
        token: string
    ): Promise<boolean> {
        const page = puppeteerService.getPage();
        if (!page) return false;

        try {
            logger.info(`[PatSync] 📥 Baixando comprovante para ${subId}...`);

            const endpoint = tipo === 'PERICIA'
                ? `https://atendimento.inss.gov.br/apis/PericiaService/agendamento/v2/${subId}/comprovante?cpf=${cpf}`
                : `https://atendimento.inss.gov.br/apis/consolidadorApi/agendamento/${subId}/comprovante?cpf=${cpf}`;

            const pdfBase64 = await page.evaluate(async (url, authToken) => {
                try {
                    const response = await fetch(url, {
                        method: 'GET',
                        headers: {
                            'Authorization': `Bearer ${authToken}`,
                            'Accept': 'application/json, application/pdf'
                        }
                    });

                    if (!response.ok) throw new Error(`HTTP ${response.status}`);

                    const buffer = await response.arrayBuffer();
                    let binary = '';
                    const bytes = new Uint8Array(buffer);
                    const len = bytes.byteLength;
                    for (let i = 0; i < len; i++) {
                        binary += String.fromCharCode(bytes[i]);
                    }
                    return btoa(binary);

                } catch (e: any) {
                    console.error('Erro no download:', e);
                    return null;
                }
            }, endpoint, token);

            if (!pdfBase64) {
                logger.error(`[PatSync] ❌ Falha no download do PDF`);
                return false;
            }

            const buffer = Buffer.from(pdfBase64, 'base64');
            const filename = `comprovante_${tipo}_${subId}_${cpf}.pdf`;
            const filepath = path.join(this.downloadPath, filename);

            fs.writeFileSync(filepath, buffer);
            logger.info(`[PatSync] ✅ Comprovante salvo em: ${filepath}`);

            return true;

        } catch (error: any) {
            logger.error(`[PatSync] Erro ao baixar comprovante: ${error.message}`);
            return false;
        }
    }
}

export default new PatSyncService();
