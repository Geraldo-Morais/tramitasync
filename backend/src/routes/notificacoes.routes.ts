/**
 * ROTAS DE NOTIFICAÇÕES WHATSAPP
 * Para N8N consumir e enviar mensagens
 */

import { Router } from 'express';
import database from '../database';
import logger from '../utils/logger';

const router = Router();

/**
 * GET /api/v1/notificacoes/whatsapp/pendentes
 * Lista notificações WhatsApp pendentes (para N8N consumir)
 */
router.get('/whatsapp/pendentes', async (req, res) => {
    try {
        const { limit = 10 } = req.query;

        const result = await database.getPool().query(
            `SELECT * FROM v_notificacoes_pendentes 
       ORDER BY created_at ASC 
       LIMIT $1`,
            [limit]
        );

        logger.info(`[NotificacoesAPI] ${result.rows.length} notificações pendentes`);

        res.json({
            success: true,
            data: result.rows,
            total: result.rows.length
        });
    } catch (error) {
        logger.error('[NotificacoesAPI] Erro ao buscar notificações:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar notificações pendentes'
        });
    }
});

/**
 * POST /api/v1/notificacoes/whatsapp/:id/marcar-enviada
 * N8N marca notificação como enviada após sucesso
 */
router.post('/whatsapp/:id/marcar-enviada', async (req, res) => {
    try {
        const { id } = req.params;

        await database.getPool().query(
            `UPDATE notificacoes_whatsapp 
       SET enviada = true, 
           data_envio = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
            [id]
        );

        logger.info(`[NotificacoesAPI] Notificação ${id} marcada como enviada`);

        res.json({ success: true });
    } catch (error) {
        logger.error('[NotificacoesAPI] Erro ao marcar como enviada:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao marcar notificação como enviada'
        });
    }
});

/**
 * POST /api/v1/notificacoes/whatsapp/:id/erro
 * N8N registra erro ao tentar enviar
 */
router.post('/whatsapp/:id/erro', async (req, res) => {
    try {
        const { id } = req.params;
        const { erro } = req.body;

        await database.getPool().query(
            `UPDATE notificacoes_whatsapp 
       SET tentativas = tentativas + 1,
           erro = $2,
           updated_at = NOW()
       WHERE id = $1`,
            [id, erro]
        );

        logger.warn(`[NotificacoesAPI] Erro ao enviar notificação ${id}: ${erro}`);

        res.json({ success: true });
    } catch (error) {
        logger.error('[NotificacoesAPI] Erro ao registrar erro:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao registrar erro de envio'
        });
    }
});

/**
 * POST /api/v1/notificacoes/whatsapp/:id/confirmacao
 * Webhook para N8N registrar confirmação de parceiro
 */
router.post('/whatsapp/:id/confirmacao', async (req, res) => {
    try {
        const { id } = req.params;
        const { resposta } = req.body;

        await database.getPool().query(
            `UPDATE notificacoes_whatsapp 
       SET confirmacao_recebida = true,
           data_confirmacao = NOW(),
           resposta = $2,
           updated_at = NOW()
       WHERE id = $1`,
            [id, resposta]
        );

        // Se confirmou que enviou, criar registro
        if (resposta?.toLowerCase().includes('enviado')) {
            const notif = await database.getPool().query(
                `SELECT exigencia_id FROM notificacoes_whatsapp WHERE id = $1`,
                [id]
            );

            if (notif.rows[0]?.exigencia_id) {
                await database.getPool().query(
                    `INSERT INTO confirmacoes_documentos (exigencia_id, parceiro_enviou, data_envio_parceiro)
           VALUES ($1, true, NOW())
           ON CONFLICT (exigencia_id) DO UPDATE 
           SET parceiro_enviou = true, data_envio_parceiro = NOW()`,
                    [notif.rows[0].exigencia_id]
                );

                logger.info(`[NotificacoesAPI] Parceiro confirmou envio de documentos para exigência ${notif.rows[0].exigencia_id}`);
            }
        }

        res.json({ success: true });
    } catch (error) {
        logger.error('[NotificacoesAPI] Erro ao registrar confirmação:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao registrar confirmação'
        });
    }
});

/**
 * GET /api/v1/parceiros
 * Lista todos os parceiros ativos
 */
router.get('/parceiros', async (req, res) => {
    try {
        const { cidade } = req.query;

        let query = 'SELECT * FROM parceiros WHERE ativo = true';
        const params: any[] = [];

        if (cidade) {
            query += ' AND cidade = $1';
            params.push(cidade);
        }

        query += ' ORDER BY cidade, nome';

        const result = await database.getPool().query(query, params);

        res.json({
            success: true,
            data: result.rows
        });
    } catch (error) {
        logger.error('[NotificacoesAPI] Erro ao listar parceiros:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao listar parceiros'
        });
    }
});

/**
 * POST /api/v1/parceiros
 * Criar novo parceiro
 */
router.post('/parceiros', async (req, res) => {
    try {
        const { nome, cidade, telefone_whatsapp, email } = req.body;

        if (!nome || !cidade || !telefone_whatsapp) {
            return res.status(400).json({
                success: false,
                error: 'Nome, cidade e telefone são obrigatórios'
            });
        }

        const result = await database.getPool().query(
            `INSERT INTO parceiros (nome, cidade, telefone_whatsapp, email)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
            [nome, cidade.toUpperCase(), telefone_whatsapp, email]
        );

        logger.info(`[NotificacoesAPI] Parceiro criado: ${nome} - ${cidade}`);

        res.json({
            success: true,
            data: result.rows[0]
        });
    } catch (error) {
        logger.error('[NotificacoesAPI] Erro ao criar parceiro:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao criar parceiro'
        });
    }
});

