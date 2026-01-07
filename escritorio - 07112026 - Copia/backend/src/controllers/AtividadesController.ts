import { Request, Response } from 'express';
import logger from '../utils/logger';
import db from '../database';

const pool = db.getPool();

/**
 * Controller para Atividades (Perícia e Avaliação Social)
 * Gerencia agendamentos de perícia médica e avaliação social dos processos
 */
class AtividadesController {
    /**
     * GET /api/v1/processos/:processoId/atividades
     * Lista todas as atividades de um processo
     */
    async listarPorProcesso(req: Request, res: Response): Promise<void> {
        try {
            const { processoId } = req.params;
            const { tipo } = req.query; // Filtro opcional por tipo

            let query = `
                SELECT 
                    a.*,
                    p.protocolo_inss,
                    p.cpf_segurado,
                    p.nome_segurado
                FROM atividades a
                INNER JOIN processos p ON a.processo_id = p.id
                WHERE a.processo_id = $1
            `;

            const params: any[] = [processoId];

            if (tipo) {
                query += ` AND a.tipo = $2`;
                params.push(tipo);
            }

            query += ` ORDER BY a.data_hora_agendamento DESC NULLS LAST, a.created_at DESC`;

            const { rows } = await pool.query(query, params);

            res.json({
                success: true,
                data: rows,
                total: rows.length,
            });
        } catch (error: any) {
            logger.error('[AtividadesController] Erro ao listar atividades:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao listar atividades',
                error: error.message,
            });
        }
    }

    /**
     * GET /api/v1/processos/:processoId/atividades/agendada
     * Retorna atividade agendada ativa (se houver)
     */
    async buscarAgendamentoAtivo(req: Request, res: Response): Promise<void> {
        try {
            const { processoId } = req.params;
            const { tipo } = req.query;

            let query = `
                SELECT 
                    a.*,
                    p.protocolo_inss,
                    p.cpf_segurado,
                    p.nome_segurado
                FROM atividades a
                INNER JOIN processos p ON a.processo_id = p.id
                WHERE a.processo_id = $1
                AND a.status_agendamento = 'AGENDADO'
                AND a.data_hora_agendamento >= CURRENT_TIMESTAMP
            `;

            const params: any[] = [processoId];

            if (tipo) {
                query += ` AND a.tipo = $2`;
                params.push(tipo);
            }

            query += ` ORDER BY a.data_hora_agendamento ASC LIMIT 1`;

            const { rows } = await pool.query(query, params);

            if (rows.length === 0) {
                res.json({
                    success: true,
                    data: null,
                    message: 'Nenhum agendamento ativo encontrado',
                });
                return;
            }

            res.json({
                success: true,
                data: rows[0],
            });
        } catch (error: any) {
            logger.error('[AtividadesController] Erro ao buscar agendamento ativo:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao buscar agendamento ativo',
                error: error.message,
            });
        }
    }

    /**
     * POST /api/v1/processos/:processoId/atividades
     * Cria nova atividade
     */
    async criar(req: Request, res: Response): Promise<void> {
        try {
            const { processoId } = req.params;
            const {
                tipo,
                etapa,
                status_agendamento,
                data_hora_agendamento,
                unidade_atendimento,
                endereco_unidade,
                observacoes,
                id_agendamento_inss,
            } = req.body;

            // Validações
            if (!tipo || !['PERICIA', 'AVALIACAO_SOCIAL'].includes(tipo)) {
                res.status(400).json({
                    success: false,
                    message: 'Tipo inválido. Use PERICIA ou AVALIACAO_SOCIAL',
                });
                return;
            }

            if (!etapa) {
                res.status(400).json({
                    success: false,
                    message: 'Etapa é obrigatória',
                });
                return;
            }

            const { rows } = await pool.query(
                `INSERT INTO atividades (
                    processo_id,
                    tipo,
                    etapa,
                    status_agendamento,
                    data_hora_agendamento,
                    unidade_atendimento,
                    endereco_unidade,
                    observacoes,
                    id_agendamento_inss
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                RETURNING *`,
                [
                    processoId,
                    tipo,
                    etapa,
                    status_agendamento || 'PENDENTE',
                    data_hora_agendamento || null,
                    unidade_atendimento || null,
                    endereco_unidade || null,
                    observacoes || null,
                    id_agendamento_inss || null,
                ]
            );

            logger.info(`[AtividadesController] Atividade criada: ${rows[0].id} - Tipo: ${tipo}`);

            res.status(201).json({
                success: true,
                message: 'Atividade criada com sucesso',
                data: rows[0],
            });
        } catch (error: any) {
            logger.error('[AtividadesController] Erro ao criar atividade:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao criar atividade',
                error: error.message,
            });
        }
    }

    /**
     * PATCH /api/v1/atividades/:id
     * Atualiza atividade existente
     */
    async atualizar(req: Request, res: Response): Promise<void> {
        try {
            const { id } = req.params;
            const {
                etapa,
                status_agendamento,
                data_hora_agendamento,
                unidade_atendimento,
                endereco_unidade,
                observacoes,
                motivo_cancelamento,
                comprovante_url,
                comprovante_path,
            } = req.body;

            const updates: string[] = [];
            const values: any[] = [];
            let paramCount = 1;

            if (etapa) {
                updates.push(`etapa = $${paramCount++}`);
                values.push(etapa);
            }
            if (status_agendamento) {
                updates.push(`status_agendamento = $${paramCount++}`);
                values.push(status_agendamento);
            }
            if (data_hora_agendamento !== undefined) {
                updates.push(`data_hora_agendamento = $${paramCount++}`);
                values.push(data_hora_agendamento);
            }
            if (unidade_atendimento !== undefined) {
                updates.push(`unidade_atendimento = $${paramCount++}`);
                values.push(unidade_atendimento);
            }
            if (endereco_unidade !== undefined) {
                updates.push(`endereco_unidade = $${paramCount++}`);
                values.push(endereco_unidade);
            }
            if (observacoes !== undefined) {
                updates.push(`observacoes = $${paramCount++}`);
                values.push(observacoes);
            }
            if (motivo_cancelamento !== undefined) {
                updates.push(`motivo_cancelamento = $${paramCount++}`);
                values.push(motivo_cancelamento);
            }
            if (comprovante_url !== undefined) {
                updates.push(`comprovante_url = $${paramCount++}`);
                values.push(comprovante_url);
            }
            if (comprovante_path !== undefined) {
                updates.push(`comprovante_path = $${paramCount++}`);
                values.push(comprovante_path);
            }

            if (updates.length === 0) {
                res.status(400).json({
                    success: false,
                    message: 'Nenhum campo para atualizar',
                });
                return;
            }

            values.push(id);
            const query = `
                UPDATE atividades 
                SET ${updates.join(', ')}
                WHERE id = $${paramCount}
                RETURNING *
            `;

            const { rows } = await pool.query(query, values);

            if (rows.length === 0) {
                res.status(404).json({
                    success: false,
                    message: 'Atividade não encontrada',
                });
                return;
            }

            logger.info(`[AtividadesController] Atividade atualizada: ${id}`);

            res.json({
                success: true,
                message: 'Atividade atualizada com sucesso',
                data: rows[0],
            });
        } catch (error: any) {
            logger.error('[AtividadesController] Erro ao atualizar atividade:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao atualizar atividade',
                error: error.message,
            });
        }
    }

    /**
     * DELETE /api/v1/atividades/:id
     * Remove atividade
     */
    async deletar(req: Request, res: Response): Promise<void> {
        try {
            const { id } = req.params;

            const { rowCount } = await pool.query(
                'DELETE FROM atividades WHERE id = $1',
                [id]
            );

            if (rowCount === 0) {
                res.status(404).json({
                    success: false,
                    message: 'Atividade não encontrada',
                });
                return;
            }

            logger.info(`[AtividadesController] Atividade deletada: ${id}`);

            res.json({
                success: true,
                message: 'Atividade removida com sucesso',
            });
        } catch (error: any) {
            logger.error('[AtividadesController] Erro ao deletar atividade:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao deletar atividade',
                error: error.message,
            });
        }
    }
}

export default new AtividadesController();
