/**
 * Rotas da API de Parceiros (SaaS)
 * 
 * Endpoints CRUD para gerenciamento de parceiros por usuário.
 */

import { Router, Request, Response } from 'express';
import parceirosService from '../services/ParceirosService';
import { ExtensaoAuthController } from '../controllers/ExtensaoAuthController';
import logger from '../utils/logger';

const router = Router();
const authController = new ExtensaoAuthController();

// Middleware de autenticação
const autenticar = async (req: Request, res: Response, next: Function) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, message: 'Token não fornecido' });
        }

        const token = authHeader.substring(7);
        const resultado = await authController.verificarToken(token);

        if (!resultado.valid || !resultado.userId) {
            return res.status(401).json({ success: false, message: 'Token inválido' });
        }

        // Anexar userId ao request
        (req as any).userId = resultado.userId;
        next();
    } catch (error: any) {
        logger.error(`[Parceiros] Erro de autenticação: ${error.message}`);
        res.status(401).json({ success: false, message: 'Erro de autenticação' });
    }
};

/**
 * GET /api/v1/parceiros
 * Lista todos os parceiros do usuário
 */
router.get('/', autenticar, async (req: Request, res: Response) => {
    try {
        const userId = (req as any).userId;
        const parceiros = await parceirosService.listarParceiros(userId);

        res.json({
            success: true,
            parceiros,
            total: parceiros.length
        });
    } catch (error: any) {
        logger.error(`[Parceiros] Erro ao listar: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /api/v1/parceiros/:id
 * Busca um parceiro específico
 */
router.get('/:id', autenticar, async (req: Request, res: Response) => {
    try {
        const userId = (req as any).userId;
        const id = parseInt(req.params.id);

        if (isNaN(id)) {
            return res.status(400).json({ success: false, message: 'ID inválido' });
        }

        const parceiro = await parceirosService.buscarPorId(userId, id);

        if (!parceiro) {
            return res.status(404).json({ success: false, message: 'Parceiro não encontrado' });
        }

        res.json({ success: true, parceiro });
    } catch (error: any) {
        logger.error(`[Parceiros] Erro ao buscar: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * POST /api/v1/parceiros
 * Cria um novo parceiro
 */
router.post('/', autenticar, async (req: Request, res: Response) => {
    try {
        const userId = (req as any).userId;
        const {
            nomeEtiqueta,
            nomeCompleto,
            telefone,
            email,
            notificarExigencia,
            notificarDeferido,
            notificarIndeferido,
            notificarAgendamento,
            notificarEmAnalise,
            ativo,
            incluirLinkProcesso,
            incluirComprovantes,
            incluirAnaliseIA,
            observacoes
        } = req.body;

        // Validações básicas
        if (!nomeEtiqueta || !telefone) {
            return res.status(400).json({
                success: false,
                message: 'Nome da etiqueta e telefone são obrigatórios'
            });
        }

        const parceiro = await parceirosService.criarParceiro({
            userId,
            nomeEtiqueta,
            nomeCompleto,
            telefone,
            email,
            notificarExigencia: notificarExigencia ?? true,
            notificarDeferido: notificarDeferido ?? true,
            notificarIndeferido: notificarIndeferido ?? true,
            notificarAgendamento: notificarAgendamento ?? true,
            notificarEmAnalise: notificarEmAnalise ?? false,
            ativo: ativo ?? true,
            incluirLinkProcesso: incluirLinkProcesso ?? false,
            incluirComprovantes: incluirComprovantes ?? true,
            incluirAnaliseIA: incluirAnaliseIA ?? true,
            observacoes
        });

        res.status(201).json({
            success: true,
            message: 'Parceiro criado com sucesso',
            parceiro,
            etiquetaTramitacao: `PARCEIRO:${parceiro.nomeEtiqueta}`
        });
    } catch (error: any) {
        logger.error(`[Parceiros] Erro ao criar: ${error.message}`);

        // Erro de constraint unique
        if (error.message.includes('unique') || error.message.includes('duplicate')) {
            return res.status(409).json({
                success: false,
                message: 'Já existe um parceiro com este nome de etiqueta'
            });
        }

        res.status(400).json({ success: false, message: error.message });
    }
});

/**
 * PUT /api/v1/parceiros/:id
 * Atualiza um parceiro existente
 */
router.put('/:id', autenticar, async (req: Request, res: Response) => {
    try {
        const userId = (req as any).userId;
        const id = parseInt(req.params.id);

        if (isNaN(id)) {
            return res.status(400).json({ success: false, message: 'ID inválido' });
        }

        const parceiro = await parceirosService.atualizarParceiro(userId, id, req.body);

        if (!parceiro) {
            return res.status(404).json({ success: false, message: 'Parceiro não encontrado' });
        }

        res.json({
            success: true,
            message: 'Parceiro atualizado com sucesso',
            parceiro
        });
    } catch (error: any) {
        logger.error(`[Parceiros] Erro ao atualizar: ${error.message}`);
        res.status(400).json({ success: false, message: error.message });
    }
});

/**
 * DELETE /api/v1/parceiros/:id
 * Exclui um parceiro
 */
router.delete('/:id', autenticar, async (req: Request, res: Response) => {
    try {
        const userId = (req as any).userId;
        const id = parseInt(req.params.id);

        if (isNaN(id)) {
            return res.status(400).json({ success: false, message: 'ID inválido' });
        }

        // Verificar se existe
        const existente = await parceirosService.buscarPorId(userId, id);
        if (!existente) {
            return res.status(404).json({ success: false, message: 'Parceiro não encontrado' });
        }

        await parceirosService.excluirParceiro(userId, id);

        res.json({
            success: true,
            message: 'Parceiro excluído com sucesso'
        });
    } catch (error: any) {
        logger.error(`[Parceiros] Erro ao excluir: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * POST /api/v1/parceiros/validar-etiqueta
 * Valida se uma etiqueta está no formato correto
 */
router.post('/validar-etiqueta', autenticar, async (req: Request, res: Response) => {
    try {
        const { nomeEtiqueta } = req.body;

        if (!nomeEtiqueta) {
            return res.status(400).json({ success: false, message: 'Nome da etiqueta é obrigatório' });
        }

        const normalizado = nomeEtiqueta.toUpperCase().trim().replace(/\s+/g, '_');
        const valido = /^[A-Z0-9_]+$/.test(normalizado) && normalizado.length >= 2 && normalizado.length <= 100;

        res.json({
            success: true,
            valido,
            nomeNormalizado: normalizado,
            etiquetaCompleta: `PARCEIRO:${normalizado}`,
            mensagem: valido
                ? `Use a etiqueta PARCEIRO:${normalizado} no Tramitação`
                : 'Nome inválido. Use apenas letras, números e underscore (mín 2, máx 100 caracteres)'
        });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

export default router;
