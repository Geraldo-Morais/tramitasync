import { Router } from 'express';
import { PerfilUsuario } from '@inss-manager/shared';
import processosController from '../controllers/ProcessosController';
import { authenticate, authorize } from '../middlewares/auth';

const router = Router();

/**
 * Rotas de Processos
 * Prefixo: /api/v1/processos
 * 
 * Todas as rotas requerem autenticação
 */

// Dashboard e estatísticas (todos os perfis autenticados)
router.get('/dashboard', authenticate, processosController.dashboard.bind(processosController));
router.get('/stats', authenticate, processosController.stats.bind(processosController));

// Exigências pendentes (Intermediação + Admin)
router.get(
    '/exigencias',
    authenticate,
    authorize([
        PerfilUsuario.INTERMEDIACAO,
        PerfilUsuario.ADMINISTRATIVO,
        PerfilUsuario.ADMIN,
    ]),
    processosController.exigenciasPendentes.bind(processosController)
);

// CRUD de processos
router.get('/', authenticate, processosController.list.bind(processosController));
router.get('/:id', authenticate, processosController.findById.bind(processosController));

// Atualização de status (Administrativo + Admin)
router.patch(
    '/:id/status-fluxo',
    authenticate,
    authorize([
        PerfilUsuario.ADMINISTRATIVO,
        PerfilUsuario.INTERMEDIACAO,
        PerfilUsuario.ADMIN,
    ]),
    processosController.updateStatusFluxo.bind(processosController)
);

// Atribuição de responsável (Administrativo + Admin)
router.patch(
    '/:id/responsavel',
    authenticate,
    authorize([
        PerfilUsuario.ADMINISTRATIVO,
        PerfilUsuario.ADMIN,
    ]),
    processosController.atribuirResponsavel.bind(processosController)
);

export default router;
