/**
 * ROTAS: Dashboard de Exigências e Alertas
 * 
 * Sistema completo de monitoramento:
 * - Exigências vencendo (30, 15, 10, 5, 3 dias, hoje)
 * - Benefícios concedidos/indeferidos
 * - Auto-remover GERALDO às 17:30
 */

import { Router, Request, Response } from 'express';
import { authenticate } from '../middlewares/auth';
import db from '../database';
import logger from '../utils/logger';

const router = Router();

// =====================================================
// DASHBOARD - Resumo Executivo
// =====================================================

/**
 * GET /api/dashboard/resumo
 * Resumo com contadores de tudo
 */
router.get('/dashboard/resumo', authenticate, async (req: Request, res: Response) => {
    try {
        const result = await db.queryFull('SELECT * FROM vw_dashboard_resumo');

        res.json({
            success: true,
            data: result.rows[0]
        });
    } catch (error) {
        logger.error('Erro ao buscar resumo do dashboard:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar resumo'
        });
    }
});

// =====================================================
// EXIGÊNCIAS - Por Urgência
// =====================================================

/**
 * GET /api/dashboard/exigencias
 * Lista exigências com filtros de urgência
 * Query params: ?urgencia=VENCIDA|HOJE|URGENTE|ALTA|MEDIA|NORMAL|BAIXA
 */
router.get('/dashboard/exigencias', authenticate, async (req: Request, res: Response) => {
    try {
        const { urgencia, dias } = req.query;

        let query = 'SELECT * FROM vw_exigencias_vencendo';
        const params: any[] = [];

        if (urgencia) {
            query += ' WHERE urgencia LIKE $1';
            params.push(`%${urgencia}%`);
        } else if (dias) {
            query += ' WHERE dias_restantes <= $1';
            params.push(parseInt(dias as string));
        }

        query += ' ORDER BY prazo_final ASC';

        const result = await db.queryFull(query, params.length > 0 ? params : undefined);

        res.json({
            success: true,
            total: result.rows.length,
            data: result.rows
        });
    } catch (error) {
        logger.error('Erro ao buscar exigências:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar exigências'
        });
    }
});

/**
 * GET /api/dashboard/exigencias/vencidas
 * Exigências vencidas (prazo passou)
 */
router.get('/dashboard/exigencias/vencidas', authenticate, async (req: Request, res: Response) => {
    try {
        const result = await db.queryFull(`
            SELECT * FROM vw_exigencias_vencendo
            WHERE urgencia = 'VENCIDA'
            ORDER BY dias_restantes ASC
        `);

        res.json({
            success: true,
            total: result.rows.length,
            data: result.rows
        });
    } catch (error) {
        logger.error('Erro ao buscar exigências vencidas:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar exigências vencidas'
        });
    }
});

/**
 * GET /api/dashboard/exigencias/hoje
 * Exigências que vencem HOJE
 */
router.get('/dashboard/exigencias/hoje', authenticate, async (req: Request, res: Response) => {
    try {
        const result = await db.queryFull(`
            SELECT * FROM vw_exigencias_vencendo
            WHERE urgencia = 'HOJE'
        `);

        res.json({
            success: true,
            total: result.rows.length,
            data: result.rows
        });
    } catch (error) {
        logger.error('Erro ao buscar exigências de hoje:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar exigências'
        });
    }
});

/**
 * GET /api/dashboard/exigencias/proximos/:dias
 * Exigências vencendo nos próximos X dias
 * Ex: /api/dashboard/exigencias/proximos/3
 */
router.get('/dashboard/exigencias/proximos/:dias', authenticate, async (req: Request, res: Response) => {
    try {
        const { dias } = req.params;

        const result = await db.queryFull(`
            SELECT * FROM vw_exigencias_vencendo
            WHERE dias_restantes <= $1 AND dias_restantes >= 0
            ORDER BY dias_restantes ASC
        `, [parseInt(dias)]);

        res.json({
            success: true,
            total: result.rows.length,
            filtro: `Próximos ${dias} dias`,
            data: result.rows
        });
    } catch (error) {
        logger.error('Erro ao buscar exigências:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar exigências'
        });
    }
});

// =====================================================
// BENEFÍCIOS - Concedidos e Indeferidos
// =====================================================

/**
 * GET /api/dashboard/beneficios/concedidos
 * Lista benefícios concedidos recentemente
 */
router.get('/dashboard/beneficios/concedidos', authenticate, async (req: Request, res: Response) => {
    try {
        const { limit = 100 } = req.query;

        const result = await db.queryFull(`
            SELECT * FROM vw_beneficios_concedidos
            LIMIT $1
        `, [limit]);

        res.json({
            success: true,
            total: result.rows.length,
            data: result.rows
        });
    } catch (error) {
        logger.error('Erro ao buscar benefícios concedidos:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar benefícios concedidos'
        });
    }
});

/**
 * GET /api/dashboard/beneficios/indeferidos
 * Lista benefícios indeferidos com tipo classificado
 */
