import { Request, Response } from 'express';
import processosService from '../services/ProcessosService';
import { AuthRequest } from '../middlewares/auth';
import logger from '../utils/logger';

/**
 * Controller de Processos
 * Rotas: GET /processos, GET /processos/:id, GET /processos/dashboard, PATCH /processos/:id/status
 */
export class ProcessosController {
    /**
     * GET /api/v1/processos
     * Lista processos com filtros e paginação
     */
    async list(req: Request, res: Response): Promise<void> {
        try {
            const {
                status_inss,
                classe_final,
                status_fluxo,
                cpf,
                protocolo,
                tipo_beneficio,
                mes,
                responsavel_id,
                page,
                limit,
            } = req.query;

            const result = await processosService.list({
                status_inss: status_inss as any,
                classe_final: classe_final as any,
                status_fluxo: status_fluxo as any,
                cpf: cpf as string,
                protocolo: protocolo as string,
                tipo_beneficio: tipo_beneficio as string,
                mes: mes as string,
                responsavel_id: responsavel_id as string,
                page: page ? parseInt(page as string) : undefined,
                limit: limit ? parseInt(limit as string) : undefined,
            });

            if (!result.success) {
                res.status(400).json(result);
                return;
            }

            res.status(200).json(result);
        } catch (error) {
            logger.error('[ProcessosController] Erro ao listar processos:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao listar processos',
            });
        }
    }

    /**
     * GET /api/v1/processos/dashboard
     * Retorna dados agregados para o Dashboard
     */
    async dashboard(req: Request, res: Response): Promise<void> {
        try {
            const { mes } = req.query;

            const data = await processosService.getDashboardData({
                mes: mes as string,
            });

            res.status(200).json({
                success: true,
                data,
            });
        } catch (error) {
            logger.error('[ProcessosController] Erro ao obter dados do dashboard:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao obter dados do dashboard',
            });
        }
    }

    /**
     * GET /api/v1/processos/:id
     * Busca processo por ID com detalhes completos
     */
    async findById(req: Request, res: Response): Promise<void> {
        try {
            const { id } = req.params;

            const result = await processosService.findById(id);

            if (!result.success) {
                res.status(404).json(result);
                return;
            }

            res.status(200).json(result);
        } catch (error) {
            logger.error('[ProcessosController] Erro ao buscar processo:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao buscar processo',
            });
        }
    }

    /**
     * PATCH /api/v1/processos/:id/status-fluxo
     * Atualiza status interno do fluxo de trabalho
     */
    async updateStatusFluxo(req: Request, res: Response): Promise<void> {
        try {
            const authReq = req as AuthRequest;
            const { id } = req.params;
            const { status_fluxo, observacao } = req.body;

            if (!authReq.user) {
                res.status(401).json({
                    success: false,
                    message: 'Usuário não autenticado',
                });
                return;
            }

            if (!status_fluxo) {
                res.status(400).json({
                    success: false,
                    message: 'Status é obrigatório',
                });
                return;
            }

            const result = await processosService.updateStatusFluxo(
                id,
                status_fluxo,
                observacao || '',
                authReq.user.id
            );

            if (!result.success) {
                res.status(400).json(result);
                return;
            }

            res.status(200).json(result);
        } catch (error) {
            logger.error('[ProcessosController] Erro ao atualizar status:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao atualizar status',
            });
        }
    }

    /**
     * PATCH /api/v1/processos/:id/responsavel
     * Atribui responsável ao processo
     */
    async atribuirResponsavel(req: Request, res: Response): Promise<void> {
        try {
            const authReq = req as AuthRequest;
            const { id } = req.params;
            const { responsavel_id } = req.body;

            if (!authReq.user) {
                res.status(401).json({
                    success: false,
                    message: 'Usuário não autenticado',
                });
                return;
            }

            if (!responsavel_id) {
                res.status(400).json({
                    success: false,
                    message: 'ID do responsável é obrigatório',
                });
                return;
            }

            const result = await processosService.atribuirResponsavel(
                id,
                responsavel_id,
                authReq.user.id
            );

            if (!result.success) {
                res.status(400).json(result);
                return;
            }

            res.status(200).json(result);
        } catch (error) {
            logger.error('[ProcessosController] Erro ao atribuir responsável:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao atribuir responsável',
            });
        }
    }

    /**
     * GET /api/v1/processos/exigencias?status=PENDENTE
     * Lista processos com exigências pendentes
     */
    async exigenciasPendentes(req: Request, res: Response): Promise<void> {
        try {
            const { status } = req.query;

            // Converter status do frontend para status_fluxo do backend
            const statusFluxo = status === 'PENDENTE' ? 'PENDENTE' : undefined;

            const result = await processosService.list({
                classe_final: 'EXIGÊNCIA' as any,
                status_fluxo: statusFluxo as any,
                limit: 100,
                page: 1,
            });

            if (!result.success) {
                res.status(400).json(result);
                return;
            }

            res.status(200).json(result);
        } catch (error) {
            logger.error('[ProcessosController] Erro ao listar exigências:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao listar exigências',
            });
        }
    }

    /**
     * GET /api/v1/processos/stats
     * Estatísticas rápidas (totais por status)
     */
    async stats(req: Request, res: Response): Promise<void> {
        try {
            // Implementar query simples para estatísticas
            const data = await processosService.getDashboardData();

            res.status(200).json({
                success: true,
                data: {
                    totais: data.totais,
                    resultados: data.resultados,
                },
            });
        } catch (error) {
            logger.error('[ProcessosController] Erro ao obter estatísticas:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao obter estatísticas',
            });
        }
    }
}

export default new ProcessosController();
