import { Router } from 'express';
import AdminController from '../controllers/AdminController';
import { authenticate, authorize } from '../middlewares/auth';
import { PerfilUsuario } from '@inss-manager/shared';
import responsabilidadesRoutes from './admin-responsabilidades.routes';

const router = Router();

/**
 * Rotas administrativas
 * Apenas perfil 'admin' tem acesso
 */

// Todas as rotas exigem autenticação + perfil admin
router.use(authenticate);
router.use(authorize([PerfilUsuario.ADMIN]));

/**
 * GET /api/v1/admin/status
 * Status operacional do sistema
 */
router.get('/status', (req, res) => AdminController.getStatus(req, res));

/**
 * POST /api/v1/admin/token/renew
 * Renovar token INSS
 * Body: { url: string }
 */
router.post('/token/renew', (req, res) => AdminController.renewToken(req, res));

/**
 * POST /api/v1/admin/worker/run
 * Executar worker INSS manualmente
 */
router.post('/worker/run', (req, res) => AdminController.runWorker(req, res));

/**
 * GET /api/v1/admin/logs?type=all&lines=50
 * Obter últimas linhas dos logs
 */
router.get('/logs', (req, res) => AdminController.getLogs(req, res));

/**
 * GET /api/v1/admin/usuarios
 * Listar todos os usuários
 */
router.get('/usuarios', (req, res) => AdminController.getUsuarios(req, res));

/**
 * POST /api/v1/admin/usuarios
 * Criar novo usuário
 */
router.post('/usuarios', (req, res) => AdminController.createUsuario(req, res));

/**
 * PATCH /api/v1/admin/usuarios/:id
 * Atualizar usuário existente
 */
router.patch('/usuarios/:id', (req, res) => AdminController.updateUsuario(req, res));

/**
 * DELETE /api/v1/admin/usuarios/:id
 * Deletar usuário
 */
router.delete('/usuarios/:id', (req, res) => AdminController.deleteUsuario(req, res));

/**
 * Rotas de responsabilidades (configuração de usuários)
 */
router.use('/responsabilidades', responsabilidadesRoutes);

export default router;
