import { Router } from 'express';
import authRoutes from './auth';
import processosRoutes from './processos';
import adminRoutes from './admin';
import tarefasRoutes from './tarefas';
import automacaoRoutes from './automacao.routes';
import atividadesRoutes from './atividades';
import captchaRoutes from './captcha';
import notificacoesRoutes from './notificacoes.routes';
import exigenciasRoutes from './exigencias.routes';
import parceirosRoutes from './parceiros.routes';
import cidadesRoutes from './cidades.routes';
import inssSincronizacaoRoutes from './inss-sincronizacao.routes';
import extensaoAuthRoutes from './extensao-auth.routes';
import extensaoUpdateRoutes from './extensao-update.routes';
import extensaoCodeRoutes from './extensao-code.routes';
import extensaoConfigRoutes from './extensao-config.routes';
import systemRoutes from './system.routes';

const router = Router();

/**
 * Rotas principais da API
 * Prefixo: /api/v1
 */

// Rotas de autenticação da extensão (DEVE VIR ANTES de extensaoConfigRoutes)
router.use('/extensao', extensaoAuthRoutes);
// Rotas de atualização da extensão
router.use('/extensao/update', extensaoUpdateRoutes);
// Rotas de código dinâmico da extensão
router.use('/extensao/code', extensaoCodeRoutes);
// Rotas de configuração dinâmica da extensão (JSON) - DEVE VIR DEPOIS para não interceptar outras rotas
router.use('/extensao', extensaoConfigRoutes);

// Rotas de sincronização INSS
router.use('/inss', inssSincronizacaoRoutes);

// Rotas do sistema (health, public-url)
router.use('/system', systemRoutes);

// Health check geral (compat)
router.get('/health', (req, res) => {
    res.json({
        success: true,
        status: 'healthy',
        timestamp: new Date().toISOString()
    });
});

// Rotas de autenticação
router.use('/auth', authRoutes);

// Rotas de processos
router.use('/processos', processosRoutes);

// Rotas de tarefas
router.use('/tarefas', tarefasRoutes);

// Rotas administrativas (apenas admin)
router.use('/admin', adminRoutes);

// Rotas de automação INSS (SSE para logs em tempo real)
router.use('/automacao', automacaoRoutes);

// Rotas de atividades (perícia e avaliação social)
router.use('/', atividadesRoutes);

// Rotas de CAPTCHA (resolução manual/OCR)
router.use('/captcha', captchaRoutes);

// Rotas de notificações WhatsApp e parceiros
router.use('/notificacoes', notificacoesRoutes);

// Rotas de exigências (novo sistema completo)
router.use('/exigencias', exigenciasRoutes);

// Rotas de parceiros por cidade
router.use('/parceiros', parceirosRoutes);

// Rotas de cidades
router.use('/cidades', cidadesRoutes);

// Rotas de sincronização INSS
router.use('/inss', inssSincronizacaoRoutes);

export default router;