/**
 * PUT /api/v1/parceiros/:id
 * Atualizar parceiro
 */
router.put('/parceiros/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { nome, cidade, telefone_whatsapp, email, ativo } = req.body;

        const result = await database.getPool().query(
            `UPDATE parceiros 
       SET nome = COALESCE($2, nome),
           cidade = COALESCE($3, cidade),
           telefone_whatsapp = COALESCE($4, telefone_whatsapp),
           email = COALESCE($5, email),
           ativo = COALESCE($6, ativo),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
            [id, nome, cidade?.toUpperCase(), telefone_whatsapp, email, ativo]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Parceiro não encontrado'
            });
        }

        logger.info(`[NotificacoesAPI] Parceiro atualizado: ${id}`);

        res.json({
            success: true,
            data: result.rows[0]
        });
    } catch (error) {
        logger.error('[NotificacoesAPI] Erro ao atualizar parceiro:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao atualizar parceiro'
        });
    }
});

/**
 * GET /api/v1/notificacoes/whatsapp/buscar-por-telefone
 * Busca notificação por telefone (usado pelo webhook N8N)
 */
router.get('/whatsapp/buscar-por-telefone', async (req, res) => {
    try {
        const { telefone, status } = req.query;

        if (!telefone) {
            return res.status(400).json({
                success: false,
                error: 'Parâmetro telefone obrigatório'
            });
        }

        const result = await database.getPool().query(
            `SELECT nw.id, nw.processo_id, nw.exigencia_id, nw.tipo, 
              nw.telefone_destino, nw.cidade, nw.mensagem, 
              nw.enviada, nw.data_envio,
              nw.confirmacao_recebida, nw.data_confirmacao
       FROM notificacoes_whatsapp nw
       WHERE nw.telefone_destino = $1
         AND ($2::text IS NULL OR (
           CASE WHEN $2 = 'ENVIADA' THEN nw.enviada = true
                WHEN $2 = 'CONFIRMADA' THEN nw.confirmacao_recebida = true
                ELSE true
           END
         ))
       ORDER BY nw.created_at DESC 
       LIMIT 1`,
            [telefone, status || null]
        );

        logger.info(`[NotificacoesAPI] Busca telefone ${telefone}: ${result.rows.length} encontradas`);

        res.json({
            success: true,
            data: result.rows[0] || null
        });
    } catch (error) {
        logger.error('[NotificacoesAPI] Erro ao buscar por telefone:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar notificação por telefone'
        });
    }
});

/**
 * GET /api/v1/notificacoes/whatsapp/sem-confirmacao
 * Lista notificações enviadas mas não confirmadas (para lembrete D-2)
 */
router.get('/whatsapp/sem-confirmacao', async (req, res) => {
    try {
        const { limite = 50 } = req.query;

        const result = await database.getPool().query(
            `SELECT nw.id, nw.processo_id, nw.exigencia_id, nw.tipo,
              nw.telefone_destino, nw.cidade, nw.mensagem,
              nw.data_envio, nw.tentativas,
              EXTRACT(DAY FROM (nw.created_at + INTERVAL '10 days' - CURRENT_TIMESTAMP)) as dias_restantes
       FROM notificacoes_whatsapp nw
       WHERE nw.enviada = true
         AND nw.confirmacao_recebida = false
         AND nw.created_at + INTERVAL '10 days' > CURRENT_TIMESTAMP
       ORDER BY nw.created_at ASC
       LIMIT $1`,
            [limite]
        );

        logger.info(`[NotificacoesAPI] ${result.rows.length} notificações sem confirmação`);

        res.json({
            success: true,
            data: result.rows,
            total: result.rows.length
        });
    } catch (error) {
        logger.error('[NotificacoesAPI] Erro ao buscar sem confirmação:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar notificações sem confirmação'
        });
    }
});

/**
 * POST /api/v1/notificacoes/whatsapp/:id/lembrete
 * Incrementa contador de lembretes enviados
 */
router.post('/whatsapp/:id/lembrete', async (req, res) => {
    try {
        const { id } = req.params;

        const result = await database.getPool().query(
            `UPDATE notificacoes_whatsapp
       SET lembretes_enviados = lembretes_enviados + 1,
           ultimo_lembrete = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING id, lembretes_enviados, ultimo_lembrete`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Notificação não encontrada'
            });
        }

        logger.info(`[NotificacoesAPI] Lembrete registrado: ${id} (total: ${result.rows[0].lembretes_enviados})`);

        res.json({
            success: true,
            data: result.rows[0]
        });
    } catch (error) {
        logger.error('[NotificacoesAPI] Erro ao registrar lembrete:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao registrar lembrete'
        });
    }
});


export default router;
