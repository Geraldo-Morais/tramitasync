import { Router, Request, Response } from 'express';
import logger from '../utils/logger';
import config from '../config';
import fs from 'fs';
import path from 'path';

const router = Router();

/**
 * GET /api/v1/extensao/update/check
 * 
 * Verifica se há atualização disponível para a extensão
 * Retorna versão atual e URL de download se houver atualização
 */
router.get('/check', async (req: Request, res: Response) => {
    try {
        const clientVersion = req.query.version as string || '1.0.0';

        // Versão atual da extensão (deve ser atualizada manualmente quando houver nova versão)
        const currentVersion = '1.0.4';

        // Comparar versões (formato: X.Y.Z)
        const compareVersions = (v1: string, v2: string): number => {
            const parts1 = v1.split('.').map(Number);
            const parts2 = v2.split('.').map(Number);

            for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
                const part1 = parts1[i] || 0;
                const part2 = parts2[i] || 0;

                if (part1 > part2) return 1;
                if (part1 < part2) return -1;
            }
            return 0;
        };

        const hasUpdate = compareVersions(currentVersion, clientVersion) > 0;

        if (!hasUpdate) {
            return res.json({
                success: true,
                hasUpdate: false,
                currentVersion,
                clientVersion,
                message: 'Extensão está atualizada'
            });
        }

        // Se há atualização, retornar URL de download
        // A URL será construída baseada na URL pública do backend (ngrok)
        let downloadUrl = null;

        // Tentar obter URL pública do ngrok
        const ngrokService = (await import('../services/NgrokTunnelService')).default;
        let publicUrl = ngrokService.getPublicUrl();

        // Fallback para variável de ambiente ou host
        if (!publicUrl) {
            publicUrl = process.env.PUBLIC_URL ||
                (req.headers.host ? (req.protocol === 'https' ? 'https' : 'http') + `://${req.headers.host}` : null);
        }

        if (publicUrl) {
            // Remover /api/v1 se estiver presente
            const baseUrl = publicUrl.replace(/\/api\/v1$/, '');
            // URL para baixar a extensão atualizada
            downloadUrl = `${baseUrl}/api/v1/extensao/update/download`;
        }

        res.json({
            success: true,
            hasUpdate: true,
            currentVersion,
            clientVersion,
            downloadUrl,
            changelog: 'Atualizações e melhorias gerais',
            message: `Nova versão disponível: ${currentVersion}`
        });
    } catch (error: any) {
        logger.error(`Erro ao verificar atualização: ${error.message}`);
        res.status(500).json({
            success: false,
            message: 'Erro ao verificar atualização',
            error: config.env === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /api/v1/extensao/update/download
 * 
 * Retorna o arquivo ZIP da extensão atualizada
 */
router.get('/download', async (req: Request, res: Response) => {
    try {
        // Caminho para a pasta da extensão
        const extensaoPath = path.join(__dirname, '../../../extensao-chrome');

        // Verificar se a pasta existe
        if (!fs.existsSync(extensaoPath)) {
            return res.status(404).json({
                success: false,
                message: 'Extensão não encontrada no servidor'
            });
        }

        // Criar ZIP da extensão
        const archiver = require('archiver');
        const archive = archiver('zip', { zlib: { level: 9 } });

        res.attachment('tramitacao-extensao.zip');
        res.type('application/zip');

        archive.pipe(res);

        // Adicionar arquivos da extensão ao ZIP
        const files = [
            'manifest.json',
            'content.js',
            'background.js',
            'styles.css'
        ];

        for (const file of files) {
            const filePath = path.join(extensaoPath, file);
            if (fs.existsSync(filePath)) {
                archive.file(filePath, { name: file });
            }
        }

        archive.finalize();

        logger.info('📦 Download de extensão iniciado');
    } catch (error: any) {
        logger.error(`Erro ao fazer download da extensão: ${error.message}`);
        res.status(500).json({
            success: false,
            message: 'Erro ao fazer download da extensão',
            error: config.env === 'development' ? error.message : undefined
        });
    }
});

export default router;

