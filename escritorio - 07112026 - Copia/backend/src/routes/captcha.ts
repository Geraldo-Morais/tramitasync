/**
 * 🤖 ROTAS DE CAPTCHA
 * 
 * Endpoints para gerenciar resolução de CAPTCHA:
 * - GET /captcha/:sessionId - Obter imagem do CAPTCHA pendente
 * - POST /captcha/:sessionId - Enviar resolução manual
 */

import { Router, Request, Response } from 'express';
import captchaService from '../services/CaptchaService';
import logger from '../utils/logger';

const router = Router();

/**
 * GET /api/v1/captcha/:sessionId
 * Obter imagem do CAPTCHA pendente para exibir no frontend
 */
router.get('/:sessionId', (req: Request, res: Response) => {
    const { sessionId } = req.params;

    const captchaData = captchaService.obterCaptchaPendente(sessionId);

    if (!captchaData) {
        return res.status(404).json({
            sucesso: false,
            erro: 'Nenhum CAPTCHA pendente para esta sessão'
        });
    }

    res.json({
        sucesso: true,
        dados: {
            imagemBase64: captchaData.imagemBase64,
            timestamp: captchaData.timestamp
        }
    });
});

/**
 * POST /api/v1/captcha/:sessionId
 * Enviar resolução manual do CAPTCHA
 * 
 * Body: { texto: "ABC123" }
 */
router.post('/:sessionId', (req: Request, res: Response) => {
    const { sessionId } = req.params;
    const { texto } = req.body;

    if (!texto || typeof texto !== 'string') {
        return res.status(400).json({
            sucesso: false,
            erro: 'Parâmetro "texto" é obrigatório'
        });
    }

    // Validar formato (4-6 caracteres alfanuméricos)
    const textoLimpo = texto.toUpperCase().trim();
    if (textoLimpo.length < 4 || textoLimpo.length > 6 || !/^[A-Z0-9]+$/.test(textoLimpo)) {
        return res.status(400).json({
            sucesso: false,
            erro: 'CAPTCHA deve ter 4-6 caracteres alfanuméricos'
        });
    }

    logger.info(`[API] CAPTCHA resolvido manualmente: ${textoLimpo} (sessão: ${sessionId})`);

    // Armazenar resultado
    captchaService.armazenarResultadoManual(sessionId, textoLimpo);

    res.json({
        sucesso: true,
        mensagem: 'CAPTCHA recebido e processado'
    });
});

export default router;
