/**
 * WhatsApp Service - whatsapp-web.js
 * 
 * Gerencia conexão com WhatsApp Web usando whatsapp-web.js
 * QR Code é armazenado em memória para exibição na extensão Chrome
 * 
 * Recursos de resiliência:
 * - Auto-recovery silencioso para sessões corrompidas
 * - Detecção inteligente de corrupção de sessão (lock files, journals)
 * - Graceful shutdown para evitar corrupção ao fechar servidor
 * - Retry com backoff exponencial (3s → 6s → 12s)
 * - SEGURO: Não mata processos do sistema, apenas gerencia arquivos
 */

import { Client, LocalAuth } from 'whatsapp-web.js';
import logger from '../utils/logger';
import path from 'path';
import fs from 'fs';

class WhatsAppService {
    private client: Client | null = null;
    private isReady: boolean = false;
    private isConnecting: boolean = false;
    private readonly sessionPath: string;
    private readonly delayBetweenMessages = 2000;

    // Armazenar QR code em memória para a extensão
    private currentQrCode: string | null = null;
    private qrCodeTimestamp: number | null = null;
    private readonly qrCodeExpirationMs = 20000;

    // Timestamps para controle de sessão
    private lastAuthenticatedAt: Date | null = null;
    private lastReadyAt: Date | null = null;
    private sessionStartedAt: Date | null = null;

    // Controle de retry e recuperação
    private recoveryAttempts: number = 0;
    private readonly maxRecoveryAttempts: number = 3;
    private lastErrorTime: number = 0;
    private isRecovering: boolean = false;
    private isShuttingDown: boolean = false;

    constructor() {
        this.sessionPath = path.join(process.cwd(), '.wwebjs_auth');
        if (!fs.existsSync(this.sessionPath)) {
            fs.mkdirSync(this.sessionPath, { recursive: true });
        }

        // CRÍTICO: Registrar handlers para encerramento gracioso
        // Isso evita corrupção de sessão ao fechar o servidor
        this.registrarShutdownHandlers();
    }

    /**
     * Registra handlers para encerramento gracioso do Puppeteer
     * Evita que a sessão WhatsApp seja corrompida quando o servidor fecha
     */
    private registrarShutdownHandlers(): void {
        const gracefulShutdown = async () => {
            if (this.isShuttingDown) return;
            this.isShuttingDown = true;

            try {
                if (this.client) {
                    await this.delay(300);
                    await this.client.destroy().catch(() => { });
                    this.client = null;
                }
            } catch (e) {
                // Ignorar erros no shutdown
            }
        };

        // Capturar sinais de encerramento
        process.once('SIGINT', gracefulShutdown);
        process.once('SIGTERM', gracefulShutdown);
        process.once('beforeExit', gracefulShutdown);
    }

