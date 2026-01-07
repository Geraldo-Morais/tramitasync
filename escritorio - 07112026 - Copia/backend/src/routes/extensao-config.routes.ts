import { Router, Request, Response } from 'express';
import logger from '../utils/logger';
import config from '../config';
import fs from 'fs';
import path from 'path';

const router = Router();

/**
 * GET /api/v1/extensao/public-config
 * 
 * Retorna configuração dinâmica da extensão (JSON) - ROTA PÚBLICA
 * Esta config pode ser atualizada no servidor sem precisar atualizar a extensão
 * Não requer autenticação (diferente de /extensao/config que é para config do usuário)
 */
router.get('/public-config', async (req: Request, res: Response) => {
    try {
        // Ler config do arquivo (ou banco de dados no futuro)
        const configPath = path.join(__dirname, '../../../extensao-chrome/config.json');

        let extensaoConfig: any = {
            version: 1,
            timestamp: Date.now(),
            flows: [],
            ui: {},
            rules: {},
            endpoints: {}
        };

        // Se arquivo existe, ler
        if (fs.existsSync(configPath)) {
            try {
                const fileContent = fs.readFileSync(configPath, 'utf-8');
                extensaoConfig = JSON.parse(fileContent);
            } catch (error: any) {
                logger.warn(`Erro ao ler config.json: ${error.message}`);
            }
        }

        // Headers para cache
        res.set({
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
            'X-Config-Version': extensaoConfig.version.toString()
        });

        res.json({
            success: true,
            ...extensaoConfig
        });
    } catch (error: any) {
        logger.error(`Erro ao obter config da extensão: ${error.message}`);
        res.status(500).json({
            success: false,
            message: 'Erro ao obter configuração',
            error: config.env === 'development' ? error.message : undefined
        });
    }
});

export default router;

