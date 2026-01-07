import { Router, Request, Response } from 'express';
import { SincronizacaoInssController } from '../controllers/SincronizacaoInssController';
import { ExtensaoAuthController } from '../controllers/ExtensaoAuthController';
import logger from '../utils/logger';
import config from '../config';
import jwt from 'jsonwebtoken';
import Database from '../database';

const router = Router();
const controller = new SincronizacaoInssController();
const authController = new ExtensaoAuthController();

/**
 * Middleware para autenticar usuário da extensão
 */
function authenticateExtensao(req: Request, res: Response, next: any) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                success: false,
                message: 'Token de autenticação não fornecido'
            });
        }

        const token = authHeader.substring(7);
        const decoded = jwt.verify(token, config.jwt.secret) as any;

        if (decoded.tipo !== 'extensao') {
            return res.status(401).json({
                success: false,
                message: 'Token inválido'
            });
        }

        (req as any).userId = decoded.userId;
        next();
    } catch (error: any) {
        return res.status(401).json({
            success: false,
            message: 'Token inválido ou expirado'
        });
    }
}

/**
 * POST /api/v1/inss/sincronizar
 * 
 * Sincroniza protocolos INSS do PAT com o Tramitação Inteligente
 * Requer autenticação da extensão
 * 
 * Body:
 * {
 *   "tokenPat": "AT-xxx...", // Token PAT extraído do navegador (opcional se já está nas configs)
 *   "forcarExecucao": false  // Opcional: força execução mesmo se já executou hoje
 * }
 */
router.post('/sincronizar', authenticateExtensao, async (req: Request, res: Response) => {
    try {
        const { tokenPat, forcarExecucao } = req.body;
        const userId = (req as any).userId;

        // ⚠️ SEGURANÇA: Buscar credenciais diretamente do banco (não do client-side)
        // Credenciais são obtidas apenas do banco, nunca do body da requisição
        const token = req.headers.authorization?.replace('Bearer ', '') || '';

        // Buscar credenciais do banco de dados diretamente
        const decoded = jwt.verify(token, config.jwt.secret) as any;
        const Database = (await import('../database')).default;

        const resultadoConfig = await Database.query(
            `SELECT gemini_api_key, tramitacao_api_token, tramitacao_email, tramitacao_senha, pat_token
             FROM usuarios_extensao 
             WHERE id = $1`,
            [decoded.userId]
        );

        if (resultadoConfig.length === 0) {
            return res.status(401).json({
                success: false,
                message: 'Usuário não encontrado'
            });
        }

        const configs = resultadoConfig[0];

        // ⚠️ SEGURANÇA: Token PAT vem apenas do body (capturado do navegador) ou do banco
        // Nunca aceitar credenciais do body, apenas token PAT
        const tokenPatFinal = tokenPat || configs.pat_token;

        if (!tokenPatFinal) {
            return res.status(400).json({
                success: false,
                message: 'Token PAT é obrigatório. Faça login no PAT primeiro.'
            });
        }

        // ⚠️ SEGURANÇA: Verificar se tem credenciais obrigatórias
        if (!configs.tramitacao_api_token) {
            return res.status(400).json({
                success: false,
                message: 'Token do Tramitação é obrigatório. Configure nas configurações da extensão.'
            });
        }

        logger.info(`🔄 Iniciando sincronização INSS via API para usuário ${userId}...`);

        // ⚠️ SEGURANÇA: Usar credenciais APENAS do banco, nunca do client-side
        // Iniciar sincronização de forma assíncrona com configurações do banco
        const resultado = await controller.iniciarSincronizacao(
            tokenPatFinal,
            forcarExecucao,
            userId, // Passar userId para usar sessão WhatsApp específica do usuário
            {
                geminiApiKey: configs.gemini_api_key || undefined,
                tramitacaoApiToken: configs.tramitacao_api_token,
                tramitacaoEmail: configs.tramitacao_email || undefined,
                tramitacaoSenha: configs.tramitacao_senha || undefined
            }
        );

        if (resultado.success) {
            res.json({
                success: true,
                message: 'Sincronização iniciada com sucesso',
                jobId: resultado.jobId,
                dataInicio: resultado.dataInicio,
                dataFim: resultado.dataFim
            });
        } else {
            res.status(400).json({
                success: false,
                message: resultado.message
            });
        }
    } catch (error: any) {
        logger.error(`❌ Erro ao iniciar sincronização: ${error.message}`, error);
        res.status(500).json({
            success: false,
            message: 'Erro ao iniciar sincronização',
            error: config.env === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /api/v1/inss/status/:jobId
 * 
 * Retorna o status de uma sincronização em andamento
 */
router.get('/status/:jobId', async (req: Request, res: Response) => {
    try {
        const { jobId } = req.params;
        const status = await controller.obterStatus(jobId);

        if (!status) {
            return res.status(404).json({
                success: false,
                message: 'Job não encontrado'
            });
        }

        res.json({
            success: true,
            status
        });
    } catch (error: any) {
        logger.error(`❌ Erro ao obter status: ${error.message}`, error);
        res.status(500).json({
            success: false,
            message: 'Erro ao obter status da sincronização'
        });
    }
});

export default router;


