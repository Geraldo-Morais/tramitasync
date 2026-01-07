import { Router, Request, Response } from 'express';
import { ExtensaoAuthController } from '../controllers/ExtensaoAuthController';
import logger from '../utils/logger';
import config from '../config';

const router = Router();
const controller = new ExtensaoAuthController();

// Rotas carregadas silenciosamente

/**
 * POST /api/v1/extensao/register
 * 
 * Registra um novo usuário da extensão
 * 
 * Body:
 * {
 *   "email": "usuario@email.com",
 *   "password": "senha123",
 *   "nome": "Nome do Usuário"
 * }
 */
router.post('/register', async (req: Request, res: Response) => {
    try {
        const { email, password, nome } = req.body;

        if (!email || !password || !nome) {
            return res.status(400).json({
                success: false,
                message: 'Email, senha e nome são obrigatórios'
            });
        }

        const resultado = await controller.registrar(email, password, nome);

        if (resultado.success) {
            res.json({
                success: true,
                message: 'Usuário registrado com sucesso',
                user: resultado.user
            });
        } else {
            res.status(400).json({
                success: false,
                message: resultado.message
            });
        }
    } catch (error: any) {
        logger.error(`❌ Erro ao registrar usuário: ${error.message}`, error);
        res.status(500).json({
            success: false,
            message: 'Erro ao registrar usuário',
            error: config.env === 'development' ? error.message : undefined
        });
    }
});

/**
 * POST /api/v1/extensao/login
 * 
 * Autentica um usuário da extensão
 * 
 * Body:
 * {
 *   "email": "usuario@email.com",
 *   "password": "senha123"
 * }
 */
router.post('/login', async (req: Request, res: Response) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: 'Email e senha são obrigatórios'
            });
        }

        const resultado = await controller.login(email, password);

        if (resultado.success) {
            res.json({
                success: true,
                message: 'Login realizado com sucesso',
                token: resultado.token,
                user: resultado.user
            });
        } else {
            res.status(401).json({
                success: false,
                message: resultado.message
            });
        }
    } catch (error: any) {
        logger.error(`❌ Erro ao fazer login: ${error.message}`, error);
        res.status(500).json({
            success: false,
            message: 'Erro ao fazer login',
            error: config.env === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /api/v1/extensao/config
 * 
 * Retorna as configurações do usuário autenticado
 * Requer token JWT no header Authorization
 */
router.get('/config', async (req: Request, res: Response) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token de autenticação não fornecido'
            });
        }

        const resultado = await controller.obterConfig(token);

        if (resultado.success) {
            res.json({
                success: true,
                config: resultado.config
            });
        } else {
            res.status(401).json({
                success: false,
                message: resultado.message
            });
        }
    } catch (error: any) {
        logger.error(`❌ Erro ao obter configurações: ${error.message}`, error);
        res.status(500).json({
            success: false,
            message: 'Erro ao obter configurações',
            error: config.env === 'development' ? error.message : undefined
        });
    }
});

/**
 * PUT /api/v1/extensao/config
 * 
 * Atualiza as configurações do usuário autenticado
 * Requer token JWT no header Authorization
 * 
 * Body:
 * {
 *   "geminiApiKey": "...",
 *   "tramitacaoApiToken": "...",
 *   "tramitacaoEmail": "...",
 *   "tramitacaoSenha": "...",
 *   "patToken": "..."
 * }
 */
router.put('/config', async (req: Request, res: Response) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token de autenticação não fornecido'
            });
        }

        const { geminiApiKey, tramitacaoApiToken, tramitacaoEmail, tramitacaoSenha, patToken } = req.body;

        const resultado = await controller.atualizarConfig(token, {
            geminiApiKey,
            tramitacaoApiToken,
            tramitacaoEmail,
            tramitacaoSenha,
            patToken
        });

        if (resultado.success) {
            res.json({
                success: true,
                message: 'Configurações atualizadas com sucesso',
                config: resultado.config
            });
        } else {
            res.status(400).json({
                success: false,
                message: resultado.message
            });
        }
    } catch (error: any) {
        logger.error(`❌ Erro ao atualizar configurações: ${error.message}`, error);
        res.status(500).json({
            success: false,
            message: 'Erro ao atualizar configurações',
            error: config.env === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /api/v1/extensao/config/whatsapp
 * 
 * Retorna as configurações de WhatsApp do usuário autenticado
 * Requer token JWT no header Authorization
 */
router.get('/config/whatsapp', async (req: Request, res: Response) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token de autenticação não fornecido'
            });
        }

        const resultado = await controller.obterConfigWhatsApp(token);

        if (resultado.success) {
            res.json({
                success: true,
                config: resultado.config,
                isAdmin: resultado.isAdmin // Flag de admin vem do backend (segurança)
            });
        } else {
            res.status(401).json({
                success: false,
                message: resultado.message
            });
        }
    } catch (error: any) {
        logger.error(`❌ Erro ao obter configurações de WhatsApp: ${error.message}`, error);
        res.status(500).json({
            success: false,
            message: 'Erro ao obter configurações de WhatsApp',
            error: config.env === 'development' ? error.message : undefined
        });
    }
});

/**
 * PUT /api/v1/extensao/config/whatsapp
 * 
 * Atualiza as configurações de WhatsApp do usuário autenticado
 * Requer token JWT no header Authorization
 * 
 * Body:
 * {
 *   "ativo": true,
 *   "numeroUnico": "557788682628", // Opcional: número único para todos
 *   "exigencia": "557788682628",   // Opcional: número específico para exigências
 *   "deferido": "557788682628",    // Opcional: número específico para deferidos
 *   "indeferido": "557788682628",  // Opcional: número específico para indeferidos
 *   "emAnalise": "557788682628",   // Opcional: número específico para em análise
 *   "agendamento": "557788682628"  // Opcional: número específico para agendamentos
 * }
 */
