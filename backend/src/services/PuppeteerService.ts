import puppeteer, { Browser, Page } from 'puppeteer';
import config from '../config';
import logger from '../utils/logger';
import { format, parse, addDays } from 'date-fns';

interface ProcessoINSS {
    protocolo: string;
    cpf: string;
    nome: string;
    beneficio: string;
    der: Date;
    status: string;
    textoCompleto: string;
}

interface ComentarioExigencia {
    data: Date;
    texto: string;
    prazo?: Date; // Data calculada (data + 30 dias)
}

interface AgendamentoExtraido {
    id: string;
    tipo: 'PERICIA' | 'AVALIACAO_SOCIAL';
    data: Date;
    hora: string;
    unidade: string;
    endereco?: string;
    status: 'AGENDADO' | 'REMARCADO' | 'CANCELADO' | 'CUMPRIDO';
    servico?: string;
    urlComprovante?: string;
}

interface ProtocoloDetalhado {
    // Metadados da busca
    filtroAplicado: {
        dataInicio: Date;
        dataFim: Date;
        status: string;
    };

    // Dados b�sicos extra�dos
    protocolo: string;
    cpf: string;
    nome: string;
    servico: string; // Tipo de benef�cio
    dataSolicitacao: Date; // DER
    statusAtual: string;
    dataNascimento?: string; // Formato: DD/MM/YYYY

    // Coment�rios/Exig�ncias (ordem cronol�gica: mais antigo ? mais recente)
    comentarios: ComentarioExigencia[];

    // Agendamentos extra�dos (per�cias e avalia��es)
    agendamentos: AgendamentoExtraido[];

    // HTML bruto completo para IA processar depois
    htmlCompleto: string;
}

/**
 * Servi�o de Web Scraping do INSS
 * Respons�vel por navegar no sistema INSS e extrair dados dos protocolos
 * Adaptado do script Tampermonkey fornecido pelo usu�rio
 */
