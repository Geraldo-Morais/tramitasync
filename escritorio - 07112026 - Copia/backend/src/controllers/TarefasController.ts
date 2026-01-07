import { Response } from 'express';
import { AuthRequest } from '../middlewares/auth';
import database from '../database';
import logger from '../utils/logger';
import { PerfilUsuario } from '@inss-manager/shared';

/**
 * Controller de Tarefas
 * Gerencia atribuição e execução de tarefas por perfil
 */
export class TarefasController {
    /**
     * GET /api/v1/tarefas
     * Lista tarefas do usuário logado (filtradas por perfil)
     */
    async listarMinhasTarefas(req: AuthRequest, res: Response): Promise<void> {
        try {
            const usuario = req.user!;
            const { status, prioridade } = req.query;

            let query = `
                SELECT 
                    t.*,
                    p.protocolo_inss,
                    p.nome_segurado,
                    p.cpf_segurado,
                    e.resumo_exigencia,
                    u.nome as criado_por_nome
                FROM tarefas t
                LEFT JOIN processos p ON t.processo_id = p.id
                LEFT JOIN exigencias e ON t.exigencia_id = e.id
                LEFT JOIN usuarios u ON t.criado_por_id = u.id
                WHERE 1=1
            `;

            const params: any[] = [];
            let paramIndex = 1;

            // Admin vê todas as tarefas, outros perfis veem apenas suas tarefas
            if (usuario.perfil !== PerfilUsuario.ADMIN) {
                query += ` AND t.responsavel_perfil = $${paramIndex}`;
                params.push(usuario.perfil);
                paramIndex++;
            }

            if (status) {
                query += ` AND t.status = $${paramIndex}`;
                params.push(status);
                paramIndex++;
            }

            if (prioridade) {
                query += ` AND t.prioridade = $${paramIndex}`;
                params.push(prioridade);
                paramIndex++;
            }

            query += ` ORDER BY 
                CASE t.prioridade
                    WHEN 'URGENTE' THEN 1
                    WHEN 'ALTA' THEN 2
                    WHEN 'MEDIA' THEN 3
                    WHEN 'BAIXA' THEN 4
                END,
                t.created_at DESC
            `;

            const result = await database.query(query, params);

            res.status(200).json({
                success: true,
                data: result,
                total: result.length,
            });
        } catch (error) {
            logger.error('[TarefasController] Erro ao listar tarefas:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao listar tarefas',
            });
        }
    }

    /**
     * GET /api/v1/tarefas/:id
     * Obter detalhes de uma tarefa específica
     */
    async obterTarefa(req: AuthRequest, res: Response): Promise<void> {
        try {
            const { id } = req.params;
            const usuario = req.user!;

            const result = await database.query(
                `
                SELECT 
                    t.*,
                    p.protocolo_inss,
                    p.nome_segurado,
                    p.cpf_segurado,
                    p.tipo_beneficio,
                    e.resumo_exigencia,
                    e.prazo as prazo_exigencia,
                    u_criador.nome as criado_por_nome,
                    u_responsavel.nome as responsavel_nome
                FROM tarefas t
                LEFT JOIN processos p ON t.processo_id = p.id
                LEFT JOIN exigencias e ON t.exigencia_id = e.id
                LEFT JOIN usuarios u_criador ON t.criado_por_id = u_criador.id
                LEFT JOIN usuarios u_responsavel ON t.responsavel_usuario_id = u_responsavel.id
                WHERE t.id = $1
                `,
                [id]
            );

            if (result.length === 0) {
                res.status(404).json({
                    success: false,
                    message: 'Tarefa não encontrada',
                });
                return;
            }

            const tarefa = result[0];

            // Verificar se usuário tem permissão (mesmo perfil ou admin)
            if (
                tarefa.responsavel_perfil !== usuario.perfil &&
                usuario.perfil !== PerfilUsuario.ADMIN
            ) {
                res.status(403).json({
                    success: false,
                    message: 'Sem permissão para visualizar esta tarefa',
                });
                return;
            }

            res.status(200).json({
                success: true,
                data: tarefa,
            });
        } catch (error) {
            logger.error('[TarefasController] Erro ao obter tarefa:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao obter tarefa',
            });
        }
    }

    /**
     * PATCH /api/v1/tarefas/:id/iniciar
     * Iniciar trabalho em uma tarefa
     */
    async iniciarTarefa(req: AuthRequest, res: Response): Promise<void> {
        try {
            const { id } = req.params;
            const usuario = req.user!;

            // Verificar se tarefa existe e pertence ao perfil do usuário
            const tarefaResult = await database.query(
                'SELECT * FROM tarefas WHERE id = $1',
                [id]
            );

            if (tarefaResult.length === 0) {
                res.status(404).json({
                    success: false,
                    message: 'Tarefa não encontrada',
                });
                return;
            }

            const tarefa = tarefaResult[0];

            if (
                tarefa.responsavel_perfil !== usuario.perfil &&
                usuario.perfil !== PerfilUsuario.ADMIN
            ) {
                res.status(403).json({
                    success: false,
                    message: 'Sem permissão para iniciar esta tarefa',
                });
                return;
            }

            if (tarefa.status === 'CONCLUIDA') {
                res.status(400).json({
                    success: false,
                    message: 'Tarefa já foi concluída',
                });
                return;
            }

            // Atualizar tarefa
            await database.query(
                `
                UPDATE tarefas 
                SET 
                    status = 'EM_ANDAMENTO',
                    responsavel_usuario_id = $1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $2
                `,
                [usuario.id, id]
            );

            res.status(200).json({
                success: true,
                message: 'Tarefa iniciada com sucesso',
            });
        } catch (error) {
            logger.error('[TarefasController] Erro ao iniciar tarefa:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao iniciar tarefa',
            });
        }
    }

    /**
     * PATCH /api/v1/tarefas/:id/concluir
     * Marcar tarefa como concluída
     */
    async concluirTarefa(req: AuthRequest, res: Response): Promise<void> {
        try {
            const { id } = req.params;
            const { observacoes } = req.body;
            const usuario = req.user!;

            // Verificar tarefa
            const tarefaResult = await database.query(
                `
                SELECT t.*, p.responsavel_entrada_id, p.protocolo_inss
                FROM tarefas t
                LEFT JOIN processos p ON t.processo_id = p.id
                WHERE t.id = $1
                `,
                [id]
            );

            if (tarefaResult.length === 0) {
                res.status(404).json({
                    success: false,
                    message: 'Tarefa não encontrada',
                });
                return;
            }

            const tarefa = tarefaResult[0];

            if (
                tarefa.responsavel_perfil !== usuario.perfil &&
                usuario.perfil !== PerfilUsuario.ADMIN
            ) {
                res.status(403).json({
                    success: false,
                    message: 'Sem permissão para concluir esta tarefa',
                });
                return;
            }

            // Atualizar tarefa
            await database.query(
                `
                UPDATE tarefas 
                SET 
                    status = 'CONCLUIDA',
                    data_conclusao = CURRENT_TIMESTAMP,
                    observacoes = COALESCE($1, observacoes),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $2
                `,
                [observacoes, id]
            );

            // Criar notificação para responsável pela entrada (se existir)
            if (tarefa.responsavel_entrada_id) {
                await database.query(
                    `
                    INSERT INTO notificacoes (usuario_id, tipo, titulo, mensagem, link_processo_id, link_tarefa_id)
                    VALUES ($1, 'TAREFA_CONCLUIDA', $2, $3, $4, $5)
                    `,
                    [
                        tarefa.responsavel_entrada_id,
                        'TAREFA_CONCLUIDA',
                        `Tarefa concluída - Protocolo ${tarefa.protocolo_inss}`,
                        `${usuario.nome} concluiu: ${tarefa.titulo}${observacoes ? `\n\nObservações: ${observacoes}` : ''}`,
                        tarefa.processo_id,
                        id,
                    ]
                );
            }

            res.status(200).json({
                success: true,
                message: 'Tarefa concluída com sucesso',
            });
        } catch (error) {
            logger.error('[TarefasController] Erro ao concluir tarefa:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao concluir tarefa',
            });
        }
    }

    /**
     * POST /api/v1/tarefas
     * Criar nova tarefa manualmente (Admin)
     */
    async criarTarefa(req: AuthRequest, res: Response): Promise<void> {
        try {
            const {
                processo_id,
                exigencia_id,
                tipo,
                titulo,
                descricao,
                prioridade,
                responsavel_perfil,
                data_prazo,
            } = req.body;
            const usuario = req.user!;

            // Validações
            if (!processo_id || !tipo || !titulo || !responsavel_perfil) {
                res.status(400).json({
                    success: false,
                    message:
                        'Campos obrigatórios: processo_id, tipo, titulo, responsavel_perfil',
                });
                return;
            }

            const result = await database.query(
                `
                INSERT INTO tarefas (
                    processo_id,
                    exigencia_id,
                    tipo,
                    titulo,
                    descricao,
                    prioridade,
                    responsavel_perfil,
                    criado_por_id,
                    data_prazo
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                RETURNING *
                `,
                [
                    processo_id,
                    exigencia_id || null,
                    tipo,
                    titulo,
                    descricao || null,
                    prioridade || 'MEDIA',
                    responsavel_perfil,
                    usuario.id,
                    data_prazo || null,
                ]
            );

            res.status(201).json({
                success: true,
                message: 'Tarefa criada com sucesso',
                data: result[0],
            });
        } catch (error) {
            logger.error('[TarefasController] Erro ao criar tarefa:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao criar tarefa',
            });
        }
    }

    /**
     * GET /api/v1/tarefas/estatisticas
     * Estatísticas de tarefas por perfil
     */
    async obterEstatisticas(req: AuthRequest, res: Response): Promise<void> {
        try {
            const usuario = req.user!;

            // Admin vê estatísticas de todas as tarefas
            let query = `
                SELECT 
                    status,
                    prioridade,
                    COUNT(*) as total
                FROM tarefas
            `;
            const params: any[] = [];

            if (usuario.perfil !== PerfilUsuario.ADMIN) {
                query += ` WHERE responsavel_perfil = $1`;
                params.push(usuario.perfil);
            }

            query += `
                GROUP BY status, prioridade
                ORDER BY status, prioridade
            `;

            const result = await database.query(query, params);

            // Organizar dados
            const estatisticas = {
                pendentes: 0,
                em_andamento: 0,
                concluidas: 0,
                por_prioridade: {
                    urgente: 0,
                    alta: 0,
                    media: 0,
                    baixa: 0,
                },
            };

            result.forEach((row: any) => {
                const total = parseInt(row.total);

                if (row.status === 'PENDENTE') estatisticas.pendentes += total;
                if (row.status === 'EM_ANDAMENTO')
                    estatisticas.em_andamento += total;
                if (row.status === 'CONCLUIDA') estatisticas.concluidas += total;

                const prioridade = row.prioridade.toLowerCase();
                if (prioridade in estatisticas.por_prioridade) {
                    estatisticas.por_prioridade[
                        prioridade as keyof typeof estatisticas.por_prioridade
                    ] += total;
                }
            });

            res.status(200).json({
                success: true,
                data: estatisticas,
            });
        } catch (error) {
            logger.error(
                '[TarefasController] Erro ao obter estatísticas:',
                error
            );
            res.status(500).json({
                success: false,
                message: 'Erro ao obter estatísticas',
            });
        }
    }
}

export default new TarefasController();
