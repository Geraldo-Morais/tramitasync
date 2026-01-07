import { Router } from 'express';
import Database from '../database';
import logger from '../utils/logger';
import { authenticate } from '../middlewares/auth';

const router = Router();

/**
 * GET /api/v1/cidades
 * Lista todas as cidades
 */
router.get('/', authenticate, async (req, res) => {
    try {
        const result = await Database.query(`
            SELECT id, nome, uf, ativo
            FROM cidades
            WHERE ativo = true
            ORDER BY nome
        `);

        res.json({
            success: true,
            data: result
        });
    } catch (error: any) {
        logger.error('[CidadesAPI] Erro ao listar cidades:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao listar cidades',
            error: error.message
        });
    }
});

export default router;
