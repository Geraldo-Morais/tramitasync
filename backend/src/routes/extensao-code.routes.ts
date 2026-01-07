import { Router, Request, Response } from 'express';
import logger from '../utils/logger';
import config from '../config';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const router = Router();

/**
 * Função para ler arquivo da extensão
 */
function lerArquivoExtensao(nomeArquivo: string): string | null {
    try {
        const filePath = path.join(__dirname, '../../../extensao-chrome', nomeArquivo);
        if (fs.existsSync(filePath)) {
            return fs.readFileSync(filePath, 'utf-8');
        }
    } catch (error: any) {
        logger.error(`Erro ao ler arquivo ${nomeArquivo}: ${error.message}`);
    }
    return null;
}

/**
 * Função para calcular hash SHA-256
 */
function calcularHash(conteudo: string): string {
    return crypto.createHash('sha256').update(conteudo).digest('hex');
}

/**
 * Função para obter versão atual do manifest.json
 */
function obterVersaoAtual(): string {
    try {
        const manifestPath = path.join(__dirname, '../../../extensao-chrome/manifest.json');
        if (fs.existsSync(manifestPath)) {
            const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
            const manifest = JSON.parse(manifestContent);
            return manifest.version || '1.0.0';
        }
    } catch (error: any) {
        logger.warn(`Erro ao ler versão do manifest.json: ${error.message}`);
    }
    return '1.0.0';
}

/**
 * GET /api/v1/extensao/code/version
 * 
 * Retorna a versão atual do código e hash para validação
 */
router.get('/version', async (req: Request, res: Response) => {
    try {
        const version = obterVersaoAtual();

        // Calcular hash individual de cada arquivo
        // NOTA: O código servido inclui comentários de versão, mas o hash é calculado apenas do código original
        // para evitar problemas com timestamps dinâmicos
        const backgroundCode = lerArquivoExtensao('background.js') || '';
        const contentCode = lerArquivoExtensao('content-runtime.js') || '';

        // Hash do código original (sem comentários de versão)
        const hashBackground = backgroundCode ? calcularHash(backgroundCode) : null;
        const hashContent = contentCode ? calcularHash(contentCode) : null;

        // Hash combinado para compatibilidade (sem comentários)
        const combinedContent = backgroundCode + contentCode;
        const hash = combinedContent ? calcularHash(combinedContent) : null;

        res.json({
            success: true,
            version,
            hash, // Hash combinado (legado)
            hashBackground, // Hash do background.js (com comentários)
            hashContent, // Hash do content.js (com comentários)
            timestamp: Date.now()
        });
    } catch (error: any) {
        logger.error(`Erro ao obter versão do código: ${error.message}`);
        res.status(500).json({
            success: false,
            message: 'Erro ao obter versão do código',
            error: config.env === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /api/v1/extensao/code/background
 * 
 * Retorna o código do background.js
 */
router.get('/background', async (req: Request, res: Response) => {
    try {
        const clientVersion = req.query.version as string;
        const version = obterVersaoAtual();

        // Ler código do background.js
        let code = lerArquivoExtensao('background.js');

        if (!code) {
            return res.status(404).json({
                success: false,
                message: 'Código do background não encontrado'
            });
        }

        // Remover comentários de versão se existirem
        // Adicionar informação de versão no início do código
        const codeWithVersion = `// Versão: ${version}\n// Carregado em: ${new Date().toISOString()}\n${code}`;

        // Headers para cache
        res.set({
            'Content-Type': 'application/javascript',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
            'X-Extension-Version': version,
            'X-Content-Hash': calcularHash(code)
        });

        res.send(codeWithVersion);
    } catch (error: any) {
        logger.error(`Erro ao servir código do background: ${error.message}`);
        res.status(500).json({
            success: false,
            message: 'Erro ao servir código do background',
            error: config.env === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /api/v1/extensao/code/content
 * 
 * Retorna o código do content-runtime.js (código principal da extensão)
 */
router.get('/content', async (req: Request, res: Response) => {
    try {
        const clientVersion = req.query.version as string;
        const version = obterVersaoAtual();

        // Ler código do content-runtime.js (arquivo principal)
        let code = lerArquivoExtensao('content-runtime.js');

        if (!code) {
            return res.status(404).json({
                success: false,
                message: 'Código do content não encontrado'
            });
        }

        // Remover comentários de versão se existirem
        // Adicionar informação de versão no início do código
        const codeWithVersion = `// Versão: ${version}\n// Carregado em: ${new Date().toISOString()}\n${code}`;

        // Headers para cache
        res.set({
            'Content-Type': 'application/javascript',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
            'X-Extension-Version': version,
            'X-Content-Hash': calcularHash(code)
        });

        res.send(codeWithVersion);
    } catch (error: any) {
        logger.error(`Erro ao servir código do content: ${error.message}`);
        res.status(500).json({
            success: false,
            message: 'Erro ao servir código do content',
            error: config.env === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /api/v1/extensao/code/styles
 * 
 * Retorna o CSS da extensão
 */
router.get('/styles', async (req: Request, res: Response) => {
    try {
        const version = obterVersaoAtual();

        // Ler CSS
        let css = lerArquivoExtensao('styles.css');

        if (!css) {
            return res.status(404).json({
                success: false,
                message: 'CSS não encontrado'
            });
        }

        // Headers para cache
        res.set({
            'Content-Type': 'text/css',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
            'X-Extension-Version': version
        });

        res.send(css);
    } catch (error: any) {
        logger.error(`Erro ao servir CSS: ${error.message}`);
        res.status(500).json({
            success: false,
            message: 'Erro ao servir CSS',
            error: config.env === 'development' ? error.message : undefined
        });
    }
});

export default router;

