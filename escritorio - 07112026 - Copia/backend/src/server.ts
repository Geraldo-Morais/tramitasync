import express, { Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import config from './config';
import logger from './utils/logger';
import database from './database';

// Importar rotas
import apiRoutes from './routes';

class Server {
    public app: Application;
    private port: number;

    constructor() {
        this.app = express();
        this.port = config.port;

        this.initializeMiddlewares();
        this.initializeRoutes();
        this.initializeErrorHandling();
    }

    private initializeMiddlewares(): void {
        // Trust proxy - necessário para ngrok e outros proxies reversos
        // Permite que Express confie nos headers X-Forwarded-* do ngrok
        // Configurar para confiar apenas no primeiro proxy (ngrok)
        this.app.set('trust proxy', 1);

        // Security
        this.app.use(helmet());

        // CORS - Configuração Permissiva para Debug
        this.app.use(cors({
            origin: true, // Reflete a origem da requisição (permite tudo)
            credentials: true,
            methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'Access-Control-Allow-Origin', 'ngrok-skip-browser-warning'],
            preflightContinue: false,
            optionsSuccessStatus: 204
        }));

        // Handler explícito para OPTIONS (Preflight)
        this.app.options('*', cors());

        // Headers manuais de segurança para garantir
        this.app.use((req, res, next) => {
            res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
            res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
            res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, ngrok-skip-browser-warning');
            res.header('Access-Control-Allow-Credentials', 'true');

            // Permitir header do ngrok para pular página intersticial
            if (req.headers['ngrok-skip-browser-warning']) {
                res.header('ngrok-skip-browser-warning', 'true');
            }

            if (req.method === 'OPTIONS') {
                return res.sendStatus(200);
            }
            next();
        });

        // Body parser
        this.app.use(express.json());
        this.app.use(express.urlencoded({ extended: true }));

        // Rate limiting - DESABILITADO (Causava bloqueio indevido na extensão)
        // const limiter = rateLimit({
        //     windowMs: 15 * 60 * 1000, // 15 minutos
        //     max: 100, // limite de 100 requisições por IP
        //     message: 'Muitas requisições deste IP, tente novamente em 15 minutos',
        //     standardHeaders: true,
        //     legacyHeaders: false,
        // });
        // this.app.use('/api/', limiter);

        // Request logging detalhado para debug
        this.app.use(async (req: Request, res: Response, next: NextFunction) => {
            // Tentar obter email do usuário se autenticado
            let userEmail = 'Não autenticado';
            let rotaDescricao = req.path;

            // Mapear rotas para descrições mais legíveis
            const rotasDescricoes: Record<string, string> = {
                '/api/v1/extensao/config': 'Obter configurações',
                '/api/v1/extensao/config/whatsapp': 'Configurações WhatsApp',
                '/api/v1/extensao/whatsapp/status': 'Status WhatsApp',
                '/api/v1/extensao/whatsapp/qr-code': 'QR Code WhatsApp',
                '/api/v1/extensao/whatsapp/limpar-sessao': 'Limpar sessão WhatsApp',
                '/api/v1/extensao/whatsapp/testar-envio': 'Testar envio WhatsApp',
                '/api/v1/inss/sincronizar': 'Sincronizar INSS',
                '/api/v1/inss/status': 'Status sincronização',
                '/api/v1/extensao/login': 'Login',
                '/api/v1/extensao/register': 'Registro',
                '/api/v1/system/health': 'Health check',
                '/api/v1/system/public-url': 'URL pública'
            };

            if (rotasDescricoes[req.path]) {
                rotaDescricao = rotasDescricoes[req.path];
            }

            try {
                const authHeader = req.headers.authorization;
                if (authHeader && authHeader.startsWith('Bearer ')) {
                    const token = authHeader.substring(7);
                    const jwt = (await import('jsonwebtoken')).default;
                    const decoded = jwt.verify(token, config.jwt.secret) as any;
                    if (decoded.email) {
                        userEmail = decoded.email;
                    } else if (decoded.userId) {
                        // Se for token de extensão, buscar email do banco
                        const Database = (await import('./database')).default;
                        const result = await Database.query(
                            'SELECT email FROM usuarios_extensao WHERE id = $1 LIMIT 1',
                            [decoded.userId]
                        );
                        if (result.length > 0) {
                            userEmail = result[0].email;
                        }
                    }
                }
            } catch (error) {
                // Ignorar erros de decodificação
            }

            // Log apenas rotas críticas (reduzir spam)
            const rotasCriticas = [
                '/api/v1/extensao/login',
                '/api/v1/extensao/register',
                '/api/v1/inss/sincronizar'
            ];

            if (rotasCriticas.some(rota => req.path.startsWith(rota))) {
                logger.info(`📥 ${userEmail} → ${rotaDescricao}`);
            }

            next();
        });

        // Request logging padrão
        this.app.use((req: Request, res: Response, next: NextFunction) => {
            logger.http(`${req.method} ${req.path}`);
            next();
        });
    }

    private initializeRoutes(): void {
        // API routes v1
        this.app.use('/api/v1', apiRoutes);

        // Root redirect
        this.app.get('/', (req: Request, res: Response) => {
            res.json({
                success: true,
                message: 'API INSS Manager',
                version: '1.0.0',
                documentation: 'Esta é uma API REST. Use os endpoints abaixo:',
                endpoints: {
                    health: '/api/v1/system/health',
                    publicUrl: '/api/v1/system/public-url',
                    extensao: {
                        login: '/api/v1/extensao/login',
                        register: '/api/v1/extensao/register',
                        config: '/api/v1/extensao/config (requer autenticação)',
                        whatsapp: '/api/v1/extensao/whatsapp/* (requer autenticação)'
                    },
                    inss: {
                        sincronizar: '/api/v1/inss/sincronizar (requer autenticação)',
                        status: '/api/v1/inss/status/:jobId (requer autenticação)'
                    }
                },
                note: 'A maioria dos endpoints requer autenticação JWT. Use a extensão Chrome para interagir com a API.'
            });
        });

        // Rota /api/v1 - informar que precisa especificar o endpoint
        this.app.get('/api/v1', (req: Request, res: Response) => {
            res.json({
                success: false,
                message: 'Rota não encontrada',
                info: 'Você precisa especificar um endpoint. Exemplos:',
                examples: [
                    '/api/v1/system/health',
                    '/api/v1/system/public-url',
                    '/api/v1/extensao/login',
                    '/api/v1/extensao/register'
                ],
                documentation: 'Acesse / para ver todos os endpoints disponíveis'
            });
        });

        // 404 handler
        this.app.use((req: Request, res: Response) => {
            res.status(404).json({
                success: false,
                message: 'Rota não encontrada',
            });
        });
    }

    private initializeErrorHandling(): void {
        this.app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
            logger.error(`Erro não tratado: ${err.message}`, err);

            res.status(500).json({
                success: false,
                message: config.env === 'production'
                    ? 'Erro interno do servidor'
                    : err.message,
            });
        });
    }

    public async start(): Promise<void> {
        try {
            // Testar conexão com banco de dados (não-bloqueante em desenvolvimento)
            const dbConnected = await database.testConnection();
            if (!dbConnected) {
                logger.warn('Banco de dados não conectado - servidor rodando em modo limitado');
                if (config.env === 'production') {
                    throw new Error('Falha ao conectar com o banco de dados');
                }
            } else {
                logger.info('Banco de dados conectado');
            }

            // Iniciar servidor - escutar em todas as interfaces (0.0.0.0) para acesso público
            const host = '0.0.0.0'; // Sempre escutar em todas as interfaces

            const httpServer = this.app.listen(this.port, host, async () => {
                logger.info(`Servidor rodando na porta ${this.port}`);

                // Iniciar túnel público (Cloudflare ou ngrok como fallback)
                await this.startPublicTunnel(this.port);
            });

            // Tratamento de erros do servidor HTTP
            httpServer.on('error', (error: NodeJS.ErrnoException) => {
                if (error.code === 'EADDRINUSE') {
                    logger.error(`Porta ${this.port} já está em uso! Execute manualmente:`);
                    logger.error(`PowerShell: Get-NetTCPConnection -LocalPort ${this.port} | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`);
                }
                logger.error(`Erro: ${error.message}`);
                process.exit(1);
            });

            // Graceful shutdown
            process.on('SIGTERM', async () => {
                await this.stopPublicTunnel();
                await this.gracefulShutdown();
            });

            process.on('SIGINT', async () => {
                await this.stopPublicTunnel();
                await this.gracefulShutdown();
            });
        } catch (error) {
            logger.error('Erro ao iniciar servidor', error);
            process.exit(1);
        }
    }

    /**
     * Iniciar túnel público (ngrok como principal)
     */
    private async startPublicTunnel(port: number): Promise<void> {
        // Se túnel está desabilitado via env
        if (process.env.DISABLE_TUNNEL === 'true') {
            return;
        }

        // Usar ngrok (mais estável e sem bloqueio de senha)
        try {
            const ngrokService = (await import('./services/NgrokTunnelService')).default;
            await ngrokService.startTunnel(port);

            // URL já é mostrada no NgrokTunnelService
        } catch (error: any) {
            // Silencioso - erro ao iniciar túnel
        }
    }

    /**
     * Parar túnel público
     */
    private async stopPublicTunnel(): Promise<void> {
        try {
            const ngrokService = (await import('./services/NgrokTunnelService')).default;
            ngrokService.stopTunnel();
        } catch (error) {
            // Ignorar
        }
    }

    private async gracefulShutdown(): Promise<void> {
        logger.info('Encerrando servidor...');

        try {
            // WhatsApp Service agora gerencia múltiplas sessões por usuário
            // Não há necessidade de desconectar globalmente no shutdown
            // Cada sessão será limpa quando o usuário desconectar

            await database.close();
            logger.info('Conexões fechadas com sucesso');
            process.exit(0);
        } catch (error) {
            logger.error('Erro ao encerrar servidor', error);
            process.exit(1);
        }
    }
}

// Inicializar servidor
const server = new Server();
server.start();

// Inicializar WhatsApp Service automaticamente
(async () => {
    try {
        const whatsappService = (await import('./services/WhatsAppService')).default;
        await whatsappService.inicializar();
    } catch (error) {
        logger.error('Erro ao inicializar WhatsApp Service no startup', error);
    }
})();

export default server.app;
