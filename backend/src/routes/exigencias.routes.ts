import { Router } from 'express';
import Database from '../database';
import logger from '../utils/logger';
import { authenticate } from '../middlewares/auth';

const router = Router();

/**
 * GET /api/v1/exigencias
 * Lista exigências com filtros
 */
router.get('/', authenticate, async (req, res) => {
    try {
        const { status, documentos_entregues, cidade } = req.query;

        let query = `
            SELECT 
                e.id,
                e.tipo,
                e.descricao,
                e.prazo_final,
                e.documentos_exigidos,
                e.status,
                e.data_criacao as data_criacao,
                p.numero_processo as processo_numero,
                p.nome_cliente as cliente_nome,
                p.cpf as cliente_cpf,
                p.beneficio,
                p.cidade,
                p.email_exclusivo_tramitacao as email_exclusivo,
                p.tags,
                u.nome as responsavel_nome,
                (SELECT COUNT(*) FROM notificacoes_whatsapp nw WHERE nw.exigencia_id = e.id AND nw.enviada = true) as notificacoes_enviadas,
                (p.tags @> ARRAY['Documentos Entregues']::TEXT[]) as documentos_entregues
            FROM exigencias e
            INNER JOIN processos p ON e.processo_id = p.id
            LEFT JOIN usuarios u ON p.responsavel_entrada_id = u.id
            WHERE 1=1
        `;

        const params: any[] = [];
        let paramIndex = 1;

        if (status) {
            query += ` AND e.status = $${paramIndex}`;
            params.push(status);
            paramIndex++;
        }

        if (documentos_entregues === 'true') {
            query += ` AND p.tags @> ARRAY['Documentos Entregues']::TEXT[]`;
        }

        if (cidade) {
            query += ` AND p.cidade ILIKE $${paramIndex}`;
            params.push(`%${cidade}%`);
            paramIndex++;
        }

        query += ` ORDER BY e.prazo_final ASC, e.data_criacao DESC`;

        const result = await Database.query(query, params);

        res.json({
            success: true,
            data: result
        });
    } catch (error: any) {
        logger.error('[ExigenciasAPI] Erro ao listar exigências:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao listar exigências',
            error: error.message
        });
    }
});

/**
 * GET /api/v1/exigencias/:id
 * Detalhes de uma exigência
 */
router.get('/:id', authenticate, async (req, res) => {
    try {
        const { id } = req.params;

        const result = await Database.query(`
            SELECT 
                e.*,
                p.numero_processo,
                p.nome_cliente,
                p.cpf as cliente_cpf,
                p.beneficio,
                p.cidade,
                p.email_exclusivo_tramitacao,
                p.tags,
                u.nome as responsavel_nome,
                json_agg(
                    json_build_object(
                        'id', nw.id,
                        'telefone', nw.telefone_destino,
                        'enviada', nw.enviada,
                        'data_envio', nw.data_envio,
                        'confirmacao_parceiro', nw.confirmacao_parceiro,
                        'data_confirmacao', nw.data_confirmacao_parceiro
                    )
                ) FILTER (WHERE nw.id IS NOT NULL) as notificacoes
            FROM exigencias e
            INNER JOIN processos p ON e.processo_id = p.id
            LEFT JOIN usuarios u ON p.responsavel_entrada_id = u.id
            LEFT JOIN notificacoes_whatsapp nw ON e.id = nw.exigencia_id
            WHERE e.id = $1
            GROUP BY e.id, p.id, u.id
        `, [id]);

        if (result.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Exigência não encontrada'
            });
        }

        res.json({
            success: true,
            data: result[0]
        });
    } catch (error: any) {
        logger.error('[ExigenciasAPI] Erro ao buscar exigência:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao buscar exigência',
            error: error.message
        });
    }
});

/**
 * POST /api/v1/exigencias/:id/cumprir
 * Marca exigência como cumprida
 */
router.post('/:id/cumprir', authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        const { observacao } = req.body;

        // Atualizar exigência
        await Database.query(`
            UPDATE exigencias
            SET status = 'CUMPRIDA', updated_at = NOW()
            WHERE id = $1
        `, [id]);

        // Buscar processo relacionado
        const exigResult = await Database.query(`
            SELECT processo_id FROM exigencias WHERE id = $1
        `, [id]);

        if (exigResult.length > 0) {
            const processoId = exigResult[0].processo_id;

            // Remover tag "Em Exigência" e "Documentos Entregues"
            await Database.query(`
                UPDATE processos
                SET tags = array_remove(array_remove(tags, 'Em Exigência'), 'Documentos Entregues')
                WHERE id = $1
            `, [processoId]);

            // TODO: Adicionar nota no Tramitação via API
            if (observacao) {
                logger.info(`[ExigenciasAPI] Exigência ${id} cumprida com observação: ${observacao}`);
            }
        }

        res.json({
            success: true,
            message: 'Exigência marcada como cumprida'
        });
    } catch (error: any) {
        logger.error('[ExigenciasAPI] Erro ao cumprir exigência:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao cumprir exigência',
            error: error.message
        });
    }
});

export default router;
