/**
 * Script para limpar cache e sessões do WhatsApp Web
 * 
 * Este script remove:
 * - .wwebjs_auth (sessões de autenticação)
 * - .wwebjs_cache (cache do WhatsApp Web)
 * - Qualquer outra pasta relacionada ao wwebjs
 * 
 * Uso: npm run whatsapp:limpar-cache
 */

import fs from 'fs';
import path from 'path';
import logger from '../utils/logger';

const backendDir = process.cwd();

const pastasParaLimpar = [
    '.wwebjs_auth',
    '.wwebjs_cache',
    'wwebjs_auth',
    'wwebjs_cache',
    'WebCache',
    'wwebjs_webcache'
];

function limparPasta(caminho: string): boolean {
    try {
        if (fs.existsSync(caminho)) {
            const stats = fs.statSync(caminho);
            if (stats.isDirectory()) {
                logger.info(`🗑️ Removendo diretório: ${caminho}`);
                fs.rmSync(caminho, { recursive: true, force: true });
                return true;
            }
        }
        return false;
    } catch (error: any) {
        logger.error(`❌ Erro ao remover ${caminho}: ${error.message}`);
        return false;
    }
}

function main() {
    logger.info('🧹 Iniciando limpeza de cache e sessões do WhatsApp Web...');
    logger.info(`📁 Diretório do backend: ${backendDir}`);

    let totalRemovido = 0;
    let totalTamanho = 0;

    for (const pasta of pastasParaLimpar) {
        const caminhoCompleto = path.join(backendDir, pasta);
        if (limparPasta(caminhoCompleto)) {
            totalRemovido++;
        }
    }

    // Também procurar por pastas user_* dentro de .wwebjs_auth (se ainda existir)
    const authPath = path.join(backendDir, '.wwebjs_auth');
    if (fs.existsSync(authPath)) {
        try {
            const items = fs.readdirSync(authPath);
            for (const item of items) {
                const itemPath = path.join(authPath, item);
                if (fs.statSync(itemPath).isDirectory() && item.startsWith('user_')) {
                    logger.info(`🗑️ Removendo sessão de usuário: ${item}`);
                    fs.rmSync(itemPath, { recursive: true, force: true });
                    totalRemovido++;
                }
            }
        } catch (error: any) {
            logger.warn(`⚠️ Erro ao limpar sessões de usuários: ${error.message}`);
        }
    }

    logger.info(`✅ Limpeza concluída! ${totalRemovido} pasta(s) removida(s)`);
    logger.info('');
    logger.info('📋 Próximos passos:');
    logger.info('1. Execute: npm install whatsapp-web.js@latest');
    logger.info('2. Reinicie o backend: npm run dev');
    logger.info('3. Teste novamente o WhatsApp na extensão');
}

main();