router.get('/dashboard/beneficios/indeferidos', authenticate, async (req: Request, res: Response) => {
    try {
        const { tipo, limit = 100 } = req.query;

        let query = 'SELECT * FROM vw_beneficios_indeferidos';
        const params: any[] = [];

        if (tipo) {
            query += ' WHERE tipo_indeferimento = $1';
            params.push(tipo);
        }

        query += ' ORDER BY data_indeferimento DESC LIMIT $' + (params.length + 1);
        params.push(limit);

        const result = await db.queryFull(query, params);

        res.json({
            success: true,
            total: result.rows.length,
            data: result.rows
        });
    } catch (error) {
        logger.error('Erro ao buscar benefícios indeferidos:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar benefícios indeferidos'
        });
    }
});

// =====================================================
// AUTOMAÇÃO - Remover GERALDO
// =====================================================

/**
 * POST /api/dashboard/remover-geraldo
 * Remove tag GERALDO de exigências cumpridas
 * (Executado automaticamente às 17:30)
 */
router.post('/dashboard/remover-geraldo', authenticate, async (req: Request, res: Response) => {
    try {
        logger.info('🤖 Executando remoção automática de GERALDO...');

        const result = await db.queryFull('SELECT * FROM remover_geraldo_exigencias_cumpridas()');

        if (result.rows.length === 0) {
            return res.json({
                success: true,
                message: 'Nenhuma exigência para remover GERALDO',
                total: 0,
                data: []
            });
        }

        logger.info(`✅ GERALDO removido de ${result.rows.length} processos`);

        res.json({
            success: true,
            message: `GERALDO removido de ${result.rows.length} processos`,
            total: result.rows.length,
            data: result.rows
        });
    } catch (error) {
        logger.error('❌ Erro ao remover GERALDO:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao remover GERALDO'
        });
    }
});

// =====================================================
// SINCRONIZAÇÃO - Tags Tramitação
// =====================================================

/**
 * POST /api/dashboard/sincronizar-tags/:processoId
 * Sincroniza tags entre sistema e Tramitação
 */
router.post('/dashboard/sincronizar-tags/:processoId', authenticate, async (req: Request, res: Response) => {
    try {
        const { processoId } = req.params;
        const { novas_tags } = req.body;

        if (!Array.isArray(novas_tags)) {
            return res.status(400).json({
                success: false,
                error: 'novas_tags deve ser um array'
            });
        }

        const result = await db.queryFull(
            'SELECT sincronizar_tags_tramitacao($1, $2) as resultado',
            [parseInt(processoId), novas_tags]
        );

        const resultado = result.rows[0].resultado;

        // Registrar log
        await db.queryFull(`
            INSERT INTO logs_sincronizacao_tags (processo_id, protocolo, tags_antigas, tags_novas, origem)
            VALUES ($1, $2, $3, $4, $5)
        `, [
            parseInt(processoId),
            resultado.protocolo,
            resultado.tags_antigas,
            resultado.tags_novas,
            req.body.origem || 'MANUAL'
        ]);

        res.json({
            success: true,
            data: resultado
        });
    } catch (error) {
        logger.error('Erro ao sincronizar tags:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao sincronizar tags'
        });
    }
});

/**
 * GET /api/dashboard/logs-sincronizacao
 * Histórico de mudanças de tags
 */
router.get('/dashboard/logs-sincronizacao', authenticate, async (req: Request, res: Response) => {
    try {
        const { processo_id, limit = 50 } = req.query;

        let query = 'SELECT * FROM logs_sincronizacao_tags';
        const params: any[] = [];

        if (processo_id) {
            query += ' WHERE processo_id = $1';
            params.push(processo_id);
        }

        query += ' ORDER BY timestamp DESC LIMIT $' + (params.length + 1);
        params.push(limit);

        const result = await db.queryFull(query, params);

        res.json({
            success: true,
            total: result.rows.length,
            data: result.rows
        });
    } catch (error) {
        logger.error('Erro ao buscar logs:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar logs'
        });
    }
});

// =====================================================
// EMAIL ÚNICO - Gerenciamento
// =====================================================

/**
 * GET /api/dashboard/email-unico/:processoId
 * Obter email único do processo
 */
router.get('/dashboard/email-unico/:processoId', authenticate, async (req: Request, res: Response) => {
    try {
        const { processoId } = req.params;

        const result = await db.queryFull(`
            SELECT id, protocolo, nome_cliente, email_unico
            FROM processos
            WHERE id = $1
        `, [processoId]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Processo não encontrado'
            });
        }

        res.json({
            success: true,
            data: result.rows[0]
        });
    } catch (error) {
        logger.error('Erro ao buscar email único:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar email único'
        });
    }
});

/**
 * POST /api/dashboard/regenerar-email/:processoId
 * Regenerar email único
 */
router.post('/dashboard/regenerar-email/:processoId', authenticate, async (req: Request, res: Response) => {
    try {
        const { processoId } = req.params;

        // Limpar email atual para trigger gerar novo
        await db.queryFull(`
            UPDATE processos
            SET email_unico = NULL
            WHERE id = $1
        `, [processoId]);

        // Trigger gera novo automaticamente
        const result = await db.queryFull(`
            SELECT id, protocolo, email_unico
            FROM processos
            WHERE id = $1
        `, [processoId]);

        res.json({
            success: true,
            message: 'Email único regenerado',
            data: result.rows[0]
        });
    } catch (error) {
        logger.error('Erro ao regenerar email:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao regenerar email'
        });
    }
});

export default router;
