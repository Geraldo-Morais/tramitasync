/**
 * SERVIÇO DE SINCRONIZAÇÃO COM TRAMITAÇÃO INTELIGENTE
 * 
 * Responsável por:
 * 1. Gerar email exclusivo do cliente no Tramitação
 * 2. Adicionar/remover tags
 * 3. Adicionar observações/notas
 * 4. Sincronizar status bidirecional
 */

import puppeteer, { Browser, Page, Protocol } from 'puppeteer';
import logger from '../utils/logger';
import database from '../database';
import config from '../config';
import puppeteerService from './PuppeteerService';

interface SyncResult {
    success: boolean;
    data?: any;
    error?: string;
}

class TramitacaoSyncService {
    private browser: Browser | null = null;
    private page: Page | null = null;
    private isAuthenticated = false;
    private usingExternalBrowser = false;
    private csrfToken: string | null = null;
    private cookies: Protocol.Network.Cookie[] = [];
    private storedEmail: string | null = null;
    private storedPassword: string | null = null;

    /**
     * Inicializa uma nova aba no browser do PuppeteerService para operações do Tramitação
     * Isso garante isolamento: cada job SaaS tem seu próprio browser com abas separadas (INSS + Tramitação)
     * @param email Email do Tramitação (opcional, usa config se não fornecido)
     * @param password Senha do Tramitação (opcional, usa config se não fornecida)
     */
    async initialize(email?: string, password?: string): Promise<void> {
        try {
            // Armazenar credenciais se fornecidas
            if (email && password) {
                this.storedEmail = email;
                this.storedPassword = password;
            }

            // Tentar usar o browser do PuppeteerService
            const browser = puppeteerService.getBrowser();

            if (browser) {
                logger.info('[TramitacaoSync] 🌐 Criando nova aba no browser do PuppeteerService...');
                this.browser = browser;
                this.usingExternalBrowser = true;

                // Criar nova aba dedicada para Tramitação
                this.page = await this.browser.newPage();
                await this.page.setViewport({
                    width: 1366,
                    height: 768,
                    deviceScaleFactor: 1
                });

                logger.info('[TramitacaoSync] ✅ Nova aba criada com sucesso');
            } else {
                // Fallback: criar browser próprio (não deve acontecer em produção SaaS)
                logger.warn('[TramitacaoSync] ⚠️ PuppeteerService não disponível, criando browser próprio...');
                this.usingExternalBrowser = false;

                this.browser = await puppeteer.launch({
                    headless: config.inss.headless,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-gpu',
                        '--disable-web-security',
                        '--disable-features=IsolateOrigins,site-per-process',
                        '--window-size=1366,768'
                    ]
                });

                this.page = await this.browser.newPage();
                await this.page.setViewport({
                    width: 1366,
                    height: 768,
                    deviceScaleFactor: 1
                });
            }

            if (!this.page) {
                throw new Error('Falha ao criar página do navegador');
            }

            await this.page.setUserAgent(
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            );

            // Usar credenciais fornecidas ou armazenadas
            const loginEmail = email || this.storedEmail || undefined;
            const loginPassword = password || this.storedPassword || undefined;

            // Fazer login no Tramitação com credenciais
            await this.login(loginEmail, loginPassword);

            // Extrair cookies e CSRF token após login bem-sucedido
            await this.extractAuthData();

            logger.info('[TramitacaoSync] ✅ Aba do Tramitação inicializada e autenticada');
        } catch (error) {
            logger.error('[TramitacaoSync] Erro ao inicializar:', error);
            await this.close();
            throw error;
        }
    }

    /**
     * Verifica se já está logado no Tramitação
     */
    private async verificarSeEstaLogado(): Promise<boolean> {
        if (!this.page) return false;

        try {
            const urlAtual = this.page.url();
            if (urlAtual.includes('/usuarios/login') || urlAtual.includes('/login')) {
                return false;
            }

            // Tentar acessar página de clientes
            await this.page.goto('https://planilha.tramitacaointeligente.com.br/clientes', {
                waitUntil: 'networkidle2',
                timeout: 15000
            });

            await this.page.waitForTimeout(2000);

            const urlAposNavegacao = this.page.url();
            if (urlAposNavegacao.includes('/usuarios/login') || urlAposNavegacao.includes('/login')) {
                return false;
            }

            return true;
        } catch (error: any) {
            logger.warn(`[TramitacaoSync] ⚠️ Erro ao verificar login: ${error.message}`);
            return false;
        }
    }

    /**
     * Faz login no Tramitação
     */
    private async login(email?: string, password?: string): Promise<void> {
        if (!this.page) throw new Error('Page não inicializada');

        try {
            const jaLogado = await this.verificarSeEstaLogado();
            if (jaLogado) {
                this.isAuthenticated = true;
                logger.info('[TramitacaoSync] ✅ Já estava logado, pulando processo de login');
                return;
            }

            logger.info('[TramitacaoSync] Não está logado, fazendo login...');

            await this.page.goto('https://planilha.tramitacaointeligente.com.br/usuarios/login', {
                waitUntil: 'networkidle2',
                timeout: 30000
            });

            logger.info('[TramitacaoSync] Página de login carregada, preenchendo credenciais...');

            await this.page.waitForXPath('/html/body/div/div[2]/div/div/form/div[1]/input', { timeout: 10000 });

            if (!email || !password) {
                throw new Error('Credenciais do Tramitação são obrigatórias. Configure email e senha nas configurações da extensão.');
            }

            // Preencher email
            const emailField = await this.page.$x('/html/body/div/div[2]/div/div/form/div[1]/input');
            if (emailField.length === 0) {
                throw new Error('Campo de email não encontrado');
            }
            const emailElement = emailField[0] as any;
            await emailElement.click();
            await this.page.waitForTimeout(200);

            await this.page.keyboard.down('Control');
            await this.page.keyboard.press('KeyA');
            await this.page.keyboard.up('Control');
            await this.page.waitForTimeout(100);

            for (let i = 0; i < email.length; i++) {
                await this.page.keyboard.type(email[i], { delay: 100 });
                await this.page.waitForTimeout(50);
            }
            logger.info('[TramitacaoSync] ✅ Email preenchido');

            // Preencher senha
            const passwordField = await this.page.$x('/html/body/div/div[2]/div/div/form/div[2]/input');
            if (passwordField.length === 0) {
                throw new Error('Campo de senha não encontrado');
            }
            const passwordElement = passwordField[0] as any;
            await passwordElement.click();
            await this.page.waitForTimeout(200);

            await this.page.keyboard.down('Control');
            await this.page.keyboard.press('KeyA');
            await this.page.keyboard.up('Control');
            await this.page.waitForTimeout(100);

            for (let i = 0; i < password.length; i++) {
                await this.page.keyboard.type(password[i], { delay: 100 });
                await this.page.waitForTimeout(50);
            }
            logger.info('[TramitacaoSync] ✅ Senha preenchida');

            // Aguardar o botão de login ficar visível e clicável
            await this.page.waitForSelector('[data-test="login_btn"]', { visible: true, timeout: 5000 });
            logger.info('[TramitacaoSync] 🔍 Botão de login encontrado, clicando...');

            // Clicar no botão usando o atributo data-test (mais confiável)
            await this.page.click('[data-test="login_btn"]');
            logger.info('[TramitacaoSync] ✅ Botão de login clicado');

            // Aguardar navegação
            await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => { });
            await this.page.waitForTimeout(3000);

            // Verificar se login foi bem-sucedido
            const urlAposLogin = this.page.url();
            if (urlAposLogin.includes('/usuarios/login') || urlAposLogin.includes('/login')) {
                throw new Error('Falha no login - credenciais inválidas ou botão não foi clicado');
            }

            this.isAuthenticated = true;
            logger.info('[TramitacaoSync] ✅ Login realizado com sucesso');
        } catch (error: any) {
            logger.error(`[TramitacaoSync] Erro no login: ${error.message}`);
            throw error;
        }
    }

    /**
     * Extrai cookies e CSRF token após login
     */
    private async extractAuthData(): Promise<void> {
        if (!this.page) return;

        try {
            this.cookies = await this.page.cookies();

            // Extrair CSRF token do meta tag
            const csrfToken = await this.page.evaluate(() => {
                const meta = document.querySelector('meta[name="csrf-token"]');
                return meta ? meta.getAttribute('content') : null;
            });

            if (csrfToken) {
                this.csrfToken = csrfToken;
                logger.info('[TramitacaoSync] ✅ CSRF Token extraído');
            }
        } catch (error: any) {
            logger.warn(`[TramitacaoSync] ⚠️ Erro ao extrair dados de autenticação: ${error.message}`);
        }
    }

    /**
     * Retorna string de cookies para requisições fetch
     */
    private getCookieHeader(): string {
        return this.cookies.map(c => `${c.name}=${c.value}`).join('; ');
    }

    /**
     * Gera email exclusivo para cliente
     */
    async gerarEmailExclusivo(
        clienteId: string | number,
        nomeCliente: string,
        tramitacaoEmail?: string,
        tramitacaoPassword?: string
    ): Promise<SyncResult> {
        try {
            if (!this.page || !this.isAuthenticated) {
                const loginEmail = tramitacaoEmail || this.storedEmail;
                const loginPassword = tramitacaoPassword || this.storedPassword;

                if (!loginEmail || !loginPassword) {
                    throw new Error('Credenciais do Tramitação são obrigatórias.');
                }

                await this.initialize(loginEmail, loginPassword);
            }

            // Gerar slug do nome do cliente (para construir URL correta)
            const slug = nomeCliente
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '') // Remove acentos
                .replace(/[^a-z0-9]+/g, '-') // Substitui não-alfanuméricos por hífen
                .replace(/^-+|-+$/g, ''); // Remove hífens no início/fim

            // Rota correta: /clientes/{id}-{slug}/emails/address
            const urlEmailGenerate = `https://planilha.tramitacaointeligente.com.br/clientes/${clienteId}-${slug}/emails/address`;

            logger.info(`[TramitacaoSync] 🌐 Navegando para: ${urlEmailGenerate}`);

            await this.page!.goto(urlEmailGenerate, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await this.page!.waitForTimeout(2000);

            // Gerar email usando fetch injection com FormData (não JSON)
            const resultado = await this.page!.evaluate(async (csrf) => {
                try {
                    const formData = new FormData();
                    formData.append('authenticity_token', csrf || '');

                    const response = await fetch(window.location.href, {
                        method: 'POST',
                        headers: {
                            'X-CSRF-Token': csrf || '',
                            'Accept': 'text/vnd.turbo-stream.html, text/html, application/xhtml+xml'
                        },
                        body: formData,
                        credentials: 'include'
                    });

                    if (!response.ok) {
                        return { success: false, error: `HTTP ${response.status}` };
                    }

                    const html = await response.text();

                    // Extrair email do HTML Turbo Stream
                    // Formatos possíveis: @timails.org, @timail.com.br, @tiemails.com
                    const emailMatch = html.match(/value="([^"]+@ti(?:e?mails?)\.[^"]+)"/i);

                    if (emailMatch) {
                        return { success: true, email: emailMatch[1] };
                    } else {
                        // Fallback: Tentar encontrar qualquer email no HTML
                        const fallbackMatch = html.match(/([a-z0-9._-]+@[a-z0-9._-]+\.[a-z]{2,})/i);
                        if (fallbackMatch) {
                            return { success: true, email: fallbackMatch[1] };
                        }
                        return { success: false, error: 'Email não encontrado na resposta' };
                    }
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }, this.csrfToken);

            if (resultado.success) {
                logger.info(`[TramitacaoSync] ✅ Email gerado: ${resultado.email}`);
            }

            return resultado;
        } catch (error: any) {
            logger.error(`[TramitacaoSync] Erro ao gerar email: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    /**
     * Cria um novo cliente via Fetch Injection
     */
    async criarCliente(dados: {
        nome: string;
        cpf: string;
        telefone: string;
        email: string;
    }, tramitacaoEmail?: string, tramitacaoPassword?: string): Promise<number | null> {
        try {
            logger.info(`[TramitacaoSync] 🆕 Criando cliente "${dados.nome}" via API Interna...`);

            if (!this.page || !this.isAuthenticated) {
                const loginEmail = tramitacaoEmail || this.storedEmail;
                const loginPassword = tramitacaoPassword || this.storedPassword;

                if (!loginEmail || !loginPassword) {
                    throw new Error('Credenciais do Tramitação são obrigatórias. Configure email e senha nas configurações da extensão.');
                }

                await this.initialize(loginEmail, loginPassword);
            }

            // Verificar se está logado
            const urlAtual = this.page!.url();
            if (urlAtual.includes('/usuarios/login') || urlAtual.includes('/login')) {
                logger.warn('[TramitacaoSync] ⚠️ Detectado na página de login, tentando fazer login novamente...');
                const loginEmail = tramitacaoEmail || this.storedEmail;
                const loginPassword = tramitacaoPassword || this.storedPassword;
                await this.login(loginEmail || undefined, loginPassword || undefined);
                await this.extractAuthData();
            }

            // Navegar para lista de clientes
            if (!this.page!.url().includes('/clientes')) {
                await this.page!.goto('https://planilha.tramitacaointeligente.com.br/clientes', {
                    waitUntil: 'domcontentloaded',
                    timeout: 30000
                });
                await this.page!.waitForTimeout(1000);
            }

            const cookieHeader = this.getCookieHeader();
            const csrfToken = this.csrfToken;

            const resultado = await this.page!.evaluate(async (nome, cpf, tel, email, cookieHdr, csrf) => {
                try {
                    if (!csrf) {
                        return { success: false, error: 'Token CSRF não disponível' };
                    }

                    const formData = new FormData();
                    formData.append('authenticity_token', csrf);
                    formData.append('customer[name]', nome);
                    formData.append('customer[cpf_cnpj]', cpf);
                    formData.append('customer[phone_mobile]', tel);
                    formData.append('customer[email]', email);
                    formData.append('customer[status]', 'active');

                    const response = await fetch('/clientes', {
                        method: 'POST',
                        headers: {
                            'X-CSRF-Token': csrf,
                            'Cookie': cookieHdr
                        },
                        body: formData,
                        credentials: 'include'
                    });

                    const finalUrl = response.url;
                    const match = finalUrl.match(/\/clientes\/(\d+)-/);
                    if (match && match[1]) {
                        return { success: true, id: parseInt(match[1]) };
                    } else {
                        return { success: false, error: 'Falha ao extrair ID. URL: ' + finalUrl };
                    }
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }, dados.nome, dados.cpf, dados.telefone, dados.email, cookieHeader, csrfToken);

            if (resultado.success && resultado.id) {
                logger.info(`[TramitacaoSync] ✅ Cliente criado com sucesso! ID: ${resultado.id}`);
                return Number(resultado.id);
            } else {
                logger.error(`[TramitacaoSync] ❌ Falha ao criar cliente: ${resultado.error}`);
                return null;
            }

        } catch (error: any) {
            logger.error(`[TramitacaoSync] Erro ao criar cliente: ${error.message}`);
            return null;
        }
    }

    /**
     * Cadastra uma atividade no Tramitação
     */
    async cadastrarAtividade(
        clienteId: string | number,
        agendamento: {
            tipo: 'PERICIA' | 'AVALIACAO_SOCIAL';
            data: Date;
            hora: string;
            unidade: string;
            endereco?: string;
            servico?: string;
            urlComprovante?: string;
        },
        tramitacaoEmail?: string,
        tramitacaoPassword?: string
    ): Promise<number | null> {
        try {
            logger.info(`[TramitacaoSync] 🚀 Cadastrando atividade via API Interna para cliente ${clienteId}...`);

            if (!this.page || !this.isAuthenticated) {
                const loginEmail = tramitacaoEmail || this.storedEmail;
                const loginPassword = tramitacaoPassword || this.storedPassword;

                if (!loginEmail || !loginPassword) {
                    throw new Error('Credenciais do Tramitação são obrigatórias. Configure email e senha nas configurações da extensão.');
                }

                await this.initialize(loginEmail, loginPassword);
            }

            // Navegar para página do cliente
            const urlCliente = `https://planilha.tramitacaointeligente.com.br/clientes/${clienteId}`;
            if (!this.page!.url().includes(String(clienteId))) {
                await this.page!.goto(urlCliente, { waitUntil: 'domcontentloaded' });
                await this.page!.waitForTimeout(1000);
            }

            const titulo = agendamento.tipo === 'PERICIA' ? 'PERÍCIA MÉDICA' : 'AVALIAÇÃO SOCIAL';
            const observacao = this.gerarObservacaoAtividade(agendamento);

            // Formatar data
            const dataObj = new Date(agendamento.data);
            const [hora, minuto] = agendamento.hora.split(':').map(Number);
            dataObj.setHours(hora, minuto, 0, 0);

            const toIsoStringWithOffset = (date: Date) => {
                const pad = (num: number) => (num < 10 ? '0' : '') + num;
                return date.getFullYear() +
                    '-' + pad(date.getMonth() + 1) +
                    '-' + pad(date.getDate()) +
                    'T' + pad(date.getHours()) +
                    ':' + pad(date.getMinutes()) +
                    ':00-03:00';
            };

            const startIso = toIsoStringWithOffset(dataObj);
            const csrfToken = this.csrfToken;

            const resultado = await this.page!.evaluate(async (cid, tit, obs, startIso, csrf) => {
                try {
                    const uuidv4 = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
                        const r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
                        return v.toString(16);
                    });

                    const payload = {
                        activity: {
                            uuid: uuidv4(),
                            title: tit,
                            start: startIso,
                            all_day: false,
                            type_id: 1,
                            customer_id: cid,
                            body: obs
                        }
                    };

                    const response = await fetch('/atividades', {
                        method: 'POST',
                        headers: {
                            'X-CSRF-Token': csrf || '',
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(payload),
                        credentials: 'include'
                    });

                    if (response.ok) {
                        const data = await response.json();
                        return { success: true, id: data.id };
                    } else {
                        return { success: false, error: `HTTP ${response.status}` };
                    }
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }, clienteId, titulo, observacao, startIso, csrfToken);

            if (resultado.success && resultado.id) {
                logger.info(`[TramitacaoSync] ✅ Atividade cadastrada! ID: ${resultado.id}`);
                return resultado.id;
            } else {
                logger.error(`[TramitacaoSync] ❌ Falha ao cadastrar atividade: ${resultado.error}`);
                return null;
            }

        } catch (error: any) {
            logger.error(`[TramitacaoSync] Erro ao cadastrar atividade: ${error.message}`);
            return null;
        }
    }

    /**
     * Gera observação para atividade
     */
    private gerarObservacaoAtividade(agendamento: any): string {
        let obs = `📅 ${agendamento.tipo === 'PERICIA' ? 'PERÍCIA MÉDICA' : 'AVALIAÇÃO SOCIAL'} AGENDADA\n\n`;
        obs += `📍 Local: ${agendamento.unidade || 'Não informado'}\n`;
        if (agendamento.endereco) {
            obs += `📌 Endereço: ${agendamento.endereco}\n`;
        }
        obs += `⏰ Horário: ${agendamento.hora}\n`;
        if (agendamento.urlComprovante) {
            obs += `\n📎 Comprovante: ${agendamento.urlComprovante}`;
        }
        return obs;
    }

    /**
     * Verifica se já existe atividade com mesma data
     */
    async verificarAtividadeExistente(
        clienteId: string | number,
        data: Date,
        tipo: 'PERICIA' | 'AVALIACAO_SOCIAL',
        tramitacaoEmail?: string,
        tramitacaoPassword?: string
    ): Promise<boolean> {
        if (!this.page || !this.isAuthenticated) {
            const loginEmail = tramitacaoEmail || this.storedEmail;
            const loginPassword = tramitacaoPassword || this.storedPassword;

            if (!loginEmail || !loginPassword) {
                logger.warn('[TramitacaoSync] ⚠️ Credenciais não disponíveis para verificar atividade. Retornando false.');
                return false;
            }

            await this.initialize(loginEmail, loginPassword);
        }

        try {
            const urlCliente = `https://planilha.tramitacaointeligente.com.br/clientes/${clienteId}`;
            if (!this.page!.url().includes(String(clienteId))) {
                await this.page!.goto(urlCliente, { waitUntil: 'domcontentloaded' });
                await this.page!.waitForTimeout(2000);
            }

            const dataFormatada = data.toLocaleDateString('pt-BR');
            const tipoTexto = tipo === 'PERICIA' ? 'PERÍCIA' : 'AVALIAÇÃO';

            const existe = await this.page!.evaluate((dataStr, tipoTexto) => {
                const body = document.body.textContent?.toUpperCase() || '';
                return body.includes(dataStr) && body.includes(tipoTexto);
            }, dataFormatada, tipoTexto);

            return existe;
        } catch (error: any) {
            logger.warn(`[TramitacaoSync] ⚠️ Erro ao verificar atividade existente: ${error.message}`);
            return false;
        }
    }


    /**
     * Fecha a aba/browser
     */
    async close(): Promise<void> {
        try {
            if (this.page) {
                await this.page.close().catch(() => { });
                this.page = null;
            }

            if (this.browser && !this.usingExternalBrowser) {
                await this.browser.close().catch(() => { });
                this.browser = null;
            }

            this.isAuthenticated = false;
        } catch (error) {
            // Ignorar erros no fechamento
        }
    }
}

const tramitacaoSyncService = new TramitacaoSyncService();
export default tramitacaoSyncService;
