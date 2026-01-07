import { Router } from 'express';
import authController from '../controllers/AuthController';
import { authenticate, requireAdmin } from '../middlewares/auth';

const router = Router();

/**
 * Rotas de Autenticação
 * Prefixo: /api/v1/auth
 */

// Rotas públicas
router.post('/login', authController.login.bind(authController));

// Rotas protegidas (requerem autenticação)
router.get('/me', authenticate, authController.me.bind(authController));
router.post('/change-password', authenticate, authController.changePassword.bind(authController));

// Rotas de administração (apenas Admin)
router.post('/register', authenticate, requireAdmin, authController.register.bind(authController));
router.get('/users', authenticate, requireAdmin, authController.listUsers.bind(authController));
router.patch('/users/:id/perfil', authenticate, requireAdmin, authController.updateUserPerfil.bind(authController));
router.patch('/users/:id/status', authenticate, requireAdmin, authController.toggleUserStatus.bind(authController));

export default router;
