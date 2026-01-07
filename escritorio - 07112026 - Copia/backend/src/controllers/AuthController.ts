import { Request, Response } from 'express';
import authService from '../services/AuthService';
import { AuthRequest } from '../middlewares/auth';
import logger from '../utils/logger';

/**
 * Controller de Autenticação
 * Rotas: POST /auth/login, POST /auth/register, GET /auth/me
 */
export class AuthController {
    /**
     * POST /api/v1/auth/login
     * Realiza login do usuário
     */
    async login(req: Request, res: Response): Promise<void> {
        try {
            const { email, senha } = req.body;

            // Validação básica
            if (!email || !senha) {
                res.status(400).json({
                    success: false,
                    message: 'Email e senha são obrigatórios',
                });
                return;
            }

            // Chamar serviço de autenticação
            const result = await authService.login({ email, senha });

            if (!result.success) {
                res.status(401).json(result);
                return;
            }

            res.status(200).json(result);
        } catch (error) {
            logger.error('[AuthController] Erro no login:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao fazer login',
            });
        }
    }

    /**
     * POST /api/v1/auth/register
     * Registra novo usuário (apenas Admin)
     */
    async register(req: Request, res: Response): Promise<void> {
        try {
            const { nome, email, senha, perfil } = req.body;

            // Validação básica
            if (!nome || !email || !senha || !perfil) {
                res.status(400).json({
                    success: false,
                    message: 'Todos os campos são obrigatórios',
                });
                return;
            }

            // Validar perfil
            const perfisValidos = ['secretaria', 'administrativo', 'intermediacao', 'judicial', 'admin'];
            if (!perfisValidos.includes(perfil)) {
                res.status(400).json({
                    success: false,
                    message: `Perfil inválido. Perfis válidos: ${perfisValidos.join(', ')}`,
                });
                return;
            }

            // Validar senha (mínimo 8 caracteres)
            if (senha.length < 8) {
                res.status(400).json({
                    success: false,
                    message: 'A senha deve ter no mínimo 8 caracteres',
                });
                return;
            }

            // Chamar serviço de registro
            const result = await authService.register({ nome, email, senha, perfil });

            if (!result.success) {
                res.status(400).json(result);
                return;
            }

            res.status(201).json(result);
        } catch (error) {
            logger.error('[AuthController] Erro no registro:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao registrar usuário',
            });
        }
    }

    /**
     * GET /api/v1/auth/me
     * Retorna dados do usuário autenticado
     */
    async me(req: Request, res: Response): Promise<void> {
        try {
            const authReq = req as AuthRequest;

            if (!authReq.user) {
                res.status(401).json({
                    success: false,
                    message: 'Usuário não autenticado',
                });
                return;
            }

            // Buscar dados completos do usuário
            const user = await authService.getUserById(authReq.user.id);

            if (!user) {
                res.status(404).json({
                    success: false,
                    message: 'Usuário não encontrado',
                });
                return;
            }

            res.status(200).json({
                success: true,
                data: {
                    user,
                },
            });
        } catch (error) {
            logger.error('[AuthController] Erro ao buscar usuário:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao buscar usuário',
            });
        }
    }

    /**
     * GET /api/v1/auth/users
     * Lista todos os usuários (apenas Admin)
     */
    async listUsers(req: Request, res: Response): Promise<void> {
        try {
            const users = await authService.listUsers();

            res.status(200).json({
                success: true,
                data: {
                    users,
                    total: users.length,
                },
            });
        } catch (error) {
            logger.error('[AuthController] Erro ao listar usuários:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao listar usuários',
            });
        }
    }

    /**
     * PATCH /api/v1/auth/users/:id/perfil
     * Atualiza perfil do usuário (apenas Admin)
     */
    async updateUserPerfil(req: Request, res: Response): Promise<void> {
        try {
            const { id } = req.params;
            const { perfil } = req.body;

            if (!perfil) {
                res.status(400).json({
                    success: false,
                    message: 'Perfil é obrigatório',
                });
                return;
            }

            const success = await authService.updateUserPerfil(id, perfil);

            if (!success) {
                res.status(400).json({
                    success: false,
                    message: 'Erro ao atualizar perfil',
                });
                return;
            }

            res.status(200).json({
                success: true,
                message: 'Perfil atualizado com sucesso',
            });
        } catch (error) {
            logger.error('[AuthController] Erro ao atualizar perfil:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao atualizar perfil',
            });
        }
    }

    /**
     * PATCH /api/v1/auth/users/:id/status
     * Ativa/Desativa usuário (apenas Admin)
     */
    async toggleUserStatus(req: Request, res: Response): Promise<void> {
        try {
            const { id } = req.params;
            const { ativo } = req.body;

            if (typeof ativo !== 'boolean') {
                res.status(400).json({
                    success: false,
                    message: 'Status (ativo) deve ser true ou false',
                });
                return;
            }

            const success = await authService.toggleUserStatus(id, ativo);

            if (!success) {
                res.status(400).json({
                    success: false,
                    message: 'Erro ao atualizar status',
                });
                return;
            }

            res.status(200).json({
                success: true,
                message: `Usuário ${ativo ? 'ativado' : 'desativado'} com sucesso`,
            });
        } catch (error) {
            logger.error('[AuthController] Erro ao atualizar status:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao atualizar status',
            });
        }
    }

    /**
     * POST /api/v1/auth/change-password
     * Altera senha do usuário autenticado
     */
    async changePassword(req: Request, res: Response): Promise<void> {
        try {
            const authReq = req as AuthRequest;
            const { senhaAtual, novaSenha } = req.body;

            if (!authReq.user) {
                res.status(401).json({
                    success: false,
                    message: 'Usuário não autenticado',
                });
                return;
            }

            if (!senhaAtual || !novaSenha) {
                res.status(400).json({
                    success: false,
                    message: 'Senha atual e nova senha são obrigatórias',
                });
                return;
            }

            if (novaSenha.length < 8) {
                res.status(400).json({
                    success: false,
                    message: 'A nova senha deve ter no mínimo 8 caracteres',
                });
                return;
            }

            const result = await authService.changePassword(
                authReq.user.id,
                senhaAtual,
                novaSenha
            );

            if (!result.success) {
                res.status(400).json(result);
                return;
            }

            res.status(200).json(result);
        } catch (error) {
            logger.error('[AuthController] Erro ao alterar senha:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao alterar senha',
            });
        }
    }
}

export default new AuthController();