export class PuppeteerService {
    private browser: Browser | null = null;
    private page: Page | null = null;
    private ultimoTokenPat: string | null = null; // Armazena o último token PAT usado para reutilizar
    private readonly defaultViewport = {
        width: 1366,
        height: 768,
        deviceScaleFactor: 1
    };
    private readonly defaultUserAgent =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    /**
     * Inicializa o navegador Puppeteer
     * Op��o 1: Usa seu Chrome com perfil existente (sess�es, senhas, etc)
     * Op��o 2: Navegador limpo (padr�o)
     */
    async initialize(): Promise<void> {
        try {
            logger.info('[Puppeteer] Iniciando navegador...');

            // ?? OP��O 1: Conectar ao Chrome j� aberto via Remote Debugging
            // Para usar: Abra seu Chrome com: chrome.exe --remote-debugging-port=9222
            // Para SaaS: sempre usar headless (navegador limpo)
            // Remote debugging só é útil para desenvolvimento local
            const usarChromeExistente = false; // Sempre false para SaaS - usar headless sempre

            if (usarChromeExistente) {
                logger.info('[Puppeteer] +--------------------------------------------------------------+');
                logger.info('[Puppeteer] �  ?? CONECTANDO AO SEU CHROME J� ABERTO!                     �');
                logger.info('[Puppeteer] �                                                              �');
                logger.info('[Puppeteer] �  ?? PASSO A PASSO:                                           �');
                logger.info('[Puppeteer] �  1. Feche TODAS as janelas do Chrome                         �');
                logger.info('[Puppeteer] �  2. Abra o PowerShell e rode:                                �');
                logger.info('[Puppeteer] �                                                              �');
                logger.info('[Puppeteer] �     & "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 �');
                logger.info('[Puppeteer] �                                                              �');
                logger.info('[Puppeteer] �  3. Use normalmente (login, sess�es salvas funcionam!)       �');
                logger.info('[Puppeteer] �  4. Script vai conectar automaticamente                      �');
                logger.info('[Puppeteer] +--------------------------------------------------------------+');

                try {
                    // Verificar se a porta está acessível antes de tentar conectar
                    logger.info('[Puppeteer] Verificando se Chrome está acessível na porta 9222...');
                    const http = require('http');
                    await new Promise<void>((resolve, reject) => {
                        const req = http.get('http://127.0.0.1:9222/json/version', (res: any) => {
                            resolve();
                        });
                        req.on('error', (err: any) => {
                            reject(err);
                        });
                        req.setTimeout(3000, () => {
                            req.destroy();
                            reject(new Error('Timeout ao verificar porta 9222'));
                        });
                    });
                    logger.info('[Puppeteer] ✅ Porta 9222 está acessível, conectando...');

                    // Tentar conectar ao Chrome existente com timeout
                    logger.info('[Puppeteer] Conectando ao Chrome (timeout: 10s)...');
                    const connectPromise = puppeteer.connect({
                        browserURL: 'http://127.0.0.1:9222',
                        defaultViewport: null
                    });

                    const timeoutPromise = new Promise((_, reject) => {
                        setTimeout(() => reject(new Error('Timeout ao conectar ao Chrome (10s)')), 10000);
                    });

                    this.browser = await Promise.race([connectPromise, timeoutPromise]) as any;
                    logger.info('[Puppeteer] ✅ Conectado ao seu Chrome!');
                } catch (connectError: any) {
                    logger.error('[Puppeteer] ? N�o conseguiu conectar ao Chrome na porta 9222');
                    logger.error('[Puppeteer] ?? Certifique-se que o Chrome est� rodando com:');
                    logger.error('[Puppeteer]    & "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222');
                    throw new Error('Chrome n�o est� rodando com remote debugging. Siga as instru��es acima.');
                }
            } else {
                // Fallback: navegador limpo
                logger.info('[Puppeteer] ?? Usando navegador padr�o (Puppeteer)');

                // Modo SaaS: navegador headless (sem interface gráfica)
                // Mas permite modo visível para debug se DEBUG_VISIBLE=true
                const modoVisivel = process.env.DEBUG_VISIBLE === 'true';
                const headlessMode = !modoVisivel;

                if (modoVisivel) {
                    logger.info('[Puppeteer] 👁️ MODO DEBUG: Navegador VISÍVEL (para acompanhar o processo)');
                    logger.info('[Puppeteer] 👁️ Você verá o navegador abrir e poderá acompanhar cada passo');
                } else {
                    logger.info('[Puppeteer] ⚙️ Usando navegador headless (modo SaaS)');
                    logger.info('[Puppeteer] 💡 Para ver o navegador, defina DEBUG_VISIBLE=true no .env');
                }

                this.browser = await puppeteer.launch({
                    headless: headlessMode,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        ...(headlessMode ? ['--disable-gpu'] : []),
                        '--disable-web-security',
                        '--disable-features=IsolateOrigins,site-per-process',
                        ...(modoVisivel ? ['--start-maximized'] : [])
                    ],
                });
            }

            // Quando conecta ao Chrome existente, criar uma NOVA aba e navegar diretamente
            if (usarChromeExistente && this.browser) {
                logger.info('[Puppeteer] 📑 Criando nova aba no Chrome...');
                this.page = await this.browser.newPage();

                // 🔧 Aplicar Anti-Throttling IMEDIATAMENTE após criar a página
                // Isso garante que os scripts sejam injetados antes da navegação
                if (this.page) {
                    await this.forcarPaginaSempreAtiva();
                }

                // Construir URL com token ANTES de navegar
                const token = config.inss.accessToken;
                if (token && token !== '' && token !== 'seu_token_aqui') {
                    const hasParams = token.includes('&token_type=bearer');
                    const loginUrl = hasParams
                        ? `${config.inss.url}#access_token=${token}`
                        : `${config.inss.url}#access_token=${token}&token_type=bearer`;

                    logger.info('[Puppeteer] 🌐 Navegando diretamente para URL autenticada na nova aba...');
                    try {
                        await this.page.goto(loginUrl, {
                            waitUntil: 'domcontentloaded',
                            timeout: 30000
                        });
                        logger.info('[Puppeteer] ✅ Navegação inicial concluída!');
                    } catch (error: any) {
                        logger.warn(`[Puppeteer] ⚠️ Erro ao navegar na inicialização: ${error.message}`);
                        logger.warn('[Puppeteer] ⚠️ Continuando mesmo assim - login() vai tentar novamente...');
                    }
                } else {
                    logger.warn('[Puppeteer] ⚠️ Token não configurado - navegando para URL base...');
                    try {
                        await this.page.goto(config.inss.url, {
                            waitUntil: 'domcontentloaded',
                            timeout: 30000
                        });
                    } catch (error: any) {
                        logger.warn(`[Puppeteer] ⚠️ Erro ao navegar: ${error.message}`);
                    }
                }
            } else {
                // Quando usa navegador limpo, pega a primeira página
                if (!this.browser) {
                    throw new Error('Browser não foi inicializado');
                }
                const pages = await this.browser.pages();
                this.page = pages.length > 0 ? pages[0] : await this.browser.newPage();

                // 🔧 Aplicar Anti-Throttling também no navegador limpo
                if (this.page) {
                    await this.forcarPaginaSempreAtiva();
                }
            }

            if (!this.page) {
                throw new Error('Página principal não foi inicializada');
            }

            await this.configurarPaginaPadrao(this.page);

            logger.info('[Puppeteer] Navegador iniciado com sucesso');
        } catch (error) {
            logger.error('[Puppeteer] Erro ao inicializar navegador:', error);
            throw error;
        }
    }


    private async configurarPaginaPadrao(page: Page): Promise<void> {
        try {
            if (!config.inss.useExistingChrome) {
                await page.setViewport(this.defaultViewport);
            }
            await page.setUserAgent(this.defaultUserAgent);
        } catch (error) {
            logger.warn('[Puppeteer] Não foi possível aplicar viewport/user-agent padrão:', error);
        }
    }

    private async validarPosLogin(): Promise<void> {
        if (!this.page) return;
        const urlAposNavegacao = this.page.url();
        logger.info(`[Puppeteer] URL após navegação: ${urlAposNavegacao}`);

        if (urlAposNavegacao.includes('login') ||
            urlAposNavegacao.includes('auth') ||
            urlAposNavegacao.includes('autenticacao') ||
            (!urlAposNavegacao.includes('atendimento.inss.gov.br') && urlAposNavegacao.includes('gov.br'))) {
            const erro = 'Token PAT expirado ou inválido. Por favor, faça login no PAT novamente.';
            logger.error(`[Puppeteer] ❌ ${erro}`);
            logger.error(`[Puppeteer] URL indica redirecionamento para login: ${urlAposNavegacao}`);
            throw new Error(erro);
        }
    }

    private async tratarTelaErroLogin(loginUrl: string): Promise<void> {
        if (!this.page) return;
        const erroInicial = await this.detectarErroLoginPat();
        if (!erroInicial) {
            return;
        }
        await this.page.waitForTimeout(2000);
        if (await this.detectarErroLoginPat()) {
            logger.warn('[Puppeteer] ⚠️ Tela "LOGIN - PAT" detectada após navegação. Tentando reabrir a guia...');
            await this.recuperarTelaErroPat(loginUrl);
        }
    }

    private async detectarErroLoginPat(): Promise<boolean> {
        if (!this.page) return false;
        try {
            return await this.page.evaluate(() => {
                const texto = (document.body?.innerText || '').toLowerCase();
                const headers = Array.from(document.querySelectorAll('.dtp-datagrid-header, .dtp-datagrid h3'))
                    .map((el) => el.textContent?.trim().toLowerCase() || '');
                const possuiTituloLogin = headers.some((titulo) => titulo.includes('login - pat'));
                const mensagemErro = texto.includes('não foi possível autenticar o usuário');
                return possuiTituloLogin || mensagemErro;
            });
        } catch {
            return false;
        }
    }

    private async reabrirPaginaPat(loginUrl: string, tentativa: number): Promise<void> {
        if (!this.browser) {
            throw new Error('Browser não foi inicializado');
        }

        logger.warn(`[Puppeteer] Reabrindo guia do PAT (tentativa ${tentativa})...`);

        const paginaAnterior = this.page;
        const novaPagina = await this.browser.newPage();
        this.page = novaPagina;
        await this.configurarPaginaPadrao(this.page);
        await this.forcarPaginaSempreAtiva();

        if (paginaAnterior) {
            try {
                await paginaAnterior.close();
            } catch {
                // Ignorar erros ao fechar aba anterior
            }
        }

        // Em modo SaaS, sempre usar goto() diretamente (omnibox não funciona)
        const usarChromeExistente = false; // Sempre false para SaaS
        let navegouComOmnibox = false;

        if (usarChromeExistente) {
            logger.info('[Puppeteer] 🔁 Tentando omnibox após reabrir guia...');
            navegouComOmnibox = await this.navegarViaOmnibox(loginUrl);
        }

        if (!navegouComOmnibox && this.page) {
            logger.info('[Puppeteer] 🌐 Navegando diretamente com page.goto()...');
            await this.page.goto(loginUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });
        }

        await this.page?.waitForTimeout(1000);
        await this.validarPosLogin();
    }

    /**
     * Reabre a página com o token PAT (usado quando o botão Buscar não aparece)
     */
    private async reabrirPaginaComTokenPat(tokenPat: string, tentativa: number): Promise<void> {
        if (!this.browser) {
            throw new Error('Browser não foi inicializado');
        }

        logger.warn(`[Puppeteer] 📑 Abrindo nova aba com token PAT (tentativa ${tentativa})...`);

        // Construir URL com token completo
        const hasParams = tokenPat.includes('&token_type=bearer');
        const loginUrl = hasParams
            ? `${config.inss.url}#access_token=${tokenPat}`
            : `${config.inss.url}#access_token=${tokenPat}&token_type=bearer`;

        const paginaAnterior = this.page;
        const novaPagina = await this.browser.newPage();
        this.page = novaPagina;
        await this.configurarPaginaPadrao(this.page);
        await this.forcarPaginaSempreAtiva();

        if (paginaAnterior) {
            try {
                await paginaAnterior.close();
            } catch {
                // Ignorar erros ao fechar aba anterior
            }
        }

        // Em modo SaaS, sempre usar goto() diretamente (omnibox não funciona)
        const usarChromeExistente = false; // Sempre false para SaaS
        let navegouComOmnibox = false;

        if (usarChromeExistente) {
            logger.info('[Puppeteer] 🔁 Tentando omnibox na nova aba...');
            navegouComOmnibox = await this.navegarViaOmnibox(loginUrl);
        }

        if (!navegouComOmnibox && this.page) {
            logger.info(`[Puppeteer] 🌐 Navegando diretamente para: ${loginUrl.substring(0, 80)}...`);
            await this.page.goto(loginUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });
        }

        await this.page?.waitForTimeout(2000);
        await this.validarPosLogin();
        await this.tratarTelaErroLogin(loginUrl);
    }

    private async recuperarTelaErroPat(loginUrl: string, maxTentativas: number = 3): Promise<void> {
        for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
            await this.reabrirPaginaPat(loginUrl, tentativa);
            await this.page?.waitForTimeout(2000);
            const aindaComErro = await this.detectarErroLoginPat();
            if (!aindaComErro) {
                logger.info('[Puppeteer] ✅ Tela principal carregada após reabrir a guia.');
                return;
            }
            logger.warn(`[Puppeteer] ⚠️ Tela "LOGIN - PAT" ainda presente após tentativa ${tentativa}.`);
        }
        throw new Error('INSS exibiu a tela "LOGIN - PAT" repetidas vezes. Reabra o PAT manualmente e gere um token novo.');
    }

    /**
     * Força a página a sempre estar "ativa" mesmo quando em segundo plano
     * Impede throttling do Chrome quando aba está inativa
     */
    async forcarPaginaSempreAtiva(): Promise<void> {
        if (!this.page) return;

        try {
            logger.info('[Puppeteer] 🔧 Aplicando anti-throttling (página sempre ativa)...');

            await this.page.evaluateOnNewDocument(() => {
                // Sobrescrever propriedades do documento para sempre retornar "visível"
                Object.defineProperty(document, 'hidden', {
                    get: () => false,
                    configurable: true
                });

                Object.defineProperty(document, 'visibilityState', {
                    get: () => 'visible',
                    configurable: true
                });

                Object.defineProperty(document, 'hasFocus', {
                    get: () => true,
                    configurable: true
                });

                // Hackear requestAnimationFrame para não sofrer throttling
                const originalRAF = window.requestAnimationFrame;
                window.requestAnimationFrame = function (callback: FrameRequestCallback): number {
                    return originalRAF.call(window, callback);
                };

                // Hackear setTimeout para não sofrer throttling
                const originalSetTimeout = window.setTimeout;
                // @ts-ignore - Sobrescrevendo setTimeout para evitar throttling
                window.setTimeout = function (handler: TimerHandler, timeout?: number, ...args: any[]): any {
                    if (args.length > 0) {
                        // @ts-ignore - setTimeout aceita argumentos adicionais
                        return originalSetTimeout(handler, timeout, ...args);
                    }
                    // @ts-ignore - setTimeout aceita string ou função
                    return originalSetTimeout(handler, timeout);
                };

                // Sobrescrever addEventListener para eventos de visibilidade
                const originalAddEventListener = EventTarget.prototype.addEventListener;
                EventTarget.prototype.addEventListener = function (
                    type: string,
                    listener: EventListenerOrEventListenerObject | null,
                    options?: boolean | AddEventListenerOptions
                ) {
                    // Ignorar listeners de visibilidade que podem causar throttling
                    if (type === 'visibilitychange' || type === 'blur' || type === 'focus') {
                        console.log(`[Anti-Throttling] Bloqueado listener para evento: ${type}`);
                        return;
                    }
                    return originalAddEventListener.call(this, type, listener, options);
                };
            });

            logger.info('[Puppeteer] ✅ Anti-throttling aplicado com sucesso');
        } catch (error) {
            logger.error('[Puppeteer] ❌ Erro ao aplicar anti-throttling:', error);
        }
    }

    /**
     * Fecha o navegador
     */
    async close(): Promise<void> {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.page = null;
            logger.info('[Puppeteer] Navegador fechado');
        }
    }

    /**
     * ?? Detecta se o modal de CAPTCHA est� vis�vel na tela
     * Vers�o melhorada baseada no fluxo-semi-automatico
     * @returns true se CAPTCHA est� aberto
     */
    async detectarCaptcha(): Promise<boolean> {
        if (!this.page) return false;

        try {
            // PRIORIDADE 1: Usar XPath absoluto fornecido pelo usuário
            const CAPTCHA_MODAL_XPATH = '/html/body/div[8]/div[2]';

            const captchaModal = await this.page.evaluate((modalXPath: string) => {
                // Tentar primeiro com XPath absoluto
                try {
                    const result = document.evaluate(modalXPath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                    const modal = result.singleNodeValue as HTMLElement | null;
                    if (modal) {
                        const style = window.getComputedStyle(modal);
                        if (style.display !== 'none' && modal.offsetParent !== null) {
                            // Verificar se tem o texto do CAPTCHA ou a imagem
                            const texto = modal.textContent || '';
                            const temImagem = modal.querySelector('img[src^="data:image/png;base64"]') !== null;
                            if (texto.includes('Desafio Recaptcha') || texto.includes('validar sua requisição') || temImagem) {
                                return true;
                            }
                        }
                    }
                } catch (e) {
                    // XPath falhou, tentar seletores CSS
                }

                // FALLBACK: Buscar modal do CAPTCHA por múltiplos critérios
                const modal = document.querySelector('#modal-recaptcha') ||
                    document.querySelector('.dtp-modal:has(#modal-recaptcha_modal-label)') ||
                    document.querySelector('[role="dialog"]#modal-recaptcha') ||
                    Array.from(document.querySelectorAll('.dtp-modal, .modal, [role="dialog"]')).find(m => {
                        const texto = m.textContent || '';
                        return texto.includes('Desafio Recaptcha') ||
                            texto.includes('validar sua requisição') ||
                            texto.includes('Recaptcha') ||
                            m.querySelector('img[src^="data:image/png;base64"]') !== null;
                    });

                if (!modal) return false;

                // Verificar se está REALMENTE visível (não display:none ou visibility:hidden)
                const style = window.getComputedStyle(modal as HTMLElement);
                return style.display !== 'none' && style.visibility !== 'hidden';
            }, CAPTCHA_MODAL_XPATH) as boolean;

            return captchaModal;
        } catch {
            return false;
        }
    }

    /**
     * ?? Aguarda o usu�rio resolver o CAPTCHA manualmente
     * Verifica a cada 2 segundos se o modal sumiu OU se usu�rio pressionou ENTER no terminal
     */
    async aguardarCaptchaResolvido(): Promise<void> {
        if (!this.page) return;

        logger.warn('[Puppeteer] +--------------------------------------------------------------+');
        logger.warn('[Puppeteer] �  ?? CAPTCHA DETECTADO!                                       �');
        logger.warn('[Puppeteer] �                                                              �');
        logger.warn('[Puppeteer] �  AGUARDANDO RESOLU��O AUTOM�TICA...                          �');
        logger.warn('[Puppeteer] �  (O modal de CAPTCHA deve sumir automaticamente)             �');
        logger.warn('[Puppeteer] �                                                              �');
        logger.warn('[Puppeteer] �  Timeout: 5 minutos                                          �');
        logger.warn('[Puppeteer] +--------------------------------------------------------------+');

        // Aguardar o modal de CAPTCHA desaparecer (at� 5 minutos)
        try {
            await this.page.waitForFunction(() => {
                const modal = document.querySelector('#modal-recaptcha');
                if (!modal) return true; // J� sumiu
                const style = window.getComputedStyle(modal);
                return style.display === 'none' || style.visibility === 'hidden';
            }, { timeout: 300000 }); // 5 minutos

            logger.info('[Puppeteer] ? CAPTCHA resolvido!');
            await this.page.waitForTimeout(2000); // Aguardar processar
        } catch (error) {
            logger.error('[Puppeteer] ? Timeout aguardando CAPTCHA (5 min)');
            throw new Error('CAPTCHA n�o foi resolvido a tempo');
        }
    }

    /**
     * 🔄 Verifica e resolve novo CAPTCHA após rejeição
     * Retorna true se não há CAPTCHA ou se foi resolvido com sucesso
     */
    private async verificarEResolverNovoCaptcha(sessionId: string, contexto: string): Promise<boolean> {
        if (!this.page) return false;

        // Verificar se há novo CAPTCHA
        const captchaNovo = await this.detectarCaptcha();
        if (!captchaNovo) {
            return true; // Não há CAPTCHA
        }

        logger.warn(`[Puppeteer] 🔄 NOVO CAPTCHA DETECTADO em ${contexto}! Tentando resolver...`);
        const resolvido = await this.resolverCaptchaAutomatico(`${contexto}-retry`);

        if (resolvido) {
            logger.info(`[Puppeteer] ✅ Novo CAPTCHA resolvido em ${contexto}!`);
            // Aguardar modal desaparecer
            await this.page.waitForTimeout(3000);
            return true;
        } else {
            logger.error(`[Puppeteer] ❌ Falha ao resolver novo CAPTCHA em ${contexto}`);
            return false;
        }
    }

    /**
     * ?? NOVO: Resolve CAPTCHA com OCR/Manual + Preenche automaticamente
     */
    async resolverCaptchaAutomatico(sessionId: string): Promise<boolean> {
        if (!this.page) return false;

        try {
            // Importar CaptchaService dinamicamente
            const { default: captchaService } = await import('./CaptchaService');

            logger.warn('[Puppeteer] ?? CAPTCHA DETECTADO! Iniciando resolu��o autom�tica...');

            // PASSO 1: Capturar imagem do CAPTCHA
            const imagemBase64 = await captchaService.capturarImagemCaptcha(this.page, sessionId);

            if (!imagemBase64) {
                logger.error('[Puppeteer] ❌ Falha ao capturar imagem do CAPTCHA automaticamente');

                // Verificar se o CAPTCHA ainda está visível
                const aindaVisivel = await this.detectarCaptcha();
                if (!aindaVisivel) {
                    logger.info('[Puppeteer] ✅ CAPTCHA não está mais visível - pode ter sido resolvido automaticamente.');
                    return true;
                }

                // Se ainda está visível mas não conseguiu capturar, aguardar um pouco
                logger.warn('[Puppeteer] ⚠️ CAPTCHA ainda visível mas não foi possível capturar.');
                logger.warn('[Puppeteer] ⚠️ Aguardando 5 segundos para ver se resolve automaticamente...');
                await this.page.waitForTimeout(5000);

                const aindaVisivelAposEspera = await this.detectarCaptcha();
                if (!aindaVisivelAposEspera) {
                    logger.info('[Puppeteer] ✅ CAPTCHA resolvido após espera.');
                    return true;
                }

                logger.error('[Puppeteer] ❌ CAPTCHA ainda visível após espera - não foi possível resolver.');
                return false;
            }

            // PASSO 2: Resolver completamente usando resolverComRetry (vai até o fim)
            try {
                const resultado = await captchaService.resolverComRetry(this.page, sessionId, 10);
                if (resultado?.sucesso) {
                    if (resultado.texto) {
                        logger.info(`[Puppeteer] ✅ CAPTCHA resolvido automaticamente: ${resultado.texto}`);
                    } else {
                        logger.info('[Puppeteer] ✅ CAPTCHA já havia sido confirmado manualmente no navegador.');
                    }
                    captchaService.limparSessao(sessionId);
                    return true;
                } else {
                    logger.error('[Puppeteer] ❌ CAPTCHA não foi resolvido após tentativas automáticas');
                    throw new Error('CAPTCHA não resolvido');
                }
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                logger.error(`[Puppeteer] ❌ Erro ao resolver CAPTCHA: ${reason}`);
                throw error;
            }

        } catch (error: any) {
            const errorMessage = error?.message || String(error) || 'Erro desconhecido';
            const errorStack = error?.stack || 'Stack não disponível';
            const errorType = error?.constructor?.name || typeof error;

            logger.error(`[Puppeteer] ❌ Erro ao resolver CAPTCHA: ${errorMessage}`);
            logger.error(`[Puppeteer] Stack completo: ${errorStack}`);
            logger.error(`[Puppeteer] Tipo do erro: ${errorType}`);

            // Log adicional para debug
            if (error) {
                logger.error('[Puppeteer] Objeto erro completo:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
            }

            return false;
        }
    }

    /**
     * Faz login no sistema INSS (Atendimento) via Token OAuth
     * 
     * O INSS gera um link com access_token v�lido por ~2h ap�s login com certificado + 2FA.
     * Este m�todo simplesmente navega para a URL completa com o token.
     * 
     * @param accessToken Token obtido manualmente (ex: AT-218965-M2ZuHBI1ggY5IlA0PuFPqJXcGq-tAlKZ)
     */
    async login(accessToken?: string): Promise<void> {
        if (!this.page) throw new Error('Navegador n�o inicializado');

        try {
            logger.info('[Puppeteer] Verificando estado do navegador...');

            const currentUrl = this.page.url();
            logger.info(`[Puppeteer] URL atual: ${currentUrl}`);

            // Verificar se já está no site do INSS (não extensão, não about:blank)
            const jaEstaNoSite = currentUrl.includes('atendimento.inss.gov.br') &&
                !currentUrl.includes('about:blank') &&
                !currentUrl.includes('chrome-extension') &&
                currentUrl.length > 50; // URL real tem mais de 50 chars

            if (jaEstaNoSite) {
                logger.info('[Puppeteer] ✅ Já está no site do INSS!');

                // Aguardar página carregar completamente
                await this.page.waitForTimeout(2000);

                // Verificar se está logado usando o ícone de usuário (mais confiável)
                const iconeUsuario = await this.page.$('i.icon.ico-user-c[aria-hidden="true"]');
                const loginElement = await this.page.$('label[label="Nome"][for="filtro-entidade-conveniada-nome"]');

                if (iconeUsuario || loginElement) {
                    logger.info('[Puppeteer] ✅ Já está logado (ícone de usuário ou elemento "Nome" encontrado)!');
                    logger.info('[Puppeteer] Pulando navegação OAuth...');
                    return; // Skip login entirely
                } else {
                    logger.info('[Puppeteer] ⚠️ No site mas não está logado, tentando autenticar...');
                }
            } else {
                logger.info('[Puppeteer] 🔄 Navegando para INSS...');
            }

            // Usar token do par�metro ou da config
            const token = accessToken || config.inss.accessToken;

            // Debug: mostrar qual token está sendo usado
            if (accessToken) {
                logger.info(`[Puppeteer] 🔑 Usando token PAT do parâmetro (${accessToken.substring(0, 20)}...)`);
            } else {
                logger.warn(`[Puppeteer] ⚠️ Usando token PAT do .env/config (${token.substring(0, 20)}...)`);
            }

            if (!token || token === '' || token === 'seu_token_aqui') {
                logger.error('[Puppeteer] ? INSS_ACCESS_TOKEN n�o configurado ou inv�lido!');
                logger.error('[Puppeteer] ?? Para obter o token:');
                logger.error('[Puppeteer]    1. Acesse https://atendimento.inss.gov.br');
                logger.error('[Puppeteer]    2. Fa�a login com certificado digital + 2FA');
                logger.error('[Puppeteer]    3. Copie a URL completa (cont�m access_token=...)');
                logger.error('[Puppeteer]    4. Extraia o valor do access_token');
                logger.error('[Puppeteer]    5. Configure INSS_ACCESS_TOKEN no .env');
                throw new Error('INSS_ACCESS_TOKEN n�o configurado');
            }

            logger.info('[Puppeteer] Fazendo login via token OAuth...');

            // Armazenar token para reutilizar se precisar abrir nova aba
            this.ultimoTokenPat = token;

            // Construir URL com token completo
            // Se o token j� cont�m os par�metros (&token_type=bearer&refresh_token=...), usar direto
            // Construir URL com token completo
            // O token pode vir de 3 formas:
            // 1. URL completa: https://atendimento.inss.gov.br/#access_token=AT-xxx&token_type=bearer&expires_in=1800&refresh_token=RT-xxx
            // 2. Token com parâmetros: AT-xxx&token_type=bearer&expires_in=1800&refresh_token=RT-xxx
            // 3. Apenas token: AT-xxx

            let loginUrl: string;

            // Se já é uma URL completa, extrair apenas a parte após #
            if (token.includes('https://atendimento.inss.gov.br') || token.includes('http://atendimento.inss.gov.br')) {
                const hashIndex = token.indexOf('#');
                if (hashIndex !== -1) {
                    // Extrair apenas a parte após #
                    const fragmento = token.substring(hashIndex + 1);
                    loginUrl = `${config.inss.url}#${fragmento}`;
                    logger.info(`[Puppeteer] 🔗 Token é URL completa, extraindo fragmento: ${fragmento.substring(0, 50)}...`);
                } else {
                    // URL sem #, usar como está
                    loginUrl = token;
                }
            } else if (token.includes('&token_type=bearer')) {
                // Token já contém todos os parâmetros (access_token, token_type, expires_in, refresh_token)
                // Verificar se já começa com access_token= ou não
                if (token.startsWith('access_token=')) {
                    // Já tem access_token=, apenas adicionar #
                    loginUrl = `${config.inss.url}#${token}`;
                } else {
                    // Não tem access_token=, adicionar no início
                    loginUrl = `${config.inss.url}#access_token=${token}`;
                }
                logger.info(`[Puppeteer] 🔗 Token com parâmetros completos: ${token.substring(0, 50)}...`);
            } else {
                // Apenas access_token, adicionar token_type
                loginUrl = `${config.inss.url}#access_token=${token}&token_type=bearer`;
                logger.info(`[Puppeteer] 🔗 Token simples, adicionando token_type=bearer`);
            }

            logger.info(`[Puppeteer] Navegando para URL autenticada...`);

            // Em modo SaaS (headless), sempre usar page.goto() diretamente
            // Omnibox só funciona quando conectado ao Chrome existente
            const usarChromeExistente = false; // Sempre false para SaaS (já forçado no initialize)

            // SEMPRE abrir uma nova guia antes de navegar (como sugerido pelo usuário)
            if (usarChromeExistente && this.browser) {
                logger.info('[Puppeteer] 📑 Abrindo nova guia para autenticação...');
                const pages = await this.browser.pages();
                const newPage = await this.browser.newPage();
                this.page = newPage;
                logger.info(`[Puppeteer] ✅ Nova guia criada (total de guias: ${pages.length + 1})`);
            }

            // Em modo SaaS, sempre usar goto() diretamente (omnibox não funciona em headless)
            if (!usarChromeExistente) {
                // Garantir que temos uma página válida
                if (!this.page && this.browser) {
                    const pages = await this.browser.pages();
                    this.page = pages.length > 0 ? pages[0] : await this.browser.newPage();
                    await this.configurarPaginaPadrao(this.page);
                    await this.forcarPaginaSempreAtiva();
                }

                if (!this.page) {
                    throw new Error('Página não foi inicializada corretamente');
                }

                logger.info('[Puppeteer] 🌐 Modo SaaS: navegando diretamente com page.goto()...');
                try {
                    // Navegar diretamente
                    logger.info(`[Puppeteer] 🌐 Navegando para: ${loginUrl.substring(0, 80)}...`);
                    await this.page.goto(loginUrl, {
                        waitUntil: 'domcontentloaded',
                        timeout: 30000
                    });
                    logger.info('[Puppeteer] ✅ Navegação concluída!');

                    // Verificar imediatamente se foi redirecionado para login (token expirado)
                    await this.page.waitForTimeout(1000); // Aguardar 1s para redirecionamento
                    await this.validarPosLogin();

                    // Aguardar React processar
                    await this.page.waitForTimeout(2000);

                } catch (error: any) {
                    logger.error(`[Puppeteer] ❌ Erro ao navegar: ${error.message}`);
                    // Tentar usar evaluate como último recurso
                    try {
                        logger.info('[Puppeteer] 🔄 Tentando último recurso: mudando URL via JavaScript...');
                        await this.page.evaluate((url) => {
                            window.location.href = url;
                        }, loginUrl);
                        await this.page.waitForTimeout(5000);
                        logger.info('[Puppeteer] ✅ URL mudada via JavaScript');
                    } catch (evalError: any) {
                        logger.error(`[Puppeteer] ❌ Falha total na navegação: ${evalError.message}`);
                        throw new Error(`Não foi possível navegar para o INSS: ${error.message}`);
                    }
                }
            } else {
                // Modo Chrome existente: tentar omnibox primeiro
                let navegouComOmnibox = false;
                logger.info('[Puppeteer] 🔄 Modo Chrome existente: tentando navegar via omnibox (Ctrl+L)...');
                navegouComOmnibox = await this.navegarViaOmnibox(loginUrl);

                if (!navegouComOmnibox) {
                    // Fallback: usar goto direto
                    logger.info('[Puppeteer] 🔄 Omnibox falhou, usando page.goto() como fallback...');
                    try {
                        await this.page.goto(loginUrl, {
                            waitUntil: 'domcontentloaded',
                            timeout: 30000
                        });
                        logger.info('[Puppeteer] ✅ Navegação concluída!');
                        await this.page.waitForTimeout(1000);
                        await this.validarPosLogin();
                        await this.page.waitForTimeout(2000);
                    } catch (error: any) {
                        logger.error(`[Puppeteer] ❌ Erro ao navegar: ${error.message}`);
                        throw new Error(`Não foi possível navegar para o INSS: ${error.message}`);
                    }
                }
            }

            await this.tratarTelaErroLogin(loginUrl);

            // VALIDAÇÃO CRÍTICA: Verificar se realmente saiu da tela de erro após tratamento
            logger.info('[Puppeteer] 🔍 Validando login após tratamento de erro...');
            await this.page.waitForTimeout(3000); // Aguardar React processar

            // Debug: mostrar URL atual e conteúdo da página
            const urlAtual = this.page.url();
            logger.info(`[Puppeteer] 📍 URL atual: ${urlAtual}`);

            const aindaComErro = await this.detectarErroLoginPat();
            logger.info(`[Puppeteer] 🔍 Tela "LOGIN - PAT" detectada? ${aindaComErro}`);

            if (aindaComErro) {
                // Debug: capturar screenshot e HTML para análise
                try {
                    const fs = require('fs');
                    await this.page.screenshot({ path: 'logs/login-erro-validacao.png', fullPage: true });
                    fs.writeFileSync('logs/login-erro-validacao.html', await this.page.content());
                    logger.error('[Puppeteer] 📸 Screenshot e HTML salvos em logs/login-erro-validacao.*');
                } catch (e) {
                    logger.warn('[Puppeteer] ⚠️ Não foi possível salvar screenshot:', e);
                }

                logger.error('[Puppeteer] ❌ Ainda na tela "LOGIN - PAT" após todas as tentativas!');
                logger.error('[Puppeteer] ❌ Token PAT pode estar expirado ou inválido.');
                throw new Error('Token PAT inválido ou expirado. Não foi possível fazer login. Por favor, gere um novo token PAT.');
            }

            // Verificar se está realmente logado (elementos da página principal)
            logger.info('[Puppeteer] 🔍 Verificando elementos da página principal...');
            const estaLogado = await this.page.evaluate(() => {
                const iconeUsuario = document.querySelector('i.icon.ico-user-c[aria-hidden="true"]');
                const loginElement = document.querySelector('label[label="Nome"][for="filtro-entidade-conveniada-nome"]');
                const menuAdmin = document.querySelector('.dtp-menu-admin');
                const resultado = {
                    temIconeUsuario: !!iconeUsuario,
                    temLoginElement: !!loginElement,
                    temMenuAdmin: !!menuAdmin,
                    logado: !!(iconeUsuario || loginElement || menuAdmin)
                };
                return resultado;
            });

            logger.info(`[Puppeteer] 🔍 Elementos encontrados: ícone=${estaLogado.temIconeUsuario}, nome=${estaLogado.temLoginElement}, menu=${estaLogado.temMenuAdmin}`);

            if (!estaLogado.logado) {
                // Debug: capturar screenshot e HTML para análise
                try {
                    const fs = require('fs');
                    await this.page.screenshot({ path: 'logs/login-falhou-validacao.png', fullPage: true });
                    fs.writeFileSync('logs/login-falhou-validacao.html', await this.page.content());
                    logger.error('[Puppeteer] 📸 Screenshot e HTML salvos em logs/login-falhou-validacao.*');
                } catch (e) {
                    logger.warn('[Puppeteer] ⚠️ Não foi possível salvar screenshot:', e);
                }

                logger.error('[Puppeteer] ❌ Login não foi bem-sucedido. Página principal não carregou.');
                throw new Error('Login não foi bem-sucedido. A página principal não carregou. Por favor, verifique o token PAT.');
            }

            logger.info('[Puppeteer] ✅ Login validado com sucesso!');

            // ?? Aguardar React renderizar (cr�tico para evitar p�gina branca!)
            logger.info('[Puppeteer] ? Aguardando React renderizar p�gina...');

            // ?? AJUSTADO: 3 tentativas de 3s cada (total 9s) - balanceado entre velocidade e confiabilidade
            let tentativasReact = 0;
            let reactCarregado = false;

            while (tentativasReact < 3 && !reactCarregado) {
                tentativasReact++;
                await this.page.waitForTimeout(3000);

                const estadoPagina = await this.page.evaluate(() => {
                    const root = document.querySelector('#root, [data-reactroot]');
                    const menu = document.querySelector('.dtp-menu-admin, .user-card');
                    // Verificar também pelo XPath do modal fornecido
                    const modal = document.querySelector('.modal-selecao-abrangencia, #dtpSelectAbrangencia, [id="dtpSelectAbrangencia"]');
                    const modalXPath = document.evaluate('/html/body/div/main/div/div/div/div/div/div/div', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                    const iconeUsuario = document.querySelector('i.icon.ico-user-c[aria-hidden="true"]');
                    const contentLength = document.body.innerText.trim().length;

                    return {
                        temRoot: !!root,
                        temMenu: !!menu,
                        temModal: !!modal || !!modalXPath,
                        temIconeUsuario: !!iconeUsuario,
                        tamanhoConteudo: contentLength
                    };
                });

                // Se já está logado (ícone de usuário), pode prosseguir
                if (estadoPagina.temIconeUsuario) {
                    reactCarregado = true;
                    logger.info(`[Puppeteer] ✅ Usuário já logado detectado após ${tentativasReact * 3}s`);
                    break;
                }

                // Se tem modal ou estrutura básica, React carregou
                if (estadoPagina.temRoot &&
                    (estadoPagina.temMenu || estadoPagina.temModal) &&
                    estadoPagina.tamanhoConteudo > 300) {
                    reactCarregado = true;
                    logger.info(`[Puppeteer] ✅ Estrutura básica após ${tentativasReact * 3}s`);
                } else if (estadoPagina.temModal) {
                    logger.info('[Puppeteer] Modal de login detectado, prosseguindo.');
                    reactCarregado = true;
                    break;
                }
            }

            if (!reactCarregado) {
                logger.warn('[Puppeteer] ?? React pode não ter carregado completamente, mas prosseguindo...');
            }

            // ?? VERIFICAR SE TOKEN EXPIROU
            let tokenExpirado = await this.page.evaluate(() => {
                const html = document.body.innerHTML;
                return html.includes('N�o foi poss�vel autenticar o usu�rio') &&
                    html.includes('LOGIN - PAT');
            });

            // ?? RETRY: Se detectou erro mas o token pode estar válido, tentar navegar novamente
            if (tokenExpirado && accessToken) {
                logger.warn('[Puppeteer] ⚠️ Erro de autenticação detectado na primeira tentativa');
                logger.info('[Puppeteer] 🔄 Tentando retry automático (às vezes funciona na segunda tentativa)...');

                // Aguardar um pouco
                await this.page.waitForTimeout(2000);

                // Tentar navegar novamente para a mesma URL
                try {
                    await this.page.goto(loginUrl, {
                        waitUntil: 'domcontentloaded',
                        timeout: 30000
                    });
                    await this.page.waitForTimeout(5000);

                    // Verificar novamente se ainda tem erro
                    tokenExpirado = await this.page.evaluate(() => {
                        const html = document.body.innerHTML;
                        return html.includes('N�o foi poss�vel autenticar o usu�rio') &&
                            html.includes('LOGIN - PAT');
                    });

                    if (!tokenExpirado) {
                        logger.info('[Puppeteer] ✅ Retry bem-sucedido! Autenticação funcionou na segunda tentativa');
                    } else {
                        logger.warn('[Puppeteer] ⚠️ Retry não funcionou, erro de autenticação persiste');
                    }
                } catch (retryError: any) {
                    logger.warn(`[Puppeteer] ⚠️ Erro no retry: ${retryError.message}`);
                }
            }

            if (tokenExpirado) {
                logger.error('[Puppeteer] +--------------------------------------------------------------+');
                logger.error('[Puppeteer] �  ?? TOKEN OAUTH EXPIRADO!                                    �');
                logger.error('[Puppeteer] �                                                              �');
                logger.error('[Puppeteer] �  Mensagem do INSS:                                           �');
                logger.error('[Puppeteer] �  "N�o foi poss�vel autenticar o usu�rio"                     �');
                logger.error('[Puppeteer] �                                                              �');
                logger.error('[Puppeteer] �  POR FAVOR:                                                  �');
                logger.error('[Puppeteer] �  1. Abra o navegador no site do INSS                         �');
                logger.error('[Puppeteer] �  2. Fa�a login manualmente                                   �');
                logger.error('[Puppeteer] �  3. Copie a URL completa ap�s login:                         �');
                logger.error('[Puppeteer] �     https://atendimento.inss.gov.br/#access_token=AT-...     �');
                logger.error('[Puppeteer] �                                                              �');
                logger.error('[Puppeteer] +--------------------------------------------------------------+');

                // Pedir novo token via readline
                const readline = require('readline');
                const rl = readline.createInterface({
                    input: process.stdin,
                    output: process.stdout
                });

                // ?? Ler token em m�ltiplas linhas (PowerShell quebra URLs longas)
                const linhasToken: string[] = [];
                let lendoToken = true;

                logger.info('[Puppeteer] ?? Dica: Cole a URL e pressione ENTER');
                logger.info('[Puppeteer] ?? Se a URL quebrar em v�rias linhas, pressione ENTER em cada linha');
                logger.info('[Puppeteer] ?? Quando terminar, deixe a linha vazia e pressione ENTER novamente\n');

                while (lendoToken) {
                    const linha = await new Promise<string>((resolve) => {
                        rl.question('', (answer: string) => {
                            resolve(answer.trim());
                        });
                    });

                    if (linha === '') {
                        // Linha vazia = terminou de colar
                        lendoToken = false;
                    } else {
                        linhasToken.push(linha);
                    }
                }

                rl.close();

                // Juntar todas as linhas em uma �nica string
                let novoToken = linhasToken.join('');

                logger.info('[Puppeteer] ?? DEBUG - String original recebida:');
                logger.info(`[Puppeteer] ?? Tamanho total: ${novoToken.length} caracteres`);
                logger.info(`[Puppeteer] ?? Primeiros 100 chars: ${novoToken.substring(0, 100)}`);
                logger.info(`[Puppeteer] ?? �ltimos 100 chars: ${novoToken.substring(novoToken.length - 100)}`);

                // ?? CORRE��O: PowerShell duplica caracteres ao colar
                // O PowerShell mostra: "hhttttppss..." (duplicado) + "https://..." (normal mas incompleto) + "https://..." (duplicado)
                // Precisamos extrair apenas a primeira URL normal completa
                if (novoToken.includes('hhttttppss')) {
                    logger.info('[Puppeteer] ?? Detectado duplica��o de caracteres (bug do PowerShell)');
                    logger.info('[Puppeteer] ?? Buscando URL v�lida...');

                    // Procurar pela primeira ocorr�ncia de "https://" (URL normal)
                    const indexUrlNormal = novoToken.indexOf('https://atendimento.inss.gov.br');
                    logger.info(`[Puppeteer] ?? Index da URL normal: ${indexUrlNormal}`);

                    if (indexUrlNormal === -1) {
                        // Se n�o encontrou URL normal, tentar dedupplicar a primeira parte
                        logger.warn('[Puppeteer] ?? URL normal n�o encontrada, tentando dedupplicar...');
                        const parteDuplicada = novoToken.substring(0, novoToken.indexOf('https://') || novoToken.length);
                        novoToken = parteDuplicada.split('').filter((char, index) => index % 2 === 0).join('');
                    } else {
                        // Extrair URL normal (do "https://" at� o pr�ximo "https://" ou fim)
                        const restante = novoToken.substring(indexUrlNormal);
                        const proximoHttps = restante.indexOf('https://', 10); // Buscar pr�ximo https:// ap�s os primeiros chars
                        logger.info(`[Puppeteer] ?? Index do pr�ximo https:// : ${proximoHttps}`);

                        if (proximoHttps > 0) {
                            // Tem outra URL depois, pegar s� at� ela
                            novoToken = restante.substring(0, proximoHttps);
                            logger.info(`[Puppeteer] ?? Cortado no pr�ximo https:// (posi��o ${proximoHttps})`);
                        } else {
                            // N�o tem outra URL, pegar tudo
                            novoToken = restante;
                            logger.info('[Puppeteer] ? Pegou URL at� o fim (sem outro https://)');
                        }

                        logger.info(`[Puppeteer] ? URL v�lida extra�da (${novoToken.length} chars)`);
                        logger.info(`[Puppeteer] ?? URL completa: ${novoToken}`);
                    }
                }

                if (!novoToken || novoToken.length < 50) {
                    throw new Error('Token vazio ou inv�lido. Tente novamente.');
                }

                // Extrair apenas o fragmento (#access_token=...)
                let tokenCompleto = '';
                if (novoToken.includes('#access_token=')) {
                    tokenCompleto = novoToken.split('#access_token=')[1];
                } else if (novoToken.includes('access_token=')) {
                    tokenCompleto = novoToken.split('access_token=')[1];
                } else {
                    throw new Error('URL inv�lida. Deve conter "access_token="');
                }

                logger.info('[Puppeteer] ? Novo token capturado!');
                logger.info(`[Puppeteer] ?? Tamanho: ${tokenCompleto.length} caracteres`);
                logger.info('[Puppeteer] ?? Salvando no arquivo .env...');

                // Salvar no .env (caminho correto: backend/.env)
                const fs = require('fs');
                const path = require('path');
                const envPath = path.join(__dirname, '../../.env'); // backend/src/services ? backend/.env

                // Verificar se arquivo existe
                if (!fs.existsSync(envPath)) {
                    throw new Error(`.env n�o encontrado em: ${envPath}`);
                }

                const envContent = fs.readFileSync(envPath, 'utf8');

                // Substituir linha do token
                const linhas = envContent.split('\n');
                const novaLinhas = linhas.map((linha: string) => {
                    if (linha.startsWith('INSS_ACCESS_TOKEN=')) {
                        return `INSS_ACCESS_TOKEN=${tokenCompleto}`;
                    }
                    return linha;
                });

                fs.writeFileSync(envPath, novaLinhas.join('\n'));
                logger.info('[Puppeteer] ? Token atualizado em .env');
                logger.info('[Puppeteer] ?? Recarregando p�gina com novo token...');

                // Atualizar URL e recarregar (usar URL completa corrigida)
                logger.info(`[Puppeteer] ?? Nova URL: ${novoToken.substring(0, 80)}...`);
                await this.page.goto(novoToken, {
                    waitUntil: 'domcontentloaded',
                    timeout: 30000,
                });

                // ?? REINICIAR VERIFICA��O DE REACT (recursivo)
                logger.info('[Puppeteer] ?? Reiniciando verifica��o de React...');

                // Resetar contador e tentar novamente
                tentativasReact = 0;
                reactCarregado = false;

                while (tentativasReact < 10 && !reactCarregado) {
                    tentativasReact++;
                    await this.page.waitForTimeout(3000);

                    const estadoPagina = await this.page.evaluate(() => {
                        const root = document.querySelector('#root, [data-reactroot]');
                        const menu = document.querySelector('.dtp-menu-admin, .user-card');
                        const modal = document.querySelector('.modal-selecao-abrangencia, #dtpSelectAbrangencia');
                        const contentLength = document.body.innerText.trim().length;

                        return {
                            temRoot: !!root,
                            temMenu: !!menu,
                            temModal: !!modal,
                            tamanhoConteudo: contentLength
                        };
                    });

                    if (estadoPagina.temRoot &&
                        (estadoPagina.temMenu || estadoPagina.temModal) &&
                        estadoPagina.tamanhoConteudo > 500) {
                        reactCarregado = true;
                        logger.info(`[Puppeteer] ? React carregou ap�s ${tentativasReact * 3}s (com novo token)`);
                    } else {
                        logger.info(`[Puppeteer] ??  Tentativa ${tentativasReact}/10 - Aguardando React... (conte�do: ${estadoPagina.tamanhoConteudo} chars)`);
                    }
                }

                if (!reactCarregado) {
                    logger.error('[Puppeteer] ? React n�o carregou mesmo com novo token!');
                    throw new Error('Token pode estar inv�lido ou INSS est� fora do ar');
                }
            }

            // ? REMOVER VERIFICA��O DE P�GINA BRANCA (est� causando falso positivo)
            // A verifica��o de React acima j� garante que a p�gina n�o est� branca

            // ?? Aguardar modais aparecerem (ou timeout de 10s) OU verificar se j� est� logado
            logger.info('[Puppeteer] ? Aguardando modais de autentica��o (at� 10s)...');

            const resultado = await Promise.race([
                this.page.waitForSelector('.modal-selecao-abrangencia, #dtpSelectAbrangencia, .modal-dialog', { timeout: 10000 })
                    .then(() => 'modal')
                    .catch(() => null),
                this.page.waitForSelector('i.icon.ico-user-c[aria-hidden="true"], label[label="Nome"][for="filtro-entidade-conveniada-nome"]', { timeout: 10000 })
                    .then(() => 'logado')
                    .catch(() => null),
                new Promise(resolve => setTimeout(() => resolve('timeout'), 10000))
            ]);

            if (resultado === 'logado') {
                logger.info('[Puppeteer] ? J� est� logado! (ícone de usuário ou elemento "Nome" encontrado)');
                logger.info('[Puppeteer] Pulando configura��o de modais...');
                return; // Sai da fun��o login
            }

            if (resultado === 'timeout') {
                logger.warn('[Puppeteer] ?? Modais n�o apareceram no timeout, aguardando mais tempo...');
                // Em vez de fazer goto novamente (causa ERR_ABORTED), apenas aguardar mais
                await this.page.waitForTimeout(5000);

                // Verificar novamente se já está logado
                const jaLogado = await this.page.evaluate(() => {
                    const iconeUsuario = document.querySelector('i.icon.ico-user-c[aria-hidden="true"]');
                    const loginElement = document.querySelector('label[label="Nome"][for="filtro-entidade-conveniada-nome"]');
                    return !!(iconeUsuario || loginElement);
                });

                if (jaLogado) {
                    logger.info('[Puppeteer] ✅ Usuário já está logado após espera adicional');
                    return;
                }
            }

            try {
                // ?? MODAL 1: Sele��o de Abrang�ncia e Papel
                logger.info('[Puppeteer] Verificando modais de autentica��o...');

                const hasAbrangenciaModal = await this.page.evaluate(() => {
                    // Procurar pelo modal usando seletores CSS e XPath
                    const seletorCSS = document.querySelector('.modal-selecao-abrangencia, #dtpSelectAbrangencia');
                    const modalXPath = document.evaluate('/html/body/div/main/div/div/div/div/div/div/div', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                    return !!(seletorCSS || modalXPath);
                });

                if (hasAbrangenciaModal) {
                    logger.info('[Puppeteer] 1?? Modal de abrang�ncia detectado...');

                    // Usar XPath absoluto fornecido pelo usuário
                    const modalXPath = '/html/body/div/main/div/div/div/div/div/div/div';
                    const modalExists = await this.page.evaluate((xpath) => {
                        const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                        return !!result.singleNodeValue;
                    }, modalXPath);

                    if (modalExists) {
                        logger.info('[Puppeteer]    ? Modal confirmado via XPath absoluto');
                    }

                    // Selecionar CNPJ
                    logger.info('[Puppeteer]    ? Selecionando CNPJ:14259469000154.CNPJ');
                    await this.page.select('#dtpSelectAbrangencia', 'CNPJ:14259469000154.CNPJ');

                    // Aguardar e verificar se as op��es de papel carregaram
                    logger.info('[Puppeteer]    ? Aguardando op��es de papel carregar...');
                    await this.page.waitForTimeout(3000); // Aumentar para 3s

                    // Verificar se op��es carregaram
                    const temOpcoesPapel = await this.page.evaluate(() => {
                        const select = document.querySelector('#dtpSelectPapel') as HTMLSelectElement;
                        const options = Array.from(select.options).filter(opt => opt.value !== '');
                        return options.length;
                    });

                    logger.info(`[Puppeteer]    ? ${temOpcoesPapel} op��es de papel encontradas`);

                    if (temOpcoesPapel === 0) {
                        logger.warn('[Puppeteer]    ?? Nenhuma op��o de papel carregou - aguardando mais 5s');
                        await this.page.waitForTimeout(5000);
                    }

                    // Aguardar seletor com op��es
                    try {
                        await this.page.waitForSelector('#dtpSelectPapel option:not([value=""])', { timeout: 10000 });
                    } catch (err) {
                        logger.error('[Puppeteer]    ? Timeout ao aguardar op��es de papel');
                        throw new Error('Papel n�o carregou - verifique permiss�es do usu�rio');
                    }

                    const papelSelecionado = await this.page.evaluate(() => {
                        const select = document.querySelector('#dtpSelectPapel') as HTMLSelectElement;
                        const options = Array.from(select.options).filter(opt => opt.value !== '');

                        // Procurar por "ENTIDADE_CONVENIADA_OAB"
                        const opcaoEntidade = options.find(opt =>
                            opt.textContent?.includes('ENTIDADE_CONVENIADA_OAB')
                        );

                        return opcaoEntidade ? opcaoEntidade.value : (options[0]?.value || '');
                    });

                    if (papelSelecionado) {
                        logger.info(`[Puppeteer]    ? Selecionando papel: ${papelSelecionado}`);
                        await this.page.select('#dtpSelectPapel', papelSelecionado);
                        await this.page.waitForTimeout(1000);
                    } else {
                        throw new Error('Nenhum papel dispon�vel para sele��o');
                    }

                    // Aguardar bot�o "Autorizo" ficar habilitado
                    logger.info('[Puppeteer]    ? Aguardando bot�o "Autorizo" habilitar...');
                    await this.page.waitForFunction(() => {
                        const btn = document.querySelector('#btnAutorizo') as HTMLButtonElement;
                        return btn && !btn.disabled && !btn.classList.contains('disabled');
                    }, { timeout: 10000 });

                    // Clicar em "Autorizo" usando XPath absoluto fornecido
                    logger.info('[Puppeteer]    ? Clicando em "Autorizo"');
                    const autorizoXPath = '/html/body/div/main/div/div/div/div/div/div/div/div[2]/div[2]/div/button[2]';
                    try {
                        const autorizoHandles = await this.page.$x(autorizoXPath);
                        if (autorizoHandles.length > 0) {
                            await (autorizoHandles[0] as any).click();
                            logger.info('[Puppeteer]    ? Botão "Autorizo" clicado via XPath absoluto');
                        } else {
                            // Fallback para seletor CSS
                            await this.page.click('#btnAutorizo');
                            logger.info('[Puppeteer]    ? Botão "Autorizo" clicado via seletor CSS (fallback)');
                        }
                    } catch (error) {
                        // Fallback para seletor CSS
                        await this.page.click('#btnAutorizo');
                        logger.info('[Puppeteer]    ? Botão "Autorizo" clicado via seletor CSS (fallback)');
                    }
                    await this.page.waitForTimeout(3000);

                    logger.info('[Puppeteer] ? Modal 1 conclu�do');
                }

                // ?? MODAL 2: Alerta sobre Certificado Digital A3
                logger.info('[Puppeteer] 2?? Verificando modal de alerta...');

                const hasAlertModal = await this.page.evaluate(() => {
                    // Verificar usando seletor CSS
                    const modal = document.querySelector('.dtp-modal');
                    const hasAlert = modal?.querySelector('.alert-danger');

                    // Verificar também usando XPath fornecido
                    const alertaXPath = document.evaluate('/html/body/div[2]/div[2]', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                    const temBotaoOk = alertaXPath && (alertaXPath as Element).querySelector ? (alertaXPath as Element).querySelector('button#btnAutorizo[title="OK"]') : null;

                    return !!(hasAlert || temBotaoOk);
                });

                if (hasAlertModal) {
                    logger.info('[Puppeteer]    Modal de alerta A3 detectado');

                    // Usar XPath absoluto fornecido pelo usuário
                    const alertaOkXPath = '/html/body/div[2]/div[2]//button[@id="btnAutorizo" and contains(text(), "Ok")]';
                    try {
                        const okHandles = await this.page.$x(alertaOkXPath);
                        if (okHandles.length > 0) {
                            await (okHandles[0] as any).click();
                            logger.info('[Puppeteer]    Botão "Ok" clicado via XPath absoluto');
                        } else {
                            // Fallback para seletor CSS
                            await this.page.waitForSelector('.dtp-modal #btnAutorizo', { timeout: 5000 });
                            await this.page.click('.dtp-modal #btnAutorizo');
                            logger.info('[Puppeteer]    Botão "Ok" clicado via seletor CSS (fallback)');
                        }
                    } catch (error) {
                        // Fallback para seletor CSS
                        await this.page.waitForSelector('.dtp-modal #btnAutorizo', { timeout: 5000 });
                        await this.page.click('.dtp-modal #btnAutorizo');
                        logger.info('[Puppeteer]    Botão "Ok" clicado via seletor CSS (fallback)');
                    }

                    await this.page.waitForFunction(() => {
                        const modal = document.querySelector('.dtp-modal');
                        if (!modal) return true;
                        const hidden = modal.classList.contains('hide') ||
                            modal.getAttribute('aria-hidden') === 'true' ||
                            modal.getAttribute('style')?.includes('display: none');
                        return hidden;
                    }, { timeout: 5000 }).catch(() => undefined);

                    logger.info('[Puppeteer]    Aguardando 5 segundos para a tela principal ap�s o alerta...');
                    await this.page.waitForTimeout(5000);

                    logger.info('[Puppeteer] Modal 2 conclu�do');
                }                // Aguardar p�gina principal carregar completamente
                logger.info('[Puppeteer] Aguardando p�gina principal carregar...');
                await this.page.waitForSelector('.dtp-menu-admin', { timeout: 10000 });
                await this.page.waitForTimeout(2000);

                logger.info('[Puppeteer] ? Sistema INSS pronto para uso');

            } catch (selectorError) {
                // Token pode estar expirado
                const currentUrl = this.page.url();

                if (currentUrl.includes('login') || currentUrl.includes('auth')) {
                    logger.error('[Puppeteer] ? Token expirado ou inv�lido! Redirecionado para login.');
                    logger.error('[Puppeteer] ?? Gere um novo token:');
                    logger.error('[Puppeteer]    1. Acesse https://atendimento.inss.gov.br');
                    logger.error('[Puppeteer]    2. Fa�a login manualmente (certificado + 2FA)');
                    logger.error('[Puppeteer]    3. Copie a nova URL com access_token');
                    logger.error('[Puppeteer]    4. Atualize INSS_ACCESS_TOKEN no .env');
                    throw new Error('Token expirado - necess�rio login manual');
                }

                // Se n�o redirecionou para login, pode ser problema de seletor
                logger.warn('[Puppeteer] ?? Seletores esperados n�o encontrados, mas URL parece correta');
                logger.info('[Puppeteer] Tentando continuar mesmo assim...');
            }

            // ? OPCIONAL: Verificar se CAPTCHA apareceu (raro com token, mas poss�vel)
            const captchaDetectado = await this.detectarCaptcha();

            if (captchaDetectado) {
                logger.warn('[Puppeteer] ?? CAPTCHA DETECTADO mesmo com token!');
                logger.warn('[Puppeteer] ? Resolvendo CAPTCHA automaticamente...');

                try {
                    // Usar o CaptchaService para resolver completamente (até 10 tentativas)
                    const captchaService = (await import('./CaptchaService')).default;
                    const sessionId = 'login-' + Date.now();
                    const resultado = await captchaService.resolverComRetry(this.page, sessionId, 10);

                    if (resultado.sucesso) {
                        logger.info(`[Puppeteer] ✅ CAPTCHA resolvido em ${resultado.detalhes?.tentativas || 'N/A'} tentativa(s)!`);
                    } else {
                        logger.error('[Puppeteer] ❌ Falha ao resolver CAPTCHA após múltiplas tentativas');
                        throw new Error('CAPTCHA não foi resolvido após múltiplas tentativas');
                    }
                } catch (error: any) {
                    logger.error('[Puppeteer] ❌ Erro ao resolver CAPTCHA:', error.message);
                    throw new Error('CAPTCHA não foi resolvido: ' + error.message);
                }
            }

            logger.info('[Puppeteer] Sistema INSS pronto para uso');
        } catch (error) {
            logger.error('[Puppeteer] Erro ao fazer login:', error);
            throw error;
        }
    }

    /**
     * ? NOVO: Verifica se CAPTCHA est� presente na p�gina
     * @returns true se CAPTCHA foi detectado
     */
    private async verificarCaptcha(): Promise<boolean> {
        if (!this.page) return false;

        try {
            // Seletores identificados do arquivo RECAPTCHA JANELA.txt
            const seletoresCaptcha = [
                '#modal-recaptcha', // Modal do CAPTCHA
                'div[role="dialog"][id="modal-recaptcha"]', // Modal com role
                'button#btn-modal-remarcar-agendamento-confirmar', // Bot�o confirmar
                'img[src^="data:image/png;base64"]', // Imagem do CAPTCHA (base64)
            ];

            // Verificar se algum seletor de CAPTCHA existe
            for (const seletor of seletoresCaptcha) {
                const elemento = await this.page.$(seletor);
                if (elemento) {
                    logger.warn(`[Puppeteer] CAPTCHA detectado via seletor: ${seletor}`);
                    return true;
                }
            }

            // Verificar tamb�m por texto caracter�stico
            const pageContent = await this.page.content();
            if (pageContent.includes('Desafio Recaptcha') ||
                pageContent.includes('Estamos com problemas para validar sua requisi��o')) {
                logger.warn('[Puppeteer] CAPTCHA detectado via conte�do da p�gina');
                return true;
            }

            return false;
        } catch (error) {
            logger.error('[Puppeteer] Erro ao verificar CAPTCHA:', error);
            return false;
        }
    }

    /**
     * Coleta lista de protocolos filtrados por data e status
     * @param dataInicio Data inicial do filtro
     * @param dataFim Data final do filtro
     * @param status Filtro de status: 'TODOS', 'EXIGENCIA', 'PENDENTE', 'CONCLUIDA', 'CANCELADA'
     * @returns Lista de protocolos encontrados
     */
    private servicosPorProtocolo: Map<string, string> = new Map();

    /**
     * Obtém o serviço extraído da lista para um protocolo específico
     * @param protocolo Número do protocolo
     * @returns Serviço extraído da lista ou undefined se não encontrado
     */
    obterServicoPorProtocolo(protocolo: string): string | undefined {
        return this.servicosPorProtocolo.get(protocolo);
    }

    async coletarProtocolos(
        dataInicio: Date,
        dataFim: Date,
        status: string = 'TODOS'
    ): Promise<string[]> {
        if (!this.page) throw new Error('Navegador n�o inicializado');

        try {
            logger.info(
                `[Puppeteer] Coletando protocolos de ${dataInicio.toLocaleDateString()} a ${dataFim.toLocaleDateString()}`
            );
            logger.info(`[Puppeteer] Filtro de status: ${status}`);

            // Aguardar conte�do React carregar (aplica��o de micro-frontend)
            // IMPORTANTE: React � din�mico e demora! Pode levar 20-40s para renderizar
            logger.info('[Puppeteer] ? Aguardando React renderizar completamente...');
            logger.info('[Puppeteer]    (Isso pode demorar at� 40 segundos - seja paciente!)');

            // Esperar inicial de 8s
            await this.page.waitForTimeout(8000);

            // Aguardar botão Buscar aparecer (polling com retry)
            logger.info('[Puppeteer] ?? Procurando botão "Buscar"...');
            let botaoEncontrado = false;
            let tentativas = 0;
            let recarregamentos = 0;
            const maxRecarregamentos = 1;

            let tentativasNovaAba = 0;
            const maxTentativasNovaAba = 2; // Máximo 2 tentativas com nova aba
            const timeoutMaximoTotal = 120000; // 2 minutos máximo total
            const inicioBusca = Date.now();

            while (!botaoEncontrado && (Date.now() - inicioBusca) < timeoutMaximoTotal) {
                tentativas = 0;

                while (tentativas < 15 && !botaoEncontrado && (Date.now() - inicioBusca) < timeoutMaximoTotal) { // 15 tentativas x 3s = 45s max
                    tentativas++;

                    // Wake-up: Simular interação humana a cada 2 tentativas para manter aba ativa
                    if (tentativas % 2 === 0 && this.page) {
                        try {
                            await this.page.hover('body');
                            await this.page.focus('body');
                            await this.page.mouse.move(10, 10);
                            await this.page.mouse.move(20, 20);
                        } catch (e) {
                            // Ignorar erros de wake-up (não crítico)
                        }
                    }

                    // Tentar múltiplos seletores para o botão "Buscar"
                    botaoEncontrado = await this.page.evaluate(() => {
                        // Seletor principal
                        let botao = document.querySelector('.buscar button.dtp-btn.dtp-secondary') as HTMLElement;

                        // Seletores alternativos
                        if (!botao) {
                            botao = document.querySelector('button.dtp-btn.dtp-secondary') as HTMLElement;
                        }
                        if (!botao) {
                            const botoes = Array.from(document.querySelectorAll('button'));
                            botao = botoes.find(b => {
                                const texto = b.textContent?.toLowerCase() || '';
                                return texto.includes('buscar') && b.offsetParent !== null;
                            }) as HTMLElement;
                        }
                        if (!botao) {
                            // Tentar por aria-label ou title
                            botao = Array.from(document.querySelectorAll('button')).find(b => {
                                const ariaLabel = b.getAttribute('aria-label')?.toLowerCase() || '';
                                const title = b.getAttribute('title')?.toLowerCase() || '';
                                return (ariaLabel.includes('buscar') || title.includes('buscar')) && b.offsetParent !== null;
                            }) as HTMLElement;
                        }

                        if (!botao) return false;
                        const rect = botao.getBoundingClientRect();
                        return rect.width > 0 && rect.height > 0 && botao.offsetParent !== null;
                    });

                    if (botaoEncontrado) {
                        logger.info(`[Puppeteer] ✅ Botão "Buscar" encontrado após ${tentativas * 3}s!`);
                        break;
                    }

                    if (tentativas % 3 === 0) {
                        logger.info(`[Puppeteer]    ⏳  ${tentativas * 3}s... ainda aguardando React renderizar...`);
                    }
                    await this.page.waitForTimeout(3000);
                }

                // Se não encontrou após 15 tentativas (45s), tentar recarregar ou abrir nova aba
                if (!botaoEncontrado) {
                    if (recarregamentos < maxRecarregamentos) {
                        recarregamentos++;
                        logger.warn(`[Puppeteer] ⚠️ Botão "Buscar" não apareceu após 45s. Recarregando página (${recarregamentos}/${maxRecarregamentos})...`);
                        await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
                        const urlAtual = this.page.url();
                        await this.tratarTelaErroLogin(urlAtual);
                        await this.page.waitForTimeout(5000);
                        logger.info('[Puppeteer] 🔁 Tentando localizar o botão "Buscar" novamente após reload...');
                    } else if (tentativasNovaAba < maxTentativasNovaAba && this.ultimoTokenPat) {
                        // Estratégia: Abrir nova aba e colar o link do PAT novamente
                        tentativasNovaAba++;
                        logger.warn(`[Puppeteer] ⚠️ Botão "Buscar" não apareceu após reload. Abrindo nova aba e colando link PAT (${tentativasNovaAba}/${maxTentativasNovaAba})...`);

                        try {
                            await this.reabrirPaginaComTokenPat(this.ultimoTokenPat, tentativasNovaAba);
                            await this.page.waitForTimeout(8000); // Aguardar React carregar na nova aba
                            logger.info('[Puppeteer] 🔁 Tentando localizar o botão "Buscar" na nova aba...');
                        } catch (error: any) {
                            logger.error(`[Puppeteer] ❌ Erro ao abrir nova aba: ${error.message}`);
                            // Continuar tentando mesmo com erro
                        }
                    } else {
                        // Timeout máximo atingido ou todas as tentativas esgotadas
                        break;
                    }
                }
            }
            if (!botaoEncontrado) {
                logger.error('[Puppeteer] ? Bot�o "Buscar" n�o apareceu ap�s 45 segundos!');
                logger.error('[Puppeteer]    React n�o carregou completamente ou p�gina est� quebrada.');
                if (this.page) {
                    try {
                        const fs = require('fs');
                        await this.page.screenshot({ path: 'logs/buscar-missing.png', fullPage: true });
                        fs.writeFileSync('logs/buscar-missing.html', await this.page.content());
                        logger.error('[Puppeteer]    Snapshot salvo em logs/buscar-missing.* para inspe��o');
                    } catch (snapshotError) {
                        logger.warn('[Puppeteer]    N�o foi poss�vel salvar snapshot do erro:', snapshotError);
                    }
                }
                throw new Error('Bot�o "Buscar" n�o apareceu. React n�o renderizou.');
            }

            logger.info('[Puppeteer] ? Formul�rio de filtros carregado e pronto!');

            // Preencher datas
            const dataInicialStr = format(dataInicio, 'dd/MM/yyyy');
            const dataFinalStr = format(dataFim, 'dd/MM/yyyy');

            // Selecionar status conforme par�metro
            logger.info(`[Puppeteer] Selecionando status: ${status}...`);

            // Clicar no dropdown de status
            await this.page.click('#filtro-entidade-conveniada-status');
            await this.page.waitForTimeout(800);

            // Mapear status para value do bot�o
            const statusValueMap: Record<string, string> = {
                'TODOS': '',
                'EXIGENCIA': 'CUMPRIMENTO_DE_EXIGENCIA',
                'EXIG�NCIA': 'CUMPRIMENTO_DE_EXIGENCIA',
                'EM AN�LISE': 'PENDENTE',
                'PENDENTE': 'PENDENTE',
                'CONCLUIDA': 'CONCLUIDA',
                'CANCELADA': 'CANCELADA'
            };

            const statusValue = statusValueMap[status.toUpperCase()] || '';

            // Clicar no bot�o correto usando o atributo value
            const clicouStatus = await this.page.evaluate((value) => {
                const buttons = Array.from(document.querySelectorAll('.dtp-select-option'));
                const btn = buttons.find(b => (b as HTMLElement).getAttribute('value') === value) as HTMLElement;
                if (btn) {
                    btn.click();
                    return true;
                }
                return false;
            }, statusValue);

            if (!clicouStatus) {
                logger.warn(`[Puppeteer] ?? Bot�o de status n�o encontrado para value="${statusValue}"`);
            } else {
                logger.info(`[Puppeteer] ? Status selecionado: ${status} (value="${statusValue}")`);
            }

            await this.page.waitForTimeout(500);

            logger.info(`[Puppeteer] Preenchendo datas: ${dataInicialStr} - ${dataFinalStr}`);

            // Preencher datas de forma mais r�pida
            try {
                // Data Inicial
                await this.page.click('#filtro-entidade-conveniada-data-inicial');
                await this.page.waitForTimeout(200);
                await this.page.keyboard.down('Control');
                await this.page.keyboard.press('A');
                await this.page.keyboard.up('Control');
                await this.page.keyboard.type(dataInicialStr, { delay: 50 });
                await this.page.waitForTimeout(300);

                // Data Final
                await this.page.click('#filtro-entidade-conveniada-data-final');
                await this.page.waitForTimeout(200);
                await this.page.keyboard.down('Control');
                await this.page.keyboard.press('A');
                await this.page.keyboard.up('Control');
                await this.page.keyboard.type(dataFinalStr, { delay: 50 });
                await this.page.waitForTimeout(300);
            } catch (evalError: any) {
                logger.error(`[Puppeteer] Erro ao preencher datas: ${evalError.message}`);
                throw evalError;
            }

            // DEBUG: Verificar valores preenchidos
            const valoresPreenchidos = await this.page.evaluate(() => {
                const inicial = (document.querySelector('#filtro-entidade-conveniada-data-inicial') as HTMLInputElement)?.value;
                const final = (document.querySelector('#filtro-entidade-conveniada-data-final') as HTMLInputElement)?.value;
                const status = (document.querySelector('#filtro-entidade-conveniada-status') as HTMLSelectElement)?.value;
                return { inicial, final, status };
            });
            logger.info(`[Puppeteer] ?? Valores: Inicial=${valoresPreenchidos.inicial}, Final=${valoresPreenchidos.final}, Status=${valoresPreenchidos.status}`);

            // Clicar no bot�o Buscar
            logger.info('[Puppeteer] Clicando em Buscar...');
            await this.page.click('.buscar button.dtp-btn.dtp-secondary');

            // ?? CRITICAL: CAPTCHA pode demorar at� 5s para aparecer!
            logger.info('[Puppeteer] ? Aguardando 5s para CAPTCHA aparecer (se houver)...');
            await this.page.waitForTimeout(5000);

            // Verificar se CAPTCHA apareceu
            let captchaAposBuscar = await this.detectarCaptcha();

            // Se n�o detectou, aguardar mais 2s e tentar novamente (CAPTCHA pode estar carregando)
            if (!captchaAposBuscar) {
                logger.info('[Puppeteer] ?? Verificando novamente se CAPTCHA apareceu...');
                await this.page.waitForTimeout(2000);
                captchaAposBuscar = await this.detectarCaptcha();
            }

            if (captchaAposBuscar) {
                logger.warn('[Puppeteer] +--------------------------------------------------------------+');
                logger.warn('[Puppeteer] �  ?? CAPTCHA DETECTADO AP�S CLICAR EM BUSCAR!                 �');
                logger.warn('[Puppeteer] +--------------------------------------------------------------+');

                // ?? Resolver com captchaService (tenta OCR ? se falhar ? pede manual)
                const resolvido = await this.resolverCaptchaAutomatico('buscar-protocolos');

                if (!resolvido) {
                    logger.error('[Puppeteer] ? CAPTCHA n�o foi resolvido');
                    throw new Error('CAPTCHA n�o resolvido ap�s tentativas');
                }

                // ?? CRITICAL: Aguardar CAPTCHA fazer a liberação da request (cards ficam vazios até isso acontecer)
                // O CAPTCHA precisa liberar a request do HAR antes dos resultados aparecerem
                logger.info('[Puppeteer] ⏳ Aguardando CAPTCHA liberar request (cards ficam vazios até isso)...');

                // Verificar se modal realmente desapareceu (pode demorar alguns segundos)
                // IMPORTANTE: Se CAPTCHA foi rejeitado, um novo pode aparecer!
                let tentativasEspera = 0;
                let novoCaptchaApareceu = false;

                while (tentativasEspera < 10) {
                    await this.page.waitForTimeout(1000); // Aguardar 1s por vez
                    await this.page.hover('body'); // Heartbeat para manter página ativa
                    const modalAindaVisivel = await this.detectarCaptcha();

                    if (!modalAindaVisivel) {
                        logger.info(`[Puppeteer] ✅ Modal desapareceu após ${tentativasEspera + 1}s`);
                        break;
                    }

                    // Verificar se é um novo CAPTCHA (modal ainda visível após resolver)
                    // Se o modal ainda está visível após resolver, pode ser que o CAPTCHA foi rejeitado
                    // e um novo apareceu. Vamos tentar resolver novamente.
                    if (tentativasEspera >= 3) { // Aguardar pelo menos 3s antes de verificar novo CAPTCHA
                        logger.warn('[Puppeteer] ⚠️ Modal ainda visível após resolver - pode ser novo CAPTCHA!');
                        logger.warn('[Puppeteer] 🔄 Verificando se novo CAPTCHA apareceu e tentando resolver novamente...');

                        const resolvidoNovamente = await this.verificarEResolverNovoCaptcha('buscar-protocolos-retry', 'buscar-protocolos');
                        if (resolvidoNovamente) {
                            logger.info('[Puppeteer] ✅ Novo CAPTCHA resolvido! Aguardando modal desaparecer...');
                            // Resetar contador e aguardar modal desaparecer novamente
                            tentativasEspera = 0;
                            continue;
                        } else {
                            logger.error('[Puppeteer] ❌ Falha ao resolver novo CAPTCHA');
                            throw new Error('Novo CAPTCHA não foi resolvido após rejeição');
                        }
                    }

                    tentativasEspera++;
                    if (tentativasEspera % 2 === 0) {
                        logger.info(`[Puppeteer] ⏳ Aguardando modal desaparecer... (${tentativasEspera}s)`);
                    }
                }

                // Verificação final: se modal ainda está visível, pode ser novo CAPTCHA
                const modalAindaVisivelFinal = await this.detectarCaptcha();
                if (modalAindaVisivelFinal) {
                    logger.warn('[Puppeteer] ⚠️ Modal ainda visível após aguardar - verificando se é novo CAPTCHA...');
                    const resolvidoNovamente = await this.verificarEResolverNovoCaptcha('buscar-protocolos-retry-final', 'buscar-protocolos-final');

                    if (!resolvidoNovamente) {
                        logger.error('[Puppeteer] ❌ Falha ao resolver novo CAPTCHA na verificação final');
                        throw new Error('Novo CAPTCHA não foi resolvido após rejeição');
                    }
                }

                // Aguardar mais 3s após modal desaparecer para request ser liberada
                logger.info('[Puppeteer] ⏳ Aguardando request ser liberada e resultados carregarem (3s)...');
                await this.page.waitForTimeout(3000);
            } else {
                logger.info('[Puppeteer] ✅ Nenhum CAPTCHA detectado, prosseguindo...');
            }

            // ============================================================
            // ETAPA 1: Aguardar spinner desaparecer após resolver CAPTCHA
            // ============================================================
            logger.info('[Puppeteer] 🔍 [ETAPA 1/6] Aguardando spinner de loading desaparecer...');
            try {
                await this.page.waitForFunction(() => {
                    const spinner = document.querySelector('.loading, .spinner, .dtp-loading, [class*="loading"], [class*="spinner"]');
                    if (!spinner) return true;
                    return (spinner as HTMLElement).offsetParent === null;
                }, { timeout: 15000 });
                logger.info('[Puppeteer] ✅ [ETAPA 1/6] Spinner desapareceu');
            } catch {
                logger.warn('[Puppeteer] ⚠️ [ETAPA 1/6] Timeout ao aguardar spinner (pode já ter desaparecido)');
            }

            // Aguardar mais 2s extras para React popular a tabela
            logger.info('[Puppeteer] ⏳ Aguardando React popular tabela (2s)...');
            await this.page.waitForTimeout(2000);

            // ============================================================
            // ETAPA 2: Aguardar tabela aparecer no DOM
            // ============================================================
            logger.info('[Puppeteer] 🔍 [ETAPA 2/6] Aguardando tabela aparecer no DOM...');
            try {
                await this.page.waitForSelector('#tableConsultarTarefasEC tbody tr.dtp-table-wrapper-row, .dtp-table-empty, .react-bs-table-no-data', { timeout: 10000 });
                logger.info('[Puppeteer] ✅ [ETAPA 2/6] Tabela apareceu no DOM');
            } catch (waitError) {
                logger.warn('[Puppeteer] ⚠️ [ETAPA 2/6] Timeout ao aguardar tabela aparecer');
            }

            await this.page.waitForTimeout(3000);
            logger.info('[Puppeteer] ⏳ Aguardou 3s extras para garantir carregamento completo');

            // ============================================================
            // ETAPA 3: Verificar estado detalhado da tabela ANTES de verificar resultados
            // ============================================================
            logger.info('[Puppeteer] 🔍 [ETAPA 3/6] Verificando estado detalhado da tabela...');
            const debugTabela = await this.page.evaluate(() => {
                // Verificar múltiplos seletores possíveis
                const tabela1 = document.querySelector('#tableConsultarTarefasEC');
                const tabela2 = document.querySelector('.react-bs-table');
                const tabela3 = document.querySelector('.dtp-table');

                // Verificar linhas com múltiplos seletores
                const rows1 = document.querySelectorAll('#tableConsultarTarefasEC tbody tr.dtp-table-wrapper-row');
                const rows2 = document.querySelectorAll('.react-bs-table tbody tr');
                const rows3 = document.querySelectorAll('.dtp-table tbody tr');
                const rows4 = document.querySelectorAll('tbody tr');

                const emptyMsg = document.querySelector('.dtp-table-empty, .react-bs-table-no-data');
                const abaAtiva = document.querySelector('.dtp-nav-item.active a')?.textContent?.trim();
                const subAbaAtiva = document.querySelector('.tab-pane.active')?.id;

                // Verificar se há spinners ainda visíveis
                const spinner = document.querySelector('.loading, .spinner, .dtp-loading, [class*="loading"], [class*="spinner"]');
                const spinnerVisivel = spinner && (spinner as HTMLElement).offsetParent !== null;

                // Verificar se há CAPTCHA ainda visível
                const modal = document.querySelector('.dtp-modal, .modal, #modal-recaptcha');
                const blockUI = document.querySelector('.dtp-block-ui.blocked');
                const captchaVisivel = modal && (modal as HTMLElement).offsetParent !== null || !!blockUI;

                return {
                    tabela1Existe: !!tabela1,
                    tabela2Existe: !!tabela2,
                    tabela3Existe: !!tabela3,
                    totalLinhas1: rows1.length,
                    totalLinhas2: rows2.length,
                    totalLinhas3: rows3.length,
                    totalLinhas4: rows4.length,
                    temMensagemVazia: !!emptyMsg,
                    mensagemVazia: emptyMsg?.textContent?.trim(),
                    abaAtiva,
                    subAbaAtiva,
                    spinnerVisivel,
                    captchaVisivel,
                    htmlTabela1: tabela1?.innerHTML?.substring(0, 500) || 'Tabela1 não encontrada',
                    htmlTabela2: tabela2?.innerHTML?.substring(0, 500) || 'Tabela2 não encontrada'
                };
            });

            logger.info(`[Puppeteer] 📊 [ETAPA 3/6] Estado detalhado da tabela:`);
            logger.info(`   - Tabela #tableConsultarTarefasEC existe: ${debugTabela.tabela1Existe}`);
            logger.info(`   - Tabela .react-bs-table existe: ${debugTabela.tabela2Existe}`);
            logger.info(`   - Tabela .dtp-table existe: ${debugTabela.tabela3Existe}`);
            logger.info(`   - Linhas (#tableConsultarTarefasEC tbody tr.dtp-table-wrapper-row): ${debugTabela.totalLinhas1}`);
            logger.info(`   - Linhas (.react-bs-table tbody tr): ${debugTabela.totalLinhas2}`);
            logger.info(`   - Linhas (.dtp-table tbody tr): ${debugTabela.totalLinhas3}`);
            logger.info(`   - Linhas (tbody tr - todas): ${debugTabela.totalLinhas4}`);
            logger.info(`   - Aba ativa: ${debugTabela.abaAtiva || 'N/A'}`);
            logger.info(`   - Sub-aba: ${debugTabela.subAbaAtiva || 'N/A'}`);
            logger.info(`   - Mensagem vazia: ${debugTabela.mensagemVazia || 'Nenhuma'}`);
            logger.info(`   - Spinner ainda visível: ${debugTabela.spinnerVisivel}`);
            logger.info(`   - CAPTCHA ainda visível: ${debugTabela.captchaVisivel}`);

            // ============================================================
            // ETAPA 4: Verificar se há resultados usando TODOS os seletores possíveis
            // ============================================================
            logger.info('[Puppeteer] 🔍 [ETAPA 4/6] Verificando se há resultados (múltiplos seletores)...');
            // @ts-ignore - código executado no navegador, não precisa de tipos TypeScript
            const temResultados = await this.page.evaluate(() => {
                // Tentar múltiplos seletores - o que está funcionando é .react-bs-table ou .dtp-table
                const rows1 = document.querySelectorAll('.react-bs-table tbody tr.dtp-table-wrapper-row');
                const rows2 = document.querySelectorAll('.dtp-table tbody tr.dtp-table-wrapper-row');
                const rows3 = document.querySelectorAll('tbody tr.dtp-table-wrapper-row');

                // Usar o que tiver mais linhas
                const rows = rows1.length > 0 ? rows1 : (rows2.length > 0 ? rows2 : rows3);

                // Verificar se há linhas válidas (com protocolo na primeira coluna)
                let totalValidas = 0;
                for (let i = 0; i < rows.length; i++) {
                    const row = rows[i];
                    const primeiraColuna = row.querySelector('td:first-child');
                    if (primeiraColuna) {
                        const texto = primeiraColuna.textContent ? primeiraColuna.textContent.trim() : '';
                        if (texto && !texto.includes('Nenhum registro') && !texto.includes('encontrado')) {
                            const numeros = texto.replace(/\D+/g, '');
                            if (numeros.length >= 6) {
                                totalValidas++;
                            }
                        }
                    }
                }

                return {
                    temResultados: totalValidas > 0,
                    totalValidas: totalValidas,
                    totalLinhas: rows.length
                };
            });

            logger.info(`[Puppeteer] 📊 [ETAPA 4/6] Resultados encontrados:`);
            logger.info(`   - Total de linhas na tabela: ${temResultados.totalLinhas}`);
            logger.info(`   - Linhas válidas (com protocolo): ${temResultados.totalValidas}`);

            const temAlgumResultado = temResultados.temResultados;

            if (!temAlgumResultado) {
                logger.warn('[Puppeteer] ⚠️ [ETAPA 4/6] NENHUM resultado encontrado em nenhum seletor!');
                logger.warn(`[Puppeteer] ⚠️ Dica: Verifique se existem protocolos nesse período no sistema`);
                logger.warn(`[Puppeteer] ⚠️ Ou pode estar verificando muito cedo - aguardando mais 5s e tentando novamente...`);

                // Aguardar mais 5s e verificar novamente
                await this.page.waitForTimeout(5000);

                // @ts-ignore - código executado no navegador
                const segundaVerificacao = await this.page.evaluate(() => {
                    // Tentar múltiplos seletores
                    const rows1 = document.querySelectorAll('.react-bs-table tbody tr.dtp-table-wrapper-row');
                    const rows2 = document.querySelectorAll('.dtp-table tbody tr.dtp-table-wrapper-row');
                    const rows3 = document.querySelectorAll('tbody tr.dtp-table-wrapper-row');

                    // Usar o que tiver mais linhas
                    const rows = rows1.length > 0 ? rows1 : (rows2.length > 0 ? rows2 : rows3);

                    let totalValidas = 0;
                    for (let i = 0; i < rows.length; i++) {
                        const row = rows[i];
                        const primeiraColuna = row.querySelector('td:first-child');
                        if (primeiraColuna) {
                            const texto = primeiraColuna.textContent ? primeiraColuna.textContent.trim() : '';
                            if (texto && !texto.includes('Nenhum registro') && !texto.includes('encontrado')) {
                                const numeros = texto.replace(/\D+/g, '');
                                if (numeros.length >= 6) {
                                    totalValidas++;
                                }
                            }
                        }
                    }

                    return {
                        temResultados: totalValidas > 0,
                        totalValidas: totalValidas,
                        totalLinhas: rows.length
                    };
                });

                logger.info(`[Puppeteer] 📊 Segunda verificação após 5s:`);
                logger.info(`   - Total de linhas: ${segundaVerificacao.totalLinhas}`);
                logger.info(`   - Linhas válidas: ${segundaVerificacao.totalValidas}`);

                const temAlgumResultadoSegunda = segundaVerificacao.temResultados;

                if (!temAlgumResultadoSegunda) {
                    logger.error('[Puppeteer] ❌ [ETAPA 4/6] Nenhum resultado encontrado mesmo após segunda verificação');
                    return [];
                }
            } else {
                logger.info('[Puppeteer] ✅ [ETAPA 4/6] Resultados encontrados! Prosseguindo para expandir...');
            }

            // DEBUG: Salvar screenshot após verificar resultados
            await this.page.screenshot({ path: 'logs/after-search.png', fullPage: true });
            const fs = require('fs');
            fs.writeFileSync('logs/after-search.html', await this.page.content());
            logger.info('[Puppeteer] 📸 Debug: Screenshot e HTML após busca salvos');

            // ============================================================
            // ETAPA 5: Verificar se precisa expandir para 500 itens
            // ============================================================
            logger.info('[Puppeteer] 🔍 [ETAPA 5/6] Verificando se precisa expandir para 500 itens...');

            // Verificar o rodapé que mostra "X de Y" para saber o total de resultados
            const infoPaginacao = await this.page.evaluate(() => {
                // Procurar pelo rodapé que mostra "10 de 25" ou similar
                // Tentar múltiplos seletores comuns para rodapé de paginação
                const seletores = [
                    '.dtp-pagination-info',
                    '.pagination-info',
                    '[class*="pagination-info"]',
                    '[class*="pagination"]',
                    '.dtp-footer',
                    '.table-footer',
                    '[id*="pagination"]',
                    '[id*="info"]'
                ];

                let rodape: Element | null = null;
                for (const seletor of seletores) {
                    rodape = document.querySelector(seletor);
                    if (rodape) break;
                }

                // Se não encontrou por seletor, procurar por texto que contenha padrão "X de Y"
                if (!rodape) {
                    const todosElementos = document.querySelectorAll('*');
                    for (const el of Array.from(todosElementos)) {
                        const texto = el.textContent || '';
                        if (/\d+\s*(?:de|of|-)\s*\d+/.test(texto) && texto.length < 100) {
                            rodape = el;
                            break;
                        }
                    }
                }

                if (!rodape) return null;

                const texto = rodape.textContent || '';
                // Padrão: "10 de 25" ou "Mostrando 10 de 25" ou "1 - 10 de 36" ou "10-10 de 10"
                // Priorizar padrão "X - Y de Z" (onde Z é o total)
                let match = texto.match(/(\d+)\s*-\s*(\d+)\s+de\s+(\d+)/i);
                if (match) {
                    // Formato "1 - 10 de 36": match[1] = início, match[2] = fim, match[3] = total
                    const total = parseInt(match[3]);
                    const fim = parseInt(match[2]);
                    return { atual: fim, total, texto: texto.trim() };
                }
                // Fallback: padrão simples "X de Y"
                match = texto.match(/(\d+)\s*(?:de|of|-)\s*(\d+)/i);
                if (match) {
                    const atual = parseInt(match[1]);
                    const total = parseInt(match[2]);
                    return { atual, total, texto: texto.trim() };
                }
                return null;
            });

            let precisaExpandir = true;
            if (infoPaginacao) {
                logger.info(`[Puppeteer] 📊 [ETAPA 5/6] Rodapé encontrado: "${infoPaginacao.texto}" (${infoPaginacao.atual} de ${infoPaginacao.total})`);
                if (infoPaginacao.total <= 10) {
                    precisaExpandir = false;
                    logger.info(`[Puppeteer] ✅ [ETAPA 5/6] Total de ${infoPaginacao.total} itens (≤10), não precisa expandir para 500`);
                } else {
                    logger.info(`[Puppeteer] ✅ [ETAPA 5/6] Total de ${infoPaginacao.total} itens (>10), precisa expandir para 500`);
                }
            } else {
                logger.warn('[Puppeteer] ⚠️ [ETAPA 5/6] Rodapé não encontrado, expandindo por segurança');
            }

            if (precisaExpandir) {
                logger.info('[Puppeteer] 🔍 [ETAPA 5/6] Expandindo para 500 itens...');

                // 1. Clicar no dropdown para abrir
                logger.info('[Puppeteer] 🔍 [ETAPA 5/6] Clicando no dropdown de paginação...');
                try {
                    await this.page.click('#dtpSelectPageSize');
                    logger.info('[Puppeteer] ✅ [ETAPA 5/6] Dropdown aberto');
                    await this.page.waitForTimeout(1000);
                } catch (error) {
                    logger.warn('[Puppeteer] ⚠️ [ETAPA 5/6] Erro ao abrir dropdown:', error);
                }

                // 2. Clicar na opção 500
                logger.info('[Puppeteer] 🔍 [ETAPA 5/6] Procurando opção 500 no dropdown...');
                const clicouEm500 = await this.page.evaluate(() => {
                    const opcoes = Array.from(document.querySelectorAll('.dtp-select-option'));
                    // @ts-ignore - código JavaScript puro no navegador
                    const opcao500 = opcoes.find((btn) => btn.value === '500' || btn.textContent?.trim() === '500');
                    if (opcao500) {
                        (opcao500 as HTMLButtonElement).click();
                        return { clicou: true, totalOpcoes: opcoes.length };
                    }
                    return { clicou: false, totalOpcoes: opcoes.length };
                });

                logger.info(`[Puppeteer] 📊 [ETAPA 5/6] Encontradas ${clicouEm500.totalOpcoes} opções no dropdown`);

                if (clicouEm500.clicou) {
                    logger.info('[Puppeteer] ✅ [ETAPA 5/6] Opção 500 selecionada');
                    logger.info('[Puppeteer] ⏳ [ETAPA 5/6] Aguardando loading... (pode aparecer CAPTCHA)');

                    // ?? Aguardar 3s e verificar CAPTCHA pela primeira vez
                    await this.page.waitForTimeout(3000);
                    let captchaVisivel = await this.detectarCaptcha();

                    if (captchaVisivel) {
                        logger.warn('[Puppeteer] ⚠️ CAPTCHA DETECTADO após selecionar 500 itens!');

                        try {
                            const resolvido = await this.resolverCaptchaAutomatico('expandir-500');

                            if (!resolvido) {
                                logger.error('[Puppeteer] ❌ CAPTCHA não foi resolvido automaticamente');
                                logger.warn('[Puppeteer] ⚠️ Aguardando 10 segundos para ver se resolve automaticamente...');
                                await this.page.waitForTimeout(10000);

                                const aindaVisivel = await this.detectarCaptcha();
                                if (!aindaVisivel) {
                                    logger.info('[Puppeteer] ✅ CAPTCHA resolvido após espera.');
                                } else {
                                    logger.error('[Puppeteer] ❌ CAPTCHA ainda visível - continuando mesmo assim...');
                                }
                            } else {
                                // CRITICAL: Aguardar CAPTCHA liberar request após resolver
                                logger.info('[Puppeteer] ⏳ Aguardando CAPTCHA liberar request (3s)...');
                                await this.page.waitForTimeout(3000);
                            }
                        } catch (error: any) {
                            logger.error(`[Puppeteer] ❌ Erro ao resolver CAPTCHA: ${error.message}`);
                            logger.warn('[Puppeteer] ⚠️ Aguardando 10 segundos para ver se resolve automaticamente...');
                            await this.page.waitForTimeout(10000);

                            const aindaVisivel = await this.detectarCaptcha();
                            if (!aindaVisivel) {
                                logger.info('[Puppeteer] ✅ CAPTCHA resolvido após espera.');
                                // Aguardar liberação da request mesmo após espera
                                await this.page.waitForTimeout(3000);
                            } else {
                                logger.error('[Puppeteer] ❌ CAPTCHA ainda visível - continuando mesmo assim...');
                            }
                        }

                        // Verificar se modal já desapareceu (pode ter sido resolvido rapidamente)
                        const modalJaDesapareceu = await this.page.evaluate(() => {
                            const modal = document.querySelector('.dtp-modal, .modal, #modal-recaptcha');
                            const blockUI = document.querySelector('.dtp-block-ui.blocked');
                            if (modal) {
                                const style = window.getComputedStyle(modal as HTMLElement);
                                const modalVisivel = style.display !== 'none' && (modal as HTMLElement).offsetParent !== null;
                                return !modalVisivel && !blockUI;
                            }
                            return !blockUI;
                        });

                        if (!modalJaDesapareceu) {
                            logger.info('[Puppeteer] ⏳ Aguardando modal desaparecer após resolver CAPTCHA...');
                            // Aguardar modal desaparecer (timeout reduzido para 10s, já que CAPTCHA foi resolvido)
                            // IMPORTANTE: Verificar se novo CAPTCHA apareceu durante a espera
                            let tentativasEsperaModal = 0;
                            while (tentativasEsperaModal < 10) {
                                await this.page.waitForTimeout(1000);
                                await this.page.hover('body'); // Heartbeat para manter página ativa
                                const modalAindaVisivel = await this.detectarCaptcha();

                                if (!modalAindaVisivel) {
                                    logger.info(`[Puppeteer] ✅ Modal desapareceu após ${tentativasEsperaModal + 1}s`);
                                    break;
                                }

                                // Se modal ainda visível após 3s, pode ser novo CAPTCHA
                                if (tentativasEsperaModal >= 3) {
                                    const resolvidoNovamente = await this.verificarEResolverNovoCaptcha('expandir-500-retry', 'expandir-500');
                                    if (resolvidoNovamente) {
                                        tentativasEsperaModal = 0; // Resetar contador
                                        continue;
                                    }
                                }

                                tentativasEsperaModal++;
                            }

                            // Verificação final
                            const modalAindaVisivelFinal = await this.detectarCaptcha();
                            if (modalAindaVisivelFinal) {
                                await this.verificarEResolverNovoCaptcha('expandir-500-retry-final', 'expandir-500-final');
                            }
                        } else {
                            logger.info('[Puppeteer] ✅ Modal já havia desaparecido');
                        }
                    }

                    // Aguardar spinner NOVAMENTE (pode aparecer ap�s resolver CAPTCHA ou mudar para 500)
                    logger.info('[Puppeteer] ? Aguardando spinner desaparecer...');
                    try {
                        await this.page.waitForFunction(() => {
                            const spinner = document.querySelector('.loading, .spinner, .dtp-loading, [class*="loading"], [class*="spinner"]');
                            if (!spinner) return true;
                            return (spinner as HTMLElement).offsetParent === null;
                        }, { timeout: 15000 });
                        logger.info('[Puppeteer] ? Spinner desapareceu');
                    } catch {
                        logger.warn('[Puppeteer] ?? Timeout aguardando spinner (pode j� ter carregado)');
                    }

                    // ?? Verificar CAPTCHA NOVAMENTE ap�s spinner (pode aparecer s� agora!)
                    await this.page.waitForTimeout(2000);
                    captchaVisivel = await this.detectarCaptcha();

                    if (captchaVisivel) {
                        logger.warn('[Puppeteer] ?? CAPTCHA DETECTADO ap�s loading (2� verifica��o)!');

                        try {
                            const resolvido = await this.resolverCaptchaAutomatico('expandir-500-pos-loading');

                            if (!resolvido) {
                                logger.error('[Puppeteer] ❌ CAPTCHA não foi resolvido automaticamente');
                                logger.warn('[Puppeteer] ⚠️ Aguardando 10 segundos para ver se resolve automaticamente...');
                                await this.page.waitForTimeout(10000);

                                const aindaVisivel = await this.detectarCaptcha();
                                if (!aindaVisivel) {
                                    logger.info('[Puppeteer] ✅ CAPTCHA resolvido após espera.');
                                    // Aguardar liberação da request mesmo após espera
                                    await this.page.waitForTimeout(3000);
                                } else {
                                    logger.error('[Puppeteer] ❌ CAPTCHA ainda visível - continuando mesmo assim...');
                                }
                            } else {
                                // CRITICAL: Aguardar CAPTCHA liberar request após resolver
                                logger.info('[Puppeteer] ⏳ Aguardando CAPTCHA liberar request (3s)...');
                                await this.page.waitForTimeout(3000);
                            }
                        } catch (error: any) {
                            logger.error(`[Puppeteer] ❌ Erro ao resolver CAPTCHA: ${error.message}`);
                            logger.warn('[Puppeteer] ⚠️ Aguardando 10 segundos para ver se resolve automaticamente...');
                            await this.page.waitForTimeout(10000);

                            const aindaVisivel = await this.detectarCaptcha();
                            if (!aindaVisivel) {
                                logger.info('[Puppeteer] ✅ CAPTCHA resolvido após espera.');
                                // Aguardar liberação da request mesmo após espera
                                await this.page.waitForTimeout(3000);
                            } else {
                                logger.error('[Puppeteer] ❌ CAPTCHA ainda visível - continuando mesmo assim...');
                            }
                        }

                        // Verificar se modal já desapareceu
                        const modalJaDesapareceu2 = await this.page.evaluate(() => {
                            const modal = document.querySelector('.dtp-modal, .modal, #modal-recaptcha');
                            if (!modal) return true;
                            const style = window.getComputedStyle(modal as HTMLElement);
                            return style.display === 'none' || (modal as HTMLElement).offsetParent === null;
                        });

                        if (!modalJaDesapareceu2) {
                            logger.info('[Puppeteer] ⏳ Aguardando modal desaparecer após resolver CAPTCHA (2ª verificação)...');
                            // IMPORTANTE: Verificar se novo CAPTCHA apareceu durante a espera
                            let tentativasEsperaModal2 = 0;
                            while (tentativasEsperaModal2 < 10) {
                                await this.page.waitForTimeout(1000);
                                await this.page.hover('body'); // Heartbeat para manter página ativa
                                const modalAindaVisivel = await this.detectarCaptcha();

                                if (!modalAindaVisivel) {
                                    logger.info(`[Puppeteer] ✅ Modal desapareceu após ${tentativasEsperaModal2 + 1}s (2ª verificação)`);
                                    break;
                                }

                                // Se modal ainda visível após 3s, pode ser novo CAPTCHA
                                if (tentativasEsperaModal2 >= 3) {
                                    const resolvidoNovamente = await this.verificarEResolverNovoCaptcha('expandir-500-pos-loading-retry', 'expandir-500-pos-loading');
                                    if (resolvidoNovamente) {
                                        tentativasEsperaModal2 = 0; // Resetar contador
                                        continue;
                                    }
                                }

                                tentativasEsperaModal2++;
                            }

                            // Verificação final
                            const modalAindaVisivelFinal2 = await this.detectarCaptcha();
                            if (modalAindaVisivelFinal2) {
                                await this.verificarEResolverNovoCaptcha('expandir-500-pos-loading-retry-final', 'expandir-500-pos-loading-final');
                            }
                        } else {
                            logger.info('[Puppeteer] ✅ Modal já havia desaparecido (2ª verificação)');
                        }
                    }

                    logger.info('[Puppeteer] ⏳ [ETAPA 5/6] Aguardando React renderizar 500 itens (3s)...');
                    await this.page.waitForTimeout(3000);

                    // Verificar quantas linhas foram renderizadas após expandir
                    const linhasAposExpandir = await this.page.evaluate(() => {
                        const rows1 = document.querySelectorAll('#tableConsultarTarefasEC tbody tr.dtp-table-wrapper-row');
                        const rows2 = document.querySelectorAll('.react-bs-table tbody tr');
                        const rows3 = document.querySelectorAll('.dtp-table tbody tr');
                        return {
                            total1: rows1.length,
                            total2: rows2.length,
                            total3: rows3.length
                        };
                    });
                    logger.info(`[Puppeteer] 📊 [ETAPA 5/6] Linhas após expandir: #tableConsultarTarefasEC=${linhasAposExpandir.total1}, .react-bs-table=${linhasAposExpandir.total2}, .dtp-table=${linhasAposExpandir.total3}`);
                } else {
                    logger.warn('[Puppeteer] ⚠️ [ETAPA 5/6] Não foi possível selecionar opção 500');
                }
            } else {
                logger.info('[Puppeteer] ✅ [ETAPA 5/6] Pulando expansão (≤10 itens encontrados)');
                await this.page.waitForTimeout(2000);
            }

            // ============================================================
            // ETAPA 6: Extrair lista de protocolos da tabela
            // ============================================================
            logger.info('[Puppeteer] 🔍 [ETAPA 6/6] Extraindo protocolos da tabela...');

            // Verificar estado antes de coletar
            const estadoAntesColetar = await this.page.evaluate(() => {
                const rows1 = document.querySelectorAll('#tableConsultarTarefasEC tbody tr.dtp-table-wrapper-row');
                const rows2 = document.querySelectorAll('.react-bs-table tbody tr');
                const rows3 = document.querySelectorAll('.dtp-table tbody tr');
                return {
                    total1: rows1.length,
                    total2: rows2.length,
                    total3: rows3.length
                };
            });
            logger.info(`[Puppeteer] 📊 [ETAPA 6/6] Estado antes de coletar: #tableConsultarTarefasEC=${estadoAntesColetar.total1}, .react-bs-table=${estadoAntesColetar.total2}, .dtp-table=${estadoAntesColetar.total3}`);

            // Extrair lista de protocolos da tabela usando o seletor correto
            // @ts-ignore - código executado no navegador
            const resultadoColeta = await this.page.evaluate(() => {
                // Tentar múltiplos seletores - usar o que encontrar linhas
                const rows1 = document.querySelectorAll('.react-bs-table tbody tr.dtp-table-wrapper-row');
                const rows2 = document.querySelectorAll('.dtp-table tbody tr.dtp-table-wrapper-row');
                const rows3 = document.querySelectorAll('tbody tr.dtp-table-wrapper-row');

                // Usar o que tiver mais linhas
                const rows = rows1.length > 0 ? rows1 : (rows2.length > 0 ? rows2 : rows3);

                const protocolosEncontrados = [];
                const linhasInvalidas = [];

                for (let i = 0; i < rows.length; i++) {
                    const row = rows[i];
                    // Primeira coluna (td[1]) contém o protocolo
                    const primeiraColuna = row.querySelector('td:first-child');
                    // Segunda coluna (td[2]) contém o serviço
                    const segundaColuna = row.querySelector('td:nth-child(2)');

                    if (!primeiraColuna) {
                        linhasInvalidas.push({ linha: i + 1, texto: '', motivo: 'Primeira coluna não encontrada' });
                        continue;
                    }

                    const texto = primeiraColuna.textContent ? primeiraColuna.textContent.trim() : '';

                    // Filtrar mensagens de "Nenhum registro" ou linhas vazias
                    if (!texto || texto.includes('Nenhum registro') || texto.includes('encontrado')) {
                        linhasInvalidas.push({ linha: i + 1, texto: texto, motivo: 'Mensagem vazia ou inválida' });
                        continue;
                    }

                    // Extrair apenas números (protocolo)
                    const numeros = texto.replace(/\D+/g, '');
                    if (numeros.length >= 6) { // Protocolos tem 6+ dígitos
                        // Extrair serviço da segunda coluna
                        const servico = segundaColuna && segundaColuna.textContent
                            ? segundaColuna.textContent.trim()
                            : '';

                        protocolosEncontrados.push({
                            protocolo: numeros,
                            servico: servico
                        });
                    } else {
                        linhasInvalidas.push({ linha: i + 1, texto: texto, motivo: 'Apenas ' + numeros.length + ' dígitos (mínimo 6)' });
                    }
                }

                return {
                    protocolos: protocolosEncontrados,
                    totalLinhasProcessadas: rows.length,
                    linhasInvalidas: linhasInvalidas.slice(0, 5), // Primeiras 5 inválidas para debug
                    seletorUsado: rows1.length > 0 ? '.react-bs-table tbody tr.dtp-table-wrapper-row' : (rows2.length > 0 ? '.dtp-table tbody tr.dtp-table-wrapper-row' : 'tbody tr.dtp-table-wrapper-row')
                };
            });

            logger.info(`[Puppeteer] 🔍 [ETAPA 6/6] Coletando de ${resultadoColeta.totalLinhasProcessadas} linhas encontradas`);

            if (resultadoColeta.linhasInvalidas.length > 0) {
                logger.info(`[Puppeteer] 📊 [ETAPA 6/6] Exemplos de linhas inválidas (primeiras 5):`);
                resultadoColeta.linhasInvalidas.forEach(invalida => {
                    logger.info(`[Puppeteer]    - Linha ${invalida.linha}: "${invalida.texto.substring(0, 50)}" (${invalida.motivo})`);
                });
            }

            const protocolos = resultadoColeta;

            logger.info(`[Puppeteer] 📊 [ETAPA 6/6] Coleta concluída:`);
            logger.info(`   - Seletor usado: ${protocolos.seletorUsado}`);
            logger.info(`   - Total de linhas processadas: ${protocolos.totalLinhasProcessadas}`);
            logger.info(`   - Protocolos encontrados: ${protocolos.protocolos.length}`);

            if (protocolos.protocolos.length > 0) {
                const primeiros5 = protocolos.protocolos.slice(0, 5).map((p: any) => {
                    if (typeof p === 'string') return p;
                    return `${p.protocolo}${p.servico ? ` (${p.servico})` : ''}`;
                });
                logger.info(`[Puppeteer] ✅ [ETAPA 6/6] Primeiros 5 protocolos: ${primeiros5.join(', ')}`);
            } else {
                logger.warn(`[Puppeteer] ⚠️ [ETAPA 6/6] NENHUM protocolo encontrado após processar ${protocolos.totalLinhasProcessadas} linhas!`);
                logger.warn(`[Puppeteer] ⚠️ Isso pode indicar que:`);
                logger.warn(`[Puppeteer] ⚠️   1. Os resultados ainda não carregaram completamente`);
                logger.warn(`[Puppeteer] ⚠️   2. O seletor está incorreto`);
                logger.warn(`[Puppeteer] ⚠️   3. Não há protocolos no período especificado`);
                logger.warn(`[Puppeteer] ⚠️   4. As linhas estão sendo renderizadas mas não têm conteúdo válido`);
            }

            logger.info(`[Puppeteer] ✅ Total final: ${protocolos.protocolos.length} protocolos encontrados`);

            // Armazenar serviços em mapa interno para acesso posterior
            this.servicosPorProtocolo.clear();
            protocolos.protocolos.forEach((p: any) => {
                if (typeof p !== 'string' && p.servico) {
                    this.servicosPorProtocolo.set(p.protocolo, p.servico);
                    logger.info(`[Puppeteer] 📋 Serviço armazenado para protocolo ${p.protocolo}: ${p.servico}`);
                }
            });

            // Retornar array de strings (protocolos) para manter compatibilidade
            return protocolos.protocolos.map((p: any) => typeof p === 'string' ? p : p.protocolo);
        } catch (error) {
            logger.error('[Puppeteer] Erro ao coletar protocolos:', error);
            throw error;
        }
    }

    /**
     * Extrai detalhes completos de um protocolo espec�fico
     * @param protocolo N�mero do protocolo
     * @returns Dados completos do processo
     */
    async extrairDetalhesProcesso(protocolo: string): Promise<ProcessoINSS> {
        if (!this.page) throw new Error('Navegador n�o inicializado');

        try {
            logger.info(`[Puppeteer] Extraindo detalhes do protocolo ${protocolo}`);

            // Navegar diretamente para p�gina de detalhes
            const urlDetalhes = `${config.inss.url.replace('/#', '')}/tarefas/detalhar_tarefa/${protocolo}`;
            logger.info(`[Puppeteer] Navegando para: ${urlDetalhes}`);

            await this.page.goto(urlDetalhes, { waitUntil: 'networkidle2', timeout: 30000 });

            // Aguardar spinner desaparecer
            logger.info('[Puppeteer] ? Aguardando spinner desaparecer...');
            await this.page.waitForTimeout(3000);

            try {
                await this.page.waitForSelector('.dtp-block-ui.blocked', { timeout: 10000 });
                await this.page.waitForFunction(() => {
                    const spinner = document.querySelector('.dtp-block-ui.blocked');
                    return !spinner;
                }, { timeout: 30000 });
                logger.info('[Puppeteer] ? Spinner desapareceu');
            } catch {
                logger.warn('[Puppeteer] ?? Spinner n�o detectado');
                await this.page.waitForTimeout(5000);
            }

            await this.page.waitForTimeout(2000);

            // Aguardar elementos carregarem
            await this.page.waitForSelector('.dtp-datagrid-label', { timeout: 20000 });

            // Extrair dados usando $$eval (mais seguro)
            logger.info('[Puppeteer] ?? Extraindo dados b�sicos...');

            const labelsData = await this.page.$$eval('.dtp-datagrid-label', (labels) => {
                return labels.map(label => {
                    const text = label.textContent ? label.textContent.trim() : '';
                    const valueEl = label.nextElementSibling;
                    const value = valueEl && valueEl.textContent ? valueEl.textContent.trim() : '';
                    return { label: text, value: value };
                });
            });

            const getValor = (label: string): string => {
                const item = labelsData.find(d => d.label === label);
                return item ? item.value : '';
            };

            const dados = {
                protocolo: getValor('Protocolo'),
                cpf: getValor('CPF'),
                nome: getValor('Nome Completo'),
                beneficio: getValor('Servi�o'),
                der: getValor('Data da Solicita��o'),
                status: getValor('Status'),
            };

            logger.info(`[Puppeteer] ? Dados: ${dados.nome} | CPF: ${dados.cpf}`);

            // Extrair TEXTO COMPLETO da aba "Exig�ncia" ou "Coment�rios"
            // Se status for CONCLU�DA ou CANCELADA, usar aba "Coment�rios"
            // Caso contr�rio, usar aba "Exig�ncia" (para CUMPRIMENTO_DE_EXIGENCIA)

            const statusUpper = dados.status.toUpperCase();
            const isConcluidaOuCancelada =
                statusUpper.includes('CONCLU�DA') ||
                statusUpper.includes('CONCLUIDA') ||
                statusUpper.includes('CANCELADA') ||
                statusUpper.includes('CANCELADO');

            let textoCompleto = '';

            if (isConcluidaOuCancelada) {
                // Para processos CONCLU�DOS/CANCELADOS: ler aba "Coment�rios"
                logger.info(`[Puppeteer] Status '${dados.status}' detectado - extraindo da aba Coment�rios`);

                try {
                    // Tentar clicar na aba Coment�rios
                    const abaComentarios = await this.page.$('a[href="#comentarios"], a[aria-controls="comentarios"]');

                    if (abaComentarios) {
                        await abaComentarios.click();
                        await this.page.waitForTimeout(1500); // Aguardar carregar

                        textoCompleto = await this.page.evaluate(() => {
                            const comentarios = document.querySelectorAll('.comentario-tarefa .texto');
                            return Array.from(comentarios)
                                .map(c => c.textContent?.trim())
                                .filter(t => t)
                                .join(' + '); // Separar com " + " como no script VAT
                        });

                        if (!textoCompleto) {
                            logger.warn(`[Puppeteer] Aba Coment�rios vazia para protocolo ${protocolo}`);
                            textoCompleto = '(Coment�rios n�o encontrados)';
                        }
                    } else {
                        logger.warn(`[Puppeteer] Aba Coment�rios n�o encontrada para protocolo ${protocolo}`);
                        textoCompleto = '(Aba Coment�rios n�o dispon�vel)';
                    }
                } catch (error) {
                    logger.error(`[Puppeteer] Erro ao extrair Coment�rios do protocolo ${protocolo}:`, error);
                    textoCompleto = '(Erro ao extrair coment�rios)';
                }
            } else {
                // Para processos EM EXIG�NCIA: ler aba "Exig�ncia"
                logger.info(`[Puppeteer] Status '${dados.status}' detectado - extraindo da aba Exig�ncia`);

                try {
                    const abaExigencia = await this.page.$('a[href="#exigencia"], a[aria-controls="exigencia"]');

                    if (abaExigencia) {
                        logger.info('[Puppeteer] ?? Aba "Exig�ncia" encontrada, clicando...');
                        await abaExigencia.click();
                        await this.page.waitForTimeout(2000);

                        textoCompleto = await this.page.evaluate(() => {
                            const comentarios = document.querySelectorAll('.comentario-tarefa .texto, #exigencia .texto');
                            return Array.from(comentarios)
                                .map(c => c.textContent?.trim())
                                .filter(t => t)
                                .join('\n\n');
                        });

                        if (!textoCompleto) {
                            logger.warn(`[Puppeteer] Aba Exig�ncia vazia para protocolo ${protocolo}`);
                            textoCompleto = 'Sem despachos registrados';
                        } else {
                            logger.info(`[Puppeteer] ? Texto extra�do: ${textoCompleto.substring(0, 100)}...`);
                        }
                    } else {
                        logger.warn(`[Puppeteer] Aba Exig�ncia n�o encontrada para protocolo ${protocolo}`);
                        textoCompleto = 'Sem despachos registrados';
                    }
                } catch (error) {
                    logger.error(`[Puppeteer] Erro ao extrair Exig�ncia do protocolo ${protocolo}:`, error);
                    textoCompleto = 'Sem despachos registrados';
                }
            }

            // Converter DER string para Date
            const derParts = dados.der.split('/');
            const derDate = derParts.length === 3
                ? new Date(parseInt(derParts[2]), parseInt(derParts[1]) - 1, parseInt(derParts[0]))
                : new Date();

            // Extrair agendamentos (per�cias e avalia��es) durante a extra��o inicial
            logger.info(`[Puppeteer] Extraindo agendamentos do protocolo ${protocolo}...`);
            const agendamentosExtraidos: AgendamentoExtraido[] = [];

            try {
                // Importar AgendamentosService dinamicamente para evitar depend�ncia circular
                const { default: agendamentosService } = await import('./AgendamentosService');

                // Verificar se precisa de per�cia/avalia��o baseado no tipo de benef�cio
                const { precisaPericia, precisaAvaliacao } = agendamentosService.precisaPericiaOuAvaliacao(dados.beneficio);

                if (precisaAvaliacao) {
                    try {
                        const avaliacoes = await agendamentosService.extrairAvaliacoesSociais(this.page!, protocolo, dados.cpf);
                        const agendadas = agendamentosService.filtrarAgendados(avaliacoes);

                        for (const agendamento of agendadas) {
                            // Extrair detalhes completos incluindo URL do comprovante
                            const detalhes = await agendamentosService.extrairDetalhesAgendamento(this.page!, agendamento);
                            if (detalhes) {
                                agendamentosExtraidos.push({
                                    id: agendamento.id,
                                    tipo: 'AVALIACAO_SOCIAL',
                                    data: detalhes.data,
                                    hora: detalhes.hora,
                                    unidade: detalhes.unidade,
                                    endereco: detalhes.endereco,
                                    status: 'AGENDADO',
                                    servico: detalhes.servico,
                                    urlComprovante: detalhes.urlComprovante
                                });
                            }
                        }
                    } catch (error: any) {
                        logger.warn(`[Puppeteer] Erro ao extrair avalia��es sociais: ${error.message}`);
                    }
                }

                if (precisaPericia) {
                    try {
                        const pericias = await agendamentosService.extrairPericiasMedicas(this.page!, protocolo, dados.cpf);
                        const agendadas = agendamentosService.filtrarAgendados(pericias);

                        for (const agendamento of agendadas) {
                            // Extrair detalhes completos incluindo URL do comprovante
                            const detalhes = await agendamentosService.extrairDetalhesAgendamento(this.page!, agendamento);
                            if (detalhes) {
                                agendamentosExtraidos.push({
                                    id: agendamento.id,
                                    tipo: 'PERICIA',
                                    data: detalhes.data,
                                    hora: detalhes.hora,
                                    unidade: detalhes.unidade,
                                    endereco: detalhes.endereco,
                                    status: 'AGENDADO',
                                    servico: detalhes.servico,
                                    urlComprovante: detalhes.urlComprovante
                                });
                            }
                        }
                    } catch (error: any) {
                        logger.warn(`[Puppeteer] Erro ao extrair per�cias m�dicas: ${error.message}`);
                    }
                }

                if (agendamentosExtraidos.length > 0) {
                    logger.info(`[Puppeteer] ✅ ${agendamentosExtraidos.length} agendamento(s) extra�do(s) durante busca inicial`);
                }
            } catch (error: any) {
                logger.warn(`[Puppeteer] ⚠️ Erro ao extrair agendamentos (n�o cr�tico): ${error.message}`);
            }

            const resultado: ProcessoINSS = {
                protocolo: dados.protocolo,
                cpf: dados.cpf,
                nome: dados.nome,
                beneficio: dados.beneficio,
                der: derDate,
                status: dados.status,
                textoCompleto: textoCompleto || 'Sem despachos registrados',
            };

            logger.info(
                `[Puppeteer] Detalhes do protocolo ${protocolo} extra�dos com sucesso`
            );
            return resultado;
        } catch (error) {
            logger.error(
                `[Puppeteer] Erro ao extrair detalhes do protocolo ${protocolo}:`,
                error
            );
            throw error;
        }
    }

    /**
     * Detecta e resolve CAPTCHA (se necess�rio)
     * TODO: Implementar solu��o de CAPTCHA se o INSS usar
     */
    private async resolverCaptcha(): Promise<void> {
        // Op��es:
        // 1. Servi�o de terceiros (2Captcha, Anti-Captcha)
        // 2. IA pr�pria para resolver
        // 3. Notificar operador humano para resolver manualmente
    }

    /**
     * Verifica se est� logado no sistema
     */
    async verificarLogin(): Promise<boolean> {
        if (!this.page) return false;

        try {
            // Verificar se o menu lateral est� presente (s� aparece quando logado)
            const menuUsuario = await this.page.$('.user-card');
            const menuPrincipal = await this.page.$('.dtp-menu-admin');

            return menuUsuario !== null && menuPrincipal !== null;
        } catch {
            return false;
        }
    }

    /**
     * Tira screenshot para debug
     */
    async screenshot(nome: string): Promise<void> {
        if (!this.page) return;

        const path = `./logs/screenshots/${nome}-${Date.now()}.png`;
        await this.page.screenshot({ path, fullPage: true });
        logger.info(`[Puppeteer] Screenshot salvo: ${path}`);
    }

    /**
     * ?? Extrai detalhes completos de um protocolo espec�fico
     * 
     * @param protocolo - N�mero do protocolo (ex: "2106764572")
     * @param filtroAplicado - Metadados da busca original (per�odo + status)
     * @returns Objeto com todos os dados extra�dos + HTML completo
     */



    /**
 * Extrai detalhes completos de um protocolo INSS
 * Implementa retry automático para erros 406 e de rede
 * 
 * @param protocolo - Número do protocolo INSS
 * @param filtroAplicado - Filtros de data e status aplicados na busca
 * @param maxTentativas - Número máximo de tentativas em caso de erro (padrão: 1)
 * @returns Objeto com todos os dados extraídos + HTML completo
 */
    async extrairDetalhesProtocolo(
        protocolo: string,
        filtroAplicado: { dataInicio: Date; dataFim: Date; status: string },
        maxTentativas: number = 1
    ): Promise<ProtocoloDetalhado> {
        if (!this.page) throw new Error('Navegador não inicializado');

        const urlDetalhes = `${config.inss.url.replace('/#', '')}/tarefas/detalhar_tarefa/${protocolo}`;

        for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
            try {
                if (tentativa > 1) {
                    logger.info(`[Puppeteer] 🔄 Tentativa ${tentativa}/${maxTentativas} para protocolo ${protocolo}...`);
                    // Recarregar página (F5)
                    await this.page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
                    await this.page.waitForTimeout(2000);
                } else {
                    logger.info(`[Puppeteer] 🔍 Extraindo detalhes do protocolo ${protocolo}...`);
                    logger.info(`[Puppeteer] Navegando para: ${urlDetalhes}`);
                    await this.page.goto(urlDetalhes, { waitUntil: 'networkidle2', timeout: 30000 });
                }

                // Aguardar 3s inicial (aumentado para dar tempo ao servidor)
                await this.page.waitForTimeout(3000);

                // CRÍTICO: Aguardar o spinner específico ".dtp-block-ui.blocked" aparecer E desaparecer
                logger.info('[Puppeteer] ⏳ Aguardando spinner ".dtp-block-ui.blocked" desaparecer...');
                try {
                    // Aguardar spinner aparecer primeiro (pode demorar até 10s)
                    await this.page.waitForSelector('.dtp-block-ui.blocked', { timeout: 10000 });
                    logger.info('[Puppeteer] ✅ Spinner apareceu, aguardando sumir...');

                    // Agora aguardar ele desaparecer (quando elementos estão prontos)
                    await this.page.waitForFunction(() => {
                        const spinner = document.querySelector('.dtp-block-ui.blocked');
                        return !spinner; // Retorna true quando spinner NÃO existe mais
                    }, { timeout: 30000 }); // 30s de timeout (página pode demorar muito)

                    logger.info('[Puppeteer] ✅ Spinner desapareceu - elementos prontos!');
                } catch (spinnerError) {
                    // Se não encontrou spinner, pode já ter carregado ou está demorando demais
                    logger.warn('[Puppeteer] ⚠️ Spinner não detectado (tentando aguardar elementos diretamente)');
                    // Aguardar mais 5s caso spinner não apareça
                    await this.page.waitForTimeout(5000);
                }

                // Aguardar mais 2s para garantir que React finalizou completamente
                await this.page.waitForTimeout(2000);

                // Aguardar elementos essenciais estarem presentes
                logger.info('[Puppeteer] 🔍 Verificando elementos essenciais (.dtp-datagrid-label)...');
                await this.page.waitForSelector('.dtp-datagrid-label', { timeout: 20000 }); // Aumentado para 20s
                logger.info('[Puppeteer] ✅ Elementos carregados!');

                // Extrair dados básicos usando $$eval (mais seguro que evaluate)
                logger.info('[Puppeteer] 📋 Extraindo dados básicos...');

                // Extrair todos os pares label-value de uma vez
                const labelsData = await this.page.$$eval('.dtp-datagrid-label', (labels) => {
                    return labels.map(label => {
                        const text = label.textContent ? label.textContent.trim() : '';
                        const valueEl = label.nextElementSibling;
                        const value = valueEl && valueEl.textContent ? valueEl.textContent.trim() : '';
                        return { label: text, value: value };
                    });
                });

                // Processar os dados no contexto Node.js (não no browser)
                const getValor = (label: string): string => {
                    const item = labelsData.find(d => d.label === label);
                    return item ? item.value : '';
                };

                let servicoExtraido = getValor('Serviço') || getValor('Servio');

                // Se não encontrou pelo label, tentar extrair via XPath/CSS específico
                if (!servicoExtraido || servicoExtraido.trim() === '') {
                    try {
                        logger.info('[Puppeteer] 🔍 Tentando extrair serviço via XPath/CSS específico...');

                        // Tentar múltiplos seletores para robustez
                        // 1. XPath relativo (mais robusto)
                        let servicoXPath = await this.page.$x('//*[@id="detalhamento"]/section[1]/div/div[2]/div/div[1]/div/span');

                        // 2. XPath absoluto (fallback)
                        if (servicoXPath.length === 0) {
                            servicoXPath = await this.page.$x('/html/body/div[1]/div[2]/div/div[2]/main/div/div[2]/div[2]/div/div[1]/section[1]/div/div[2]/div/div[1]/div/span');
                        }

                        // 3. CSS Selector (fallback)
                        if (servicoXPath.length === 0) {
                            const servicoCss = await this.page.$('#detalhamento > section:nth-child(1) > div > div.dtp-datagrid-items-box > div > div:nth-child(1) > div > span');
                            if (servicoCss) {
                                servicoExtraido = await this.page.evaluate((el: any) => el.textContent?.trim() || '', servicoCss);
                                logger.info(`[Puppeteer] ✅ Serviço extraído via CSS Selector: ${servicoExtraido}`);
                            }
                        } else {
                            servicoExtraido = await this.page.evaluate((el: any) => el.textContent?.trim() || '', servicoXPath[0]);
                            logger.info(`[Puppeteer] ✅ Serviço extraído via XPath: ${servicoExtraido}`);
                        }
                    } catch (error) {
                        logger.warn('[Puppeteer] ⚠️ Erro ao extrair serviço via XPath/CSS:', error);
                    }
                }

                // Extrair data de nascimento
                const dataNascimentoStr = getValor('Nascimento') || '';

                const dadosBasicos = {
                    protocolo: getValor('Protocolo'),
                    cpf: getValor('CPF'),
                    nome: getValor('Nome Completo'),
                    servico: servicoExtraido || '',
                    dataSolicitacao: getValor('Data da Solicitação'),
                    statusAtual: getValor('Status'),
                    dataNascimento: dataNascimentoStr // Formato: DD/MM/YYYY
                };

                logger.info(`[Puppeteer] 📊 Dados: ${dadosBasicos.nome} | CPF: ${dadosBasicos.cpf}`);
                logger.info(`[Puppeteer] 📋 Serviço: ${dadosBasicos.servico}`);
                logger.info(`[Puppeteer] 📅 DER: ${dadosBasicos.dataSolicitacao} | Status: ${dadosBasicos.statusAtual}`);

                // Extrair comentários/exigências
                logger.info('[Puppeteer] 📝 Extraindo comentários/exigências...');

                // Tentar aba "Exigência" primeiro (protocolos em exigência)
                let abaEncontrada = false;
                let comentarios: any[] = [];

                const abaExigencia = await this.page.$('a[href="#exigencia"], a[aria-controls="exigencia"]');
                if (abaExigencia) {
                    logger.info('[Puppeteer] 📋 Aba "Exigência" encontrada, clicando...');
                    await abaExigencia.click();
                    await this.page.waitForTimeout(2000);
                    abaEncontrada = true;
                } else {
                    // Tentar aba "Comentários" (protocolos concluídos/outros)
                    const abaComentarios = await this.page.$('a[href="#comentarios"], a[aria-controls="comentarios"]');
                    if (abaComentarios) {
                        logger.info('[Puppeteer] 📋 Aba "Comentários" encontrada, clicando...');
                        await abaComentarios.click();
                        await this.page.waitForTimeout(2000);
                        abaEncontrada = true;
                    }
                }

                if (abaEncontrada) {
                    // Aguardar comentários aparecerem (aumentar paciência)
                    try {
                        await this.page.waitForSelector('.comentario-tarefa', { timeout: 15000 });
                        await this.page.waitForTimeout(3000); // Aguardar renderização completa
                    } catch (error) {
                        logger.warn('[Puppeteer] ⚠️ Comentários não apareceram no timeout, tentando extrair mesmo assim...');
                    }

                    // Extrair todos os comentários (estrutura: .comentario-tarefa)
                    comentarios = await this.page.evaluate(() => {
                        const comentariosEls = document.querySelectorAll('.comentario-tarefa');

                        return Array.from(comentariosEls).map(el => {
                            const tituloEl = el.querySelector('.titulo');
                            const textoEl = el.querySelector('.texto');

                            const tituloTexto = tituloEl?.textContent?.trim() || '';

                            // CORREÇÃO: Extrair texto LIMPO (sem HTML) para a IA analisar
                            // Usar textContent ao invés de innerHTML para remover tags
                            let texto = textoEl?.textContent?.trim() || '';

                            // Limpar espaços duplos e quebras de linha excessivas
                            texto = texto.replace(/\s\s+/g, ' ').replace(/\n\n+/g, '\n').trim();

                            // Extrair data do título: "Enviado em 05/11/2025"
                            const matchData = tituloTexto.match(/(\d{2}\/\d{2}\/\d{4})/);
                            const dataStr = matchData ? matchData[1] : '';

                            return {
                                dataStr,
                                texto
                            };
                        });
                    });

                    logger.info(`[Puppeteer] 📊 ${comentarios.length} comentário(s) encontrado(s)`);

                    // Se não encontrou comentários, tentar aguardar mais um pouco
                    if (comentarios.length === 0) {
                        logger.warn('[Puppeteer] ⚠️ Nenhum comentário encontrado, aguardando mais 5 segundos...');
                        await this.page.waitForTimeout(5000);

                        // Tentar novamente
                        comentarios = await this.page.evaluate(() => {
                            const comentariosEls = document.querySelectorAll('.comentario-tarefa');
                            return Array.from(comentariosEls).map(el => {
                                const tituloEl = el.querySelector('.titulo');
                                const textoEl = el.querySelector('.texto');
                                const tituloTexto = tituloEl?.textContent?.trim() || '';
                                let texto = textoEl?.textContent?.trim() || '';
                                texto = texto.replace(/\s\s+/g, ' ').replace(/\n\n+/g, '\n').trim();
                                const matchData = tituloTexto.match(/(\d{2}\/\d{2}\/\d{4})/);
                                const dataStr = matchData ? matchData[1] : '';
                                return { dataStr, texto };
                            });
                        });
                        logger.info(`[Puppeteer] 📊 Após segunda tentativa: ${comentarios.length} comentário(s) encontrado(s)`);
                    }
                } else {
                    logger.warn('[Puppeteer] ⚠️ Nenhuma aba de comentários/exigências encontrada');
                }

                // Converter datas e calcular prazos
                const comentariosProcessados: ComentarioExigencia[] = comentarios.map((c: any) => {
                    let data: Date;
                    try {
                        // Parse "05/11/2025" → Date
                        data = parse(c.dataStr, 'dd/MM/yyyy', new Date());
                    } catch {
                        data = new Date();
                    }

                    // Calcular prazo: data + 30 dias
                    const prazo = addDays(data, 30);

                    return {
                        data,
                        texto: c.texto,
                        prazo
                    };
                });

                // Capturar HTML completo da página
                const htmlCompleto = await this.page.content();

                logger.info(`[Puppeteer] ✅ Extração completa do protocolo ${protocolo}`);
                logger.info(`[Puppeteer] 📊 Total de comentários: ${comentariosProcessados.length}`);
                if (comentariosProcessados.length > 0) {
                    const ultimo = comentariosProcessados[comentariosProcessados.length - 1];
                    logger.info(`[Puppeteer] 📅 Último comentário: ${format(ultimo.data, 'dd/MM/yyyy')}`);
                    logger.info(`[Puppeteer] ⏰ Prazo calculado: ${format(ultimo.prazo!, 'dd/MM/yyyy')}`);
                }

                // Parse data de solicitação
                let dataSolicitacaoParsed: Date;
                try {
                    if (dadosBasicos.dataSolicitacao && dadosBasicos.dataSolicitacao.trim()) {
                        const parsed = parse(dadosBasicos.dataSolicitacao, 'dd/MM/yyyy', new Date());
                        // Verificar se a data é válida
                        if (!isNaN(parsed.getTime())) {
                            dataSolicitacaoParsed = parsed;
                        } else {
                            logger.warn(`[Puppeteer] ⚠️ Data de solicitação inválida: "${dadosBasicos.dataSolicitacao}", usando data atual`);
                            dataSolicitacaoParsed = new Date();
                        }
                    } else {
                        logger.warn(`[Puppeteer] ⚠️ Data de solicitação vazia, usando data atual`);
                        dataSolicitacaoParsed = new Date();
                    }
                } catch (error) {
                    logger.warn(`[Puppeteer] ⚠️ Erro ao fazer parse da data: ${error}, usando data atual`);
                    dataSolicitacaoParsed = new Date();
                }

                // Se chegou aqui, a extração foi bem-sucedida
                return {
                    filtroAplicado,
                    protocolo: dadosBasicos.protocolo,
                    cpf: dadosBasicos.cpf,
                    nome: dadosBasicos.nome,
                    servico: dadosBasicos.servico,
                    dataSolicitacao: dataSolicitacaoParsed,
                    statusAtual: dadosBasicos.statusAtual,
                    dataNascimento: dadosBasicos.dataNascimento,
                    comentarios: comentariosProcessados,
                    agendamentos: [], // Agendamentos serão extraídos durante o processamento
                    htmlCompleto
                };

            } catch (error: any) {
                const errorMsg = error.message || String(error);

                // Verificar se é erro 406 ou erro de rede/timeout
                const isError406 = errorMsg.includes('406') ||
                    errorMsg.includes('Not Acceptable') ||
                    (error.response && error.response.status === 406);

                const isNetworkError = errorMsg.includes('net::ERR') ||
                    errorMsg.includes('Navigation timeout') ||
                    errorMsg.includes('timeout');

                // Se for erro 406 ou de rede e ainda temos tentativas, tentar novamente
                if ((isError406 || isNetworkError) && tentativa < maxTentativas) {
                    logger.warn(`[Puppeteer] ⚠️ Erro ${isError406 ? '406' : 'de rede'} na tentativa ${tentativa}/${maxTentativas} para protocolo ${protocolo}. Tentando novamente...`);
                    await this.page.waitForTimeout(2000); // Aguardar antes de tentar novamente
                    continue; // Tentar novamente
                }

                // Se esgotou tentativas ou é outro tipo de erro, lançar
                logger.error(`[Puppeteer] ❌ Erro ao extrair detalhes do protocolo ${protocolo} (tentativa ${tentativa}/${maxTentativas}):`, errorMsg);

                // Se é a última tentativa, lançar erro
                if (tentativa >= maxTentativas) {
                    throw error;
                }
            }
        }

        // Se chegou aqui, todas as tentativas falharam
        throw new Error(`Não foi possível extrair detalhes do protocolo ${protocolo} após ${maxTentativas} tentativa(s)`);
    }

    /**
     * ?? Captura o email exclusivo de um cliente no Tramita��o Inteligente
     * Navega at� a p�gina de emails do cliente e extrai o endere�o
     * 
     * @param tramitacaoClienteId - ID do cliente no Tramita��o (ex: 11, 28, 29)
     * @returns Email exclusivo (ex: "elizangela_top@timail.com.br") ou null se n�o encontrar
     */
    async obterEmailExclusivo(tramitacaoClienteId: number | string): Promise<string | null> {
        try {
            if (!this.browser || !this.page) {
                throw new Error('Navegador n�o est� inicializado. Execute fazerLogin() primeiro.');
            }

            const tramitacaoUrl = config.tramitacao.apiUrl.replace('/api/v1', '');
            const urlEmails = `${tramitacaoUrl}/clientes/${tramitacaoClienteId}/emails`;

            logger.info(`[Puppeteer] ?? Navegando para p�gina de emails: ${urlEmails}`);

            await this.page.goto(urlEmails, {
                waitUntil: 'networkidle0',
                timeout: 30000
            });

            // Aguarda o input do email carregar
            await this.page.waitForSelector('input[data-test="inbound_email_address"]', {
                timeout: 10000
            });

            // Extrai o valor do email
            const emailExclusivo = await this.page.$eval(
                'input[data-test="inbound_email_address"]',
                (el: any) => el.value
            );

            if (!emailExclusivo) {
                logger.warn(`[Puppeteer] ?? Email exclusivo n�o encontrado para cliente ${tramitacaoClienteId}`);
                return null;
            }

            logger.info(`[Puppeteer] ? Email exclusivo capturado: ${emailExclusivo}`);
            return emailExclusivo;

        } catch (error: any) {
            logger.error(
                `[Puppeteer] ? Erro ao obter email exclusivo do cliente ${tramitacaoClienteId}:`,
                error.message
            );
            return null;
        }
    }

    /**
     * Usa a omnibox do Chrome (Ctrl+L) para colar a URL com token e pressionar Enter,
     * garantindo que a navega��o seja executada como um humano faria.
     */
    private async navegarViaOmnibox(url: string): Promise<boolean> {
        if (!this.page) return false;

        try {
            logger.info('[Puppeteer] 🎯 Navegando via omnibox (Ctrl+L)...');

            // Garantir que a página está em foco
            await this.page.bringToFront();
            await this.page.waitForTimeout(800);

            // Limpar qualquer texto selecionado primeiro
            await this.page.keyboard.press('Escape');
            await this.page.waitForTimeout(200);

            // Abrir omnibox (Ctrl+L)
            await this.page.keyboard.down('Control');
            await this.page.keyboard.press('KeyL');
            await this.page.keyboard.up('Control');

            // Aguardar omnibox abrir
            await this.page.waitForTimeout(500);

            // Selecionar tudo e limpar (Ctrl+A, Delete)
            await this.page.keyboard.down('Control');
            await this.page.keyboard.press('KeyA');
            await this.page.keyboard.up('Control');
            await this.page.waitForTimeout(100);
            await this.page.keyboard.press('Delete');
            await this.page.waitForTimeout(200);

            // Colar URL
            logger.info('[Puppeteer] 📋 Colando URL na omnibox...');
            await this.page.keyboard.type(url, { delay: 10 });
            await this.page.waitForTimeout(500);

            // Verificar se URL foi colada corretamente
            const urlColada = await this.page.evaluate(() => {
                const input = document.activeElement as HTMLInputElement;
                return input?.value || '';
            });

            if (!urlColada.includes('atendimento.inss.gov.br')) {
                logger.warn('[Puppeteer] ⚠️ URL não foi colada corretamente, tentando novamente...');
                // Tentar colar novamente usando clipboard
                await this.page.evaluate((urlToPaste) => {
                    const input = document.activeElement as HTMLInputElement;
                    if (input) {
                        input.value = urlToPaste;
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                }, url);
                await this.page.waitForTimeout(300);
            }

            // Pressionar Enter para navegar
            logger.info('[Puppeteer] ⏎ Pressionando Enter para navegar...');
            const navigationPromise = this.page.waitForNavigation({
                waitUntil: ['domcontentloaded', 'networkidle0'],
                timeout: 20000
            }).catch((error: any) => {
                logger.warn(`[Puppeteer] ⚠️ Navegação via omnibox não confirmou: ${error.message}`);
                return null;
            });

            await this.page.keyboard.press('Enter');

            // Aguardar navegação ou timeout
            await Promise.race([
                navigationPromise,
                new Promise(resolve => setTimeout(() => resolve(null), 20000))
            ]);

            await this.page.waitForTimeout(2000);

            const finalUrl = this.page.url();
            const sucesso = finalUrl.includes('atendimento.inss.gov.br');

            logger.info(`[Puppeteer] 🌐 URL após omnibox: ${finalUrl.substring(0, 80)}...`);

            if (!sucesso) {
                logger.warn('[Puppeteer] ⚠️ Omnibox não direcionou para o INSS, aplicando fallback...');
            } else {
                logger.info('[Puppeteer] ✅ Navegação via omnibox bem-sucedida!');
            }

            return sucesso;
        } catch (error: any) {
            logger.warn(`[Puppeteer] ⚠️ Erro ao usar omnibox: ${error.message}`);
            return false;
        }
    }

    /**
     * Obtém a página atual do Puppeteer (para uso por outros serviços)
     */
    getPage(): Page | null {
        return this.page;
    }

    /**
     * Obtém o browser atual (para uso por outros serviços)
     */
    getBrowser(): Browser | null {
        return this.browser;
    }
}

export default new PuppeteerService();



