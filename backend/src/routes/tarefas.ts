import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
import tarefasController from '../controllers/TarefasController';

const router = Router();

// Todas as rotas exigem autenticação
router.use(authenticate);

/**
 * GET /api/v1/tarefas
 * Listar tarefas do usuário logado (filtradas por perfil)
 */
router.get('/', tarefasController.listarMinhasTarefas.bind(tarefasController));

/**
 * GET /api/v1/tarefas/estatisticas
 * Obter estatísticas de tarefas
 */
router.get('/estatisticas', tarefasController.obterEstatisticas.bind(tarefasController));

/**
 * GET /api/v1/tarefas/:id
 * Obter detalhes de uma tarefa específica
 */
router.get('/:id', tarefasController.obterTarefa.bind(tarefasController));

/**
 * POST /api/v1/tarefas
 * Criar nova tarefa (Admin)
 */
router.post('/', tarefasController.criarTarefa.bind(tarefasController));

/**
 * PATCH /api/v1/tarefas/:id/iniciar
 * Iniciar trabalho em uma tarefa
 */
router.patch('/:id/iniciar', tarefasController.iniciarTarefa.bind(tarefasController));

/**
 * PATCH /api/v1/tarefas/:id/concluir
 * Marcar tarefa como concluída
 */
router.patch('/:id/concluir', tarefasController.concluirTarefa.bind(tarefasController));

export default router;
