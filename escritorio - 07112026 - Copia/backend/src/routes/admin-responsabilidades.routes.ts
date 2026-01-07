import { Router, Response, NextFunction } from 'express';
import { authenticate, AuthRequest } from '../middlewares/auth';
import ResponsabilidadesService from '../services/ResponsabilidadesService';

const router = Router();

const requireAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
    if (req.user?.perfil !== 'admin') {
        return res.status(403).json({
            success: false,
            error: 'Acesso negado. Requer perfil admin.'
        });
    }
    next();
};

router.use(authenticate);
router.use(requireAdmin);

router.get('/beneficios', async (_req: AuthRequest, res: Response) => {
    try {
        const beneficios = await ResponsabilidadesService.listarBeneficios();

        res.json({
            success: true,
            data: beneficios
        });
    } catch (error) {
        console.error('Erro ao listar benefícios:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao listar benefícios'
        });
    }
});

router.get('/usuarios/:id/responsabilidades', async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;

        const responsabilidades = await ResponsabilidadesService.obterResponsabilidades(id);

        res.json({
            success: true,
            data: responsabilidades
        });
    } catch (error) {
        console.error('Erro ao obter responsabilidades:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao obter responsabilidades do usuário'
        });
    }
});

router.put('/usuarios/:id/responsabilidades', async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const config = req.body;

        if (typeof config.pode_administrativo !== 'boolean' ||
            typeof config.pode_judicial !== 'boolean' ||
            typeof config.responsavel_exigencia !== 'boolean' ||
            !Array.isArray(config.beneficios)) {
            return res.status(400).json({
                success: false,
                error: 'Formato inválido'
            });
        }

        await ResponsabilidadesService.configurarResponsabilidades(id, config);

        res.json({
            success: true,
            message: 'Responsabilidades configuradas com sucesso'
        });
    } catch (error) {
        console.error('Erro ao configurar responsabilidades:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao configurar responsabilidades'
        });
    }
});

router.post('/usuarios/:fromId/transferir', async (req: AuthRequest, res: Response) => {
    try {
        const { fromId } = req.params;
        const { paraUsuarioId, tipos } = req.body;

        if (!paraUsuarioId || !Array.isArray(tipos) || tipos.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Requer: paraUsuarioId, tipos (array)'
            });
        }

        const tiposValidos = ['EXIGENCIA', 'ADMINISTRATIVO', 'JUDICIAL'];
        const tiposInvalidos = tipos.filter((t: string) => !tiposValidos.includes(t));
        if (tiposInvalidos.length > 0) {
            return res.status(400).json({
                success: false,
                error: `Tipos inválidos: ${tiposInvalidos.join(', ')}`
            });
        }

        const resultado = await ResponsabilidadesService.transferirResponsabilidades({
            deUsuarioId: fromId,
            paraUsuarioId,
            tipos,
            realizadoPorId: req.user!.id
        });

        res.json({
            success: true,
            message: 'Responsabilidades transferidas com sucesso',
            data: resultado
        });
    } catch (error) {
        console.error('Erro ao transferir responsabilidades:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao transferir responsabilidades'
        });
    }
});

router.get('/historico', async (req: AuthRequest, res: Response) => {
    try {
        const limite = parseInt(req.query.limite as string) || 50;

        const historico = await ResponsabilidadesService.listarHistoricoTransferencias(limite);

        res.json({
            success: true,
            data: historico
        });
    } catch (error) {
        console.error('Erro ao buscar histórico:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar histórico de transferências'
        });
    }
});

export default router;
