import { Router, Request, Response } from 'express';
import config from '../config';
import ngrokService from '../services/NgrokTunnelService';
import logger from '../utils/logger';
import discoveryService from '../services/UrlDiscoveryService';

const router = Router();

/**
 * GET /api/v1/system/public-url
 * 
 * Retorna a URL pública do backend (Cloudflare Tunnel ou localhost)
 * Usado pela extensão para detectar automaticamente onde conectar
 */
router.get('/public-url', async (req: Request, res: Response) => {
    try {
        // Obter URL do ngrok (principal)
        let publicUrl = ngrokService.getPublicUrl();
        let tunnelType = 'ngrok';

        // Fallback para variável de ambiente ou localhost
        if (!publicUrl) {
            publicUrl = process.env.PUBLIC_URL || `http://localhost:${config.port}`;
            tunnelType = 'localhost';
        }

        res.json({
            success: true,
            publicUrl,
            apiUrl: `${publicUrl}/api/v1`,
            isLocal: publicUrl.includes('localhost') || publicUrl.includes('127.0.0.1'),
            isTunnel: publicUrl.includes('ngrok.io') || publicUrl.includes('ngrok-free.app') || publicUrl.includes('ngrok.app'),
            tunnelType: tunnelType
        });
    } catch (error: any) {
        res.status(500).json({
            success: false,
            message: 'Erro ao obter URL pública',
            error: config.env === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /api/v1/system/health
 * 
 * Health check endpoint
 */
router.get('/health', async (req: Request, res: Response) => {
    res.json({
        success: true,
        status: 'healthy',
        timestamp: new Date().toISOString(),
        environment: config.env
    });
});

/**
 * GET /api/v1/system/discovery/url
 * 
 * Retorna a URL pública do serviço de descoberta (Hastebin, Pastebin, etc.)
 */
router.get('/discovery/url', async (req: Request, res: Response) => {
    try {
        const publicUrl = discoveryService.getPublicUrl();
        const serviceType = discoveryService.getServiceType();

        if (!publicUrl) {
            return res.json({
                success: false,
                message: `${serviceType} não configurado ou documento não criado ainda`,
                serviceType,
                configured: discoveryService.isConfigured()
            });
        }

        res.json({
            success: true,
            url: publicUrl,
            serviceType,
            configured: true
        });
    } catch (error: any) {
        res.status(500).json({
            success: false,
            message: 'Erro ao obter URL do serviço de descoberta',
            error: config.env === 'development' ? error.message : undefined
        });
    }
});

/**
 * POST /api/v1/system/discovery/test
 * 
 * Testa conexão com serviço de descoberta e cria/atualiza documento de teste
 */
router.post('/discovery/test', async (req: Request, res: Response) => {
    try {
        const serviceType = discoveryService.getServiceType();

        // Log para debug
        logger.info(`🧪 Testando serviço de descoberta: ${serviceType}`);
        logger.info(`🔑 URL_DISCOVERY_SERVICE: ${process.env.URL_DISCOVERY_SERVICE || 'não definido'}`);
        logger.info(`🔑 GITHUB_TOKEN: ${process.env.GITHUB_TOKEN ? 'definido' : 'não definido'}`);
        logger.info(`🔑 PASTEBIN_API_KEY: ${process.env.PASTEBIN_API_KEY ? 'definido' : 'não definido'}`);

        if (!discoveryService.isConfigured()) {
            return res.status(400).json({
                success: false,
                message: `${serviceType} não configurado. Verifique as variáveis de ambiente.`,
                serviceType,
                env: {
                    URL_DISCOVERY_SERVICE: process.env.URL_DISCOVERY_SERVICE || 'não definido',
                    hasGithubToken: !!process.env.GITHUB_TOKEN,
                    hasPastebinKey: !!process.env.PASTEBIN_API_KEY
                }
            });
        }

        const ngrokUrl = ngrokService.getPublicUrl() || 'http://localhost:3000';
        const apiUrl = `${ngrokUrl}/api/v1`;

        logger.info(`📤 Fazendo upload para ${serviceType}...`);
        const result = await discoveryService.uploadUrl(ngrokUrl, apiUrl);

        if (result.success) {
            res.json({
                success: true,
                message: `${serviceType} testado com sucesso`,
                url: result.url,
                serviceType: serviceType,
                publicUrl: discoveryService.getPublicUrl()
            });
        } else {
            res.status(500).json({
                success: false,
                message: `Erro ao testar ${serviceType}`,
                error: result.error,
                serviceType: serviceType
            });
        }
    } catch (error: any) {
        logger.error(`❌ Erro ao testar serviço de descoberta: ${error.message}`);
        res.status(500).json({
            success: false,
            message: 'Erro ao testar serviço de descoberta',
            error: config.env === 'development' ? error.message : undefined,
            stack: config.env === 'development' ? error.stack : undefined
        });
    }
});

/**
 * ⚠️ ROTAS DO WHATSAPP REMOVIDAS
 * 
 * As rotas do WhatsApp foram movidas para /api/v1/extensao/whatsapp/*
 * pois agora o WhatsApp é multi-tenant (uma sessão por usuário).
 * 
 * Use as rotas autenticadas em extensao-auth.routes.ts:
 * - GET  /api/v1/extensao/whatsapp/status
 * - GET  /api/v1/extensao/whatsapp/qr-code
 * - POST /api/v1/extensao/whatsapp/limpar-sessao
 * - POST /api/v1/extensao/whatsapp/testar-envio
 */

export default router;
