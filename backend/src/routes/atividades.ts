import { Router } from 'express';
import { PerfilUsuario } from '@inss-manager/shared';
import atividadesController from '../controllers/AtividadesController';
import { authenticate, authorize } from '../middlewares/auth';

const router = Router();

/**
 * Rotas de Atividades (Perícia e Avaliação Social)
 * Prefixo: /api/v1
 * 
 * Todas as rotas requerem autenticação
 */

// Buscar atividades de um processo específico
router.get(
    '/processos/:processoId/atividades',
    authenticate,
    atividadesController.listarPorProcesso.bind(atividadesController)
);

// Buscar agendamento ativo de um processo
router.get(
    '/processos/:processoId/atividades/agendada',
    authenticate,
    atividadesController.buscarAgendamentoAtivo.bind(atividadesController)
);

// Criar nova atividade para um processo
router.post(
    '/processos/:processoId/atividades',
    authenticate,
    authorize([
        PerfilUsuario.ADMINISTRATIVO,
        PerfilUsuario.INTERMEDIACAO,
        PerfilUsuario.ADMIN,
    ]),
    atividadesController.criar.bind(atividadesController)
);

// Atualizar atividade existente
router.patch(
    '/atividades/:id',
    authenticate,
    authorize([
        PerfilUsuario.ADMINISTRATIVO,
        PerfilUsuario.INTERMEDIACAO,
        PerfilUsuario.ADMIN,
    ]),
    atividadesController.atualizar.bind(atividadesController)
);

// Deletar atividade
router.delete(
    '/atividades/:id',
    authenticate,
    authorize([
        PerfilUsuario.ADMINISTRATIVO,
        PerfilUsuario.ADMIN,
    ]),
    atividadesController.deletar.bind(atividadesController)
);

export default router;