router.put('/config/whatsapp', async (req: Request, res: Response) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token de autenticação não fornecido'
            });
        }

        const { ativo, numeroUnico, exigencia, deferido, indeferido, emAnalise, agendamento } = req.body;

        const resultado = await controller.atualizarConfigWhatsApp(token, {
            ativo: ativo !== undefined ? Boolean(ativo) : false,
            numeroUnico,
            exigencia,
            deferido,
            indeferido,
            emAnalise,
            agendamento
        });

        if (resultado.success) {
            res.json({
                success: true,
                message: resultado.message || 'Configurações de WhatsApp atualizadas com sucesso',
                config: resultado.config
            });
        } else {
            res.status(400).json({
                success: false,
                message: resultado.message || 'Erro ao atualizar configurações de WhatsApp'
            });
        }
    } catch (error: any) {
        logger.error(`❌ Erro ao atualizar configurações de WhatsApp: ${error.message}`, error);
        logger.error(`❌ Stack: ${error.stack}`);
        res.status(500).json({
            success: false,
            message: 'Erro ao atualizar configurações de WhatsApp',
            error: config.env === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /api/v1/extensao/whatsapp/status
 * Retorna status da conexão WhatsApp Central
 */
router.get('/whatsapp/status', async (req: Request, res: Response) => {
    try {
        const whatsappService = (await import('../services/WhatsAppService')).default;
        const status = await whatsappService.obterStatus();

        res.json({
            success: true,
            status
        });
    } catch (error: any) {
        logger.error(`Erro ao obter status do WhatsApp: ${error.message}`);
        res.status(500).json({
            success: false,
            message: 'Erro ao obter status do WhatsApp',
            error: config.env === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /api/v1/extensao/whatsapp/qr-code
 * Retorna QR Code da instância Central (para Admin conectar)
 */
router.get('/whatsapp/qr-code', async (req: Request, res: Response) => {
    try {
        const whatsappService = (await import('../services/WhatsAppService')).default;

        // Garante inicialização
        await whatsappService.inicializar();

        const qrData = whatsappService.obterQrCode();

        if (!qrData || !qrData.qr) {
            return res.json({
                success: true,
                hasQrCode: false,
                qr: null,
                expiresIn: 0
            });
        }

        return res.json({
            success: true,
            hasQrCode: true,
            qr: qrData.qr,
            expiresIn: qrData.expiresIn
        });
    } catch (error: any) {
        logger.error(`Erro ao obter QR Code: ${error.message}`);
        return res.status(500).json({
            success: false,
            message: 'Erro ao obter QR Code',
            error: config.env === 'development' ? error.message : undefined
        });
    }
});

/**
 * POST /api/v1/extensao/whatsapp/inicializar
 * Inicializa a instância Central
 */
router.post('/whatsapp/inicializar', async (req: Request, res: Response) => {
    try {
        const whatsappService = (await import('../services/WhatsAppService')).default;

        await whatsappService.inicializar();

        return res.json({
            success: true,
            message: 'WhatsApp Central inicializado'
        });
    } catch (error: any) {
        logger.error(`[Extensao] ❌ Erro ao inicializar WhatsApp: ${error.message}`, error);
        return res.status(500).json({
            success: false,
            message: 'Erro ao inicializar WhatsApp',
            error: config.env === 'development' ? error.message : undefined
        });
    }
});

/**
 * POST /api/v1/extensao/whatsapp/testar-envio
 * Testa envio de mensagem usando a instância Central
 */
router.post('/whatsapp/testar-envio', async (req: Request, res: Response) => {
    try {
        const { telefone, mensagem } = req.body;

        if (!telefone || !mensagem) {
            return res.status(400).json({
                success: false,
                message: 'Campos obrigatórios: telefone, mensagem'
            });
        }

        const whatsappService = (await import('../services/WhatsAppService')).default;

        // Envia usando a central
        const enviado = await whatsappService.enviar(telefone, mensagem);

        if (enviado) {
            res.json({
                success: true,
                message: 'Mensagem enviada com sucesso via Central!'
            });
        } else {
            res.status(500).json({
                success: false,
                message: 'Falha ao enviar mensagem. Verifique se o WhatsApp Central está conectado.'
            });
        }
    } catch (error: any) {
        logger.error(`Erro ao testar envio WhatsApp: ${error.message}`);
        res.status(500).json({
            success: false,
            message: 'Erro ao testar envio de mensagem',
            error: config.env === 'development' ? error.message : undefined
        });
    }
});

/**
 * POST /api/v1/extensao/whatsapp/desconectar
 * Desconecta WhatsApp e limpa sessão (Admin only)
 */
router.post('/whatsapp/desconectar', async (req: Request, res: Response) => {
    try {
        const whatsappService = (await import('../services/WhatsAppService')).default;

        await whatsappService.reinicializar();

        return res.json({
            success: true,
            message: 'WhatsApp desconectado. Novo QR Code será gerado.'
        });
    } catch (error: any) {
        logger.error(`Erro ao desconectar WhatsApp: ${error.message}`);
        return res.status(500).json({
            success: false,
            message: 'Erro ao desconectar WhatsApp',
            error: config.env === 'development' ? error.message : undefined
        });
    }
});

export default router;