    /**
     * Verifica se já existe uma sessão salva E se está íntegra
     */
    private verificarSessaoExistente(): boolean {
        try {
            const sessionDir = path.join(this.sessionPath, 'Default');
            if (!fs.existsSync(sessionDir)) return false;

            const files = fs.readdirSync(sessionDir);

            // Verificar se tem os arquivos essenciais
            const hasLocalStorage = files.some((f: string) => f.includes('Local Storage'));
            const hasIndexedDB = files.some((f: string) => f.includes('IndexedDB'));

            if (!hasLocalStorage || !hasIndexedDB) return false;

            // Verificar integridade - se IndexedDB tem conteúdo
            const indexedDBPath = path.join(sessionDir, 'IndexedDB');
            if (fs.existsSync(indexedDBPath)) {
                const dbFiles = fs.readdirSync(indexedDBPath);
                // Se IndexedDB existe mas está vazio, sessão está corrompida
                if (dbFiles.length === 0) {
                    return false;
                }
            }

            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Verifica sinais de corrupção REAL na sessão
     * 
     * IMPORTANTE: Arquivos de lock (lockfile, SingletonLock) NÃO são corrupção!
     * Eles apenas indicam que o Chrome não encerrou graciosamente.
     * A sessão em si (cookies, LocalStorage, IndexedDB) pode estar perfeita.
     * 
     * Só consideramos corrupção REAL quando:
     * - Arquivo de journal existe sem o arquivo principal (transação incompleta)
     * - IndexedDB está vazio quando deveria ter dados
     */
    private verificarCorrupcaoSessao(): boolean {
        try {
            const sessionDir = path.join(this.sessionPath, 'Default');
            if (!fs.existsSync(sessionDir)) return false;

            // NÃO verificar arquivos de lock - eles serão limpos naturalmente
            // Lock files NÃO indicam corrupção, apenas crash anterior

            // Verificar se Cookies-journal existe sem Cookies (transação incompleta)
            const cookiesJournal = path.join(sessionDir, 'Cookies-journal');
            const cookies = path.join(sessionDir, 'Cookies');
            if (fs.existsSync(cookiesJournal) && !fs.existsSync(cookies)) {
                logger.warn('[WhatsApp] Corrupção detectada: Cookies-journal sem Cookies');
                return true;
            }

            // Verificar se IndexedDB está corrompido (existe mas vazio)
            const indexedDBPath = path.join(sessionDir, 'IndexedDB');
            if (fs.existsSync(indexedDBPath)) {
                const dbFiles = fs.readdirSync(indexedDBPath);
                // Se tem pasta IndexedDB mas está completamente vazia = problema
                if (dbFiles.length === 0) {
                    logger.warn('[WhatsApp] Corrupção detectada: IndexedDB vazio');
                    return true;
                }
            }

            return false;
        } catch (error) {
            // Em caso de erro de leitura, NÃO assumir corrupção
            // Apenas logar e continuar tentando usar a sessão
            logger.warn('[WhatsApp] Erro ao verificar sessão, tentando usar mesmo assim');
            return false;
        }
    }

    /**
     * Limpa arquivos de lock stale da sessão
     * SEGURO: Não mata processos do sistema, apenas remove arquivos de lock
     * que podem ter ficado após crash anterior
     */
    private limparLocksStale(): void {
        try {
            const sessionDir = path.join(this.sessionPath, 'Default');
            if (!fs.existsSync(sessionDir)) return;

            // Arquivos de lock que o Chrome/Puppeteer cria
            const lockFiles = ['lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket'];

            for (const lockFile of lockFiles) {
                const lockPath = path.join(sessionDir, lockFile);
                if (fs.existsSync(lockPath)) {
                    try {
                        fs.unlinkSync(lockPath);
                    } catch (e) {
                        // Arquivo em uso = Chrome ainda está rodando (ok, não é stale)
                    }
                }
            }
        } catch (e) {
            // Ignorar erros
        }
    }

    /**
     * Recuperação silenciosa de sessão corrompida
     * NÃO mata processos do sistema - apenas limpa arquivos
     */
    private async recuperarSessaoSilenciosamente(): Promise<boolean> {
        if (this.isRecovering) return false;

        this.isRecovering = true;

        try {
            // Destruir cliente atual de forma limpa (libera Puppeteer)
            if (this.client) {
                try {
                    await this.client.destroy().catch(() => { });
                } catch (e) { }
                this.client = null;
            }

            // Aguardar Puppeteer liberar arquivos naturalmente
            await this.delay(2000);

            // Tentar limpar apenas locks stale (seguro)
            this.limparLocksStale();
            await this.delay(500);

            // Tentar limpar sessão
            if (fs.existsSync(this.sessionPath)) {
                try {
                    fs.rmSync(this.sessionPath, { recursive: true, force: true });
                } catch (e) {
                    // Se não conseguir apagar (arquivo em uso), renomear
                    const backupPath = `${this.sessionPath}_backup_${Date.now()}`;
                    try {
                        fs.renameSync(this.sessionPath, backupPath);
                        // Agendar limpeza do backup em 2 minutos
                        setTimeout(() => {
                            try {
                                fs.rmSync(backupPath, { recursive: true, force: true });
                            } catch (e) { }
                        }, 120000);
                    } catch (e2) {
                        // Se nem renomear conseguir, a sessão está bloqueada
                        // Próxima inicialização vai tentar novamente
                    }
                }
            }

            this.isReady = false;
            this.isConnecting = false;
            this.currentQrCode = null;
            this.qrCodeTimestamp = null;

            return true;
        } finally {
            this.isRecovering = false;
        }
    }

    /**
     * Limpa a sessão atual do WhatsApp (silencioso)
     */
    async limparSessao(forcarLimpeza: boolean = false): Promise<void> {
        try {
            if (this.client) {
                try {
                    await this.client.destroy().catch(() => { });
                    this.client = null;
                } catch (e) { }
            }

            this.isReady = false;
            this.isConnecting = false;
            this.currentQrCode = null;
            this.qrCodeTimestamp = null;

            await this.delay(1000);

            if (fs.existsSync(this.sessionPath)) {
                let tentativas = 0;
                const maxTentativas = 3;

                while (tentativas < maxTentativas) {
                    try {
                        fs.rmSync(this.sessionPath, { recursive: true, force: true });
                        break;
                    } catch (error: any) {
                        tentativas++;
                        if (tentativas < maxTentativas) {
                            await this.delay(1000 * tentativas);
                        } else if (forcarLimpeza) {
                            // Última tentativa: renomear em vez de deletar
                            try {
                                fs.renameSync(this.sessionPath, `${this.sessionPath}_old_${Date.now()}`);
                            } catch (e) { }
                        }
                    }
                }
            }
        } catch (error: any) {
            if (!forcarLimpeza) throw error;
        }
    }

    /**
     * Inicializa o cliente WhatsApp
     * Com detecção inteligente de corrupção e auto-recovery silencioso
     */
    async inicializar(): Promise<void> {
        if (this.client && this.isReady) return;
        if (this.isConnecting || this.isRecovering) return;

        this.isConnecting = true;

        try {
            // Limpar arquivos de lock stale PRIMEIRO (não apaga sessão, só locks)
            this.limparLocksStale();

            // Verificar se há sessão existente
            const temSessao = this.verificarSessaoExistente();

            // APENAS verificar corrupção REAL (não locks!)
            const sessaoCorreompida = this.verificarCorrupcaoSessao();

            if (sessaoCorreompida) {
                // Só limpar se REALMENTE corrompida (journal incompleto, IndexedDB vazio)
                logger.warn('[WhatsApp] Sessão corrompida detectada, limpando...');
                await this.recuperarSessaoSilenciosamente();
            } else if (temSessao) {
                // Sessão existe e parece OK - tentar usar!
                logger.info('[WhatsApp] Sessão existente encontrada, tentando reconectar...');
            } else {
                // Sem sessão - vai precisar de QR Code
                logger.info('[WhatsApp] Aguardando escaneamento do QR Code');
            }

            this.client = new Client({
                authStrategy: new LocalAuth({
                    dataPath: this.sessionPath
                }),
                puppeteer: {
                    headless: true,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-accelerated-2d-canvas',
                        '--no-first-run',
                        '--no-zygote',
                        '--single-process',
                        '--disable-gpu'
                    ]
                }
            });

            // Event: QR Code gerado - silencioso, só armazena
            this.client.on('qr', (qr) => {
                this.currentQrCode = qr;
                this.qrCodeTimestamp = Date.now();
                this.recoveryAttempts = 0; // Reset ao receber QR válido
            });

            // Event: Autenticação concluída
            this.client.on('authenticated', () => {
                logger.info('[WhatsApp] Autenticado com sucesso');
                this.currentQrCode = null;
                this.qrCodeTimestamp = null;
                this.lastAuthenticatedAt = new Date();
                this.recoveryAttempts = 0;
            });

            // Event: Autenticação falhou - recovery silencioso
            this.client.on('auth_failure', async (msg) => {
                this.isReady = false;
                this.isConnecting = false;
                this.currentQrCode = null;
                this.qrCodeTimestamp = null;

                // Recovery silencioso - só limpa e deixa pronto para novo QR
                await this.recuperarSessaoSilenciosamente();
            });

            // Event: Cliente está pronto
            this.client.on('ready', () => {
                logger.info('[WhatsApp] Conectado e pronto');
                this.isReady = true;
                this.isConnecting = false;
                this.currentQrCode = null;
                this.qrCodeTimestamp = null;
                this.lastReadyAt = new Date();
                this.recoveryAttempts = 0;
                if (!this.sessionStartedAt) {
                    this.sessionStartedAt = new Date();
                }
            });

            // Event: Cliente desconectado
            this.client.on('disconnected', async (reason) => {
                const reasonStr = String(reason);
                this.isReady = false;
                this.currentQrCode = null;
                this.qrCodeTimestamp = null;

                const foiLogout = reasonStr === 'LOGOUT' || reasonStr.includes('LOGOUT');

                if (foiLogout) {
                    logger.info('[WhatsApp] Logout detectado - sessão será limpa');
                    await this.recuperarSessaoSilenciosamente();
                }

                // Reconectar silenciosamente
                const delayReconnect = foiLogout ? 10000 : 5000;
                setTimeout(() => {
                    if (!this.isReady && !this.isConnecting) {
                        this.inicializar().catch(() => { });
                    }
                }, delayReconnect);
            });

            // Event: Erro - recovery inteligente com backoff
            this.client.on('error', async (error) => {
                this.isReady = false;

                const isRecoverableError =
                    error.message.includes('Target closed') ||
                    error.message.includes('Protocol error') ||
                    error.message.includes('Execution context') ||
                    error.message.includes('browser has disconnected');

                if (isRecoverableError) {
                    await this.handleRecoverableError();
                }
            });

            // Inicializar cliente
            await this.client.initialize();

        } catch (error: any) {
            this.isConnecting = false;

            const isRecoverableError =
                error.message.includes('Target closed') ||
                error.message.includes('Protocol error') ||
                error.message.includes('Execution context') ||
                error.message.includes('browser has disconnected');

            if (isRecoverableError) {
                await this.handleRecoverableError();
            } else {
                logger.error(`[WhatsApp] Erro crítico: ${error.message}`);
            }
        }
    }

    /**
     * Trata erros recuperáveis com backoff exponencial
     */
    private async handleRecoverableError(): Promise<void> {
        // Evitar spam de recovery
        const agora = Date.now();
        if (agora - this.lastErrorTime < 5000) return;
        this.lastErrorTime = agora;

        this.recoveryAttempts++;
        this.isConnecting = false;

        if (this.recoveryAttempts > this.maxRecoveryAttempts) {
            logger.warn('[WhatsApp] Máximo de tentativas atingido - aguardando intervenção manual');
            this.recoveryAttempts = 0;
            return;
        }

        // Backoff exponencial: 3s, 6s, 12s
        const delay = 3000 * Math.pow(2, this.recoveryAttempts - 1);

        await this.recuperarSessaoSilenciosamente();

        setTimeout(() => {
            if (!this.isReady && !this.isConnecting) {
                this.inicializar().catch(() => { });
            }
        }, delay);
    }

    /**
     * Obtém o QR code atual (se disponível)
     */
    obterQrCode(): { qr: string | null; expiresIn: number | null } {
        if (!this.currentQrCode || !this.qrCodeTimestamp) {
            return { qr: null, expiresIn: null };
        }

        const elapsed = Date.now() - this.qrCodeTimestamp;
        const remaining = this.qrCodeExpirationMs - elapsed;

        if (remaining <= 0) {
            // QR code expirado
            this.currentQrCode = null;
            this.qrCodeTimestamp = null;
            return { qr: null, expiresIn: null };
        }

        return {
            qr: this.currentQrCode,
            expiresIn: remaining
        };
    }

    /**
     * Obtém o status completo da conexão WhatsApp
     * Inclui informações de sessão para o admin verificar
     */
    async obterStatus(): Promise<{
        isReady: boolean;
        isConnecting: boolean;
        numeroConectado: string | null;
        temSessaoSalva: boolean;
        lastAuthenticatedAt: string | null;
        lastReadyAt: string | null;
        sessionStartedAt: string | null;
        temQrCodePendente: boolean;
    }> {
        const numeroConectado = this.isReady ? await this.obterNumeroConectado() : null;
        const temSessaoSalva = this.verificarSessaoExistente();
        const qrInfo = this.obterQrCode();

        return {
            isReady: this.isReady,
            isConnecting: this.isConnecting,
            numeroConectado,
            temSessaoSalva,
            lastAuthenticatedAt: this.lastAuthenticatedAt?.toISOString() || null,
            lastReadyAt: this.lastReadyAt?.toISOString() || null,
            sessionStartedAt: this.sessionStartedAt?.toISOString() || null,
            temQrCodePendente: !!qrInfo.qr
        };
    }

    /**
     * Verifica se o serviço está pronto para enviar mensagens
     */
    isConfigured(): boolean {
        return this.isReady && this.client !== null;
    }

    /**
     * Aguarda o WhatsApp ficar pronto (com timeout)
     * Útil após autenticação recente quando o evento 'ready' ainda não disparou
     */
    async aguardarPronto(timeoutMs: number = 10000): Promise<boolean> {
        const inicio = Date.now();

        while (Date.now() - inicio < timeoutMs) {
            if (this.isConfigured()) {
                logger.info('[WhatsAppService] ✅ WhatsApp está pronto para enviar');
                return true;
            }

            // Log apenas a cada 2 segundos para não poluir
            if ((Date.now() - inicio) % 2000 < 100) {
                logger.info('[WhatsAppService] ⏳ Aguardando WhatsApp ficar pronto...');
            }

            await new Promise(resolve => setTimeout(resolve, 500));
        }

        logger.error(`[WhatsAppService] ❌ Timeout (${timeoutMs}ms) aguardando WhatsApp ficar pronto`);
        logger.error(`[WhatsAppService]    isReady: ${this.isReady}, client: ${this.client !== null}`);
        return false;
    }

    /**
     * Obtém o número do WhatsApp conectado
     */
    async obterNumeroConectado(): Promise<string | null> {
        if (!this.client || !this.isReady) {
            return null;
        }

        try {
            const info = await this.client.info;
            return info.wid.user || null;
        } catch (error: any) {
            return null;
        }
    }

    /**
     * Normaliza número de telefone brasileiro
     * Aceita: 557798812345, 77988123456, 5577988123456, 557734243214 (fixo)
     * Retorna: 5577988123456 (formato WhatsApp sem @c.us)
     */
    private normalizarTelefone(telefone: string): string {
        // Remove tudo que não é número
        let numero = telefone.replace(/\D/g, '');

        // Se já tem código do país (55), remover para reprocessar
        if (numero.startsWith('55')) {
            numero = numero.substring(2);
        }

        // Agora numero tem apenas DDD + número
        // Pode ser: 77988123456 (11 dígitos - móvel com 9)
        //          7798812345 (10 dígitos - móvel sem 9)
        //          7734243214 (10 dígitos - fixo)
        //          773424321 (9 dígitos - fixo sem DDD completo - erro)

        if (numero.length === 11) {
            // Móvel com 9: 77988123456 -> 5577988123456
            return '55' + numero;
        } else if (numero.length === 10) {
            // Pode ser móvel sem 9 ou fixo
            const ddd = numero.substring(0, 2);
            const primeiroDigito = numero.charAt(2);

            // Se começa com 9, 8 ou 7, é móvel (adicionar 9)
            // Se começa com 2, 3, 4, 5, é fixo (manter)
            if (['9', '8', '7'].includes(primeiroDigito)) {
                // Móvel sem 9: 7798812345 -> 5577988123456
                return '55' + ddd + '9' + numero.substring(2);
            } else {
                // Fixo: 7734243214 -> 557734243214
                return '55' + numero;
            }
        } else if (numero.length === 9) {
            // Número sem DDD - assumir DDD 77 (Bahia) como padrão
            return '5577' + numero;
        }

        // Retornar como está se não se encaixar nos padrões
        return '55' + numero;
    }

    /**
     * Envia mensagem WhatsApp
     */
    async enviar(telefoneDestino: string, mensagem: string): Promise<boolean> {
        if (!this.isReady || !this.client) {
            return false;
        }

        try {
            const numeroFormatado = this.normalizarTelefone(telefoneDestino);
            let numeroCompleto = `${numeroFormatado}@c.us`;

            try {
                // Tentativa 1: Formato padrão com DDI
                const resultado = await this.client.sendMessage(numeroCompleto, mensagem);
                if (resultado && resultado.id) {
                    logger.info(`[WhatsAppService] ✅ Mensagem enviada!`);
                    return true;
                }
            } catch (error: any) {
                // Se erro "No LID for user", tentar formato sem DDI
                if (error.message && error.message.includes('No LID for user')) {
                    logger.warn(`[WhatsAppService] ⚠️ Erro "No LID" com formato DDI, tentando sem DDI...`);

                    // Remover '55' do início
                    const numeroSemDDI = numeroFormatado.startsWith('55')
                        ? numeroFormatado.substring(2)
                        : numeroFormatado;

                    numeroCompleto = `${numeroSemDDI}@c.us`;

                    const resultado2 = await this.client.sendMessage(numeroCompleto, mensagem);
                    if (resultado2 && resultado2.id) {
                        logger.info(`[WhatsAppService] ✅ Mensagem enviada (formato sem DDI)!`);
                        return true;
                    }
                } else {
                    throw error;
                }
            }

            return false;

        } catch (error: any) {
            logger.error(`[WhatsAppService] ❌ Erro ao enviar para ${telefoneDestino}: ${error.message}`);
            return false;
        }
    }

    /**
     * Desconecta o cliente WhatsApp
     */
    async desconectar(): Promise<void> {
        if (this.client) {
            try {
                await this.client.destroy();
            } catch (error: any) {
                // Ignorar erros de destruição
            }
            this.client = null;
            this.isReady = false;
            this.isConnecting = false;
            this.currentQrCode = null;
            this.qrCodeTimestamp = null;
        }
    }

    /**
     * Reinicializa forçadamente (gera novo QR Code)
     */
    async reinicializar(): Promise<void> {
        logger.info('[WhatsApp] Reinicializando...');
        await this.recuperarSessaoSilenciosamente();
        await this.delay(1000);
        await this.inicializar();
    }

    /**
     * Delay helper
     */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

export default new WhatsAppService();
