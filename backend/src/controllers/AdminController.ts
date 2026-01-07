import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { InssWorker } from '../workers/InssWorker';
import logger from '../utils/logger';
import database from '../database';

/**
 * Controller para funções administrativas
 * Gerenciamento de sistema (token, worker, status)
 */
class AdminController {
    /**
     * GET /api/v1/admin/status
     * Retorna status operacional do sistema
     */
    async getStatus(req: Request, res: Response): Promise<void> {
        try {
            const envPath = path.join(__dirname, '../../.env');
            const envContent = fs.readFileSync(envPath, 'utf-8');

            // Extrair configurações atuais
            const inssToken = this.extractEnvVar(envContent, 'INSS_ACCESS_TOKEN') || this.extractEnvVar(envContent, 'INSS_TOKEN');
            const geminiKey = this.extractEnvVar(envContent, 'GEMINI_API_KEY');
            const tramitacaoToken = this.extractEnvVar(envContent, 'TRAMITACAO_API_TOKEN');
            const cronSchedule = this.extractEnvVar(envContent, 'INSS_CRON_SCHEDULE');
            const headless = this.extractEnvVar(envContent, 'INSS_HEADLESS');

            // Verificar se token INSS está presente
            const hasInssToken = inssToken && inssToken.startsWith('AT-');

            // Calcular expiração aproximada (tokens INSS duram ~2h)
            let tokenStatus = 'DESCONHECIDO';
            if (!hasInssToken) {
                tokenStatus = 'AUSENTE';
            } else {
                // Verificar se há timestamp do último update
                const lastUpdate = this.getLastTokenUpdate();
                if (lastUpdate) {
                    const hoursSinceUpdate = (Date.now() - lastUpdate) / (1000 * 60 * 60);
                    if (hoursSinceUpdate < 2) {
                        tokenStatus = 'VÁLIDO';
                    } else {
                        tokenStatus = 'EXPIRADO';
                    }
                } else {
                    tokenStatus = 'VÁLIDO (assumido)';
                }
            }

            res.json({
                success: true,
                data: {
                    sistema: {
                        versao: '2.0',
                        ambiente: process.env.NODE_ENV || 'development',
                        uptime: process.uptime(),
                    },
                    inss: {
                        token_presente: hasInssToken,
                        token_status: tokenStatus,
                        token_preview: hasInssToken ? `${inssToken.substring(0, 10)}...` : 'N/A',
                        cron_schedule: cronSchedule || 'Não configurado',
                        modo_headless: headless === 'true',
                    },
                    apis: {
                        gemini_configurado: !!geminiKey,
                        tramitacao_configurado: !!tramitacaoToken,
                    },
                    ultima_atualizacao: new Date().toISOString(),
                },
            });
        } catch (error: any) {
            logger.error('Erro ao obter status do sistema:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao obter status do sistema',
                error: error.message,
            });
        }
    }

    /**
     * POST /api/v1/admin/token/renew
     * Atualiza token INSS no .env a partir da URL
     */
    async renewToken(req: Request, res: Response): Promise<void> {
        try {
            const { url } = req.body;

            if (!url) {
                res.status(400).json({
                    success: false,
                    message: 'URL do INSS é obrigatória',
                });
                return;
            }

            // Extrair token da URL
            const tokenMatch = url.match(/[#&]access_token=([^&]+)/);
            if (!tokenMatch) {
                res.status(400).json({
                    success: false,
                    message: 'URL inválida. Não foi possível extrair o token.',
                });
                return;
            }

            const token = tokenMatch[1];

            // Extrair expires_in
            let expiresIn = 7200; // Padrão 2 horas
            const expiresMatch = url.match(/[#&]expires_in=(\d+)/);
            if (expiresMatch) {
                expiresIn = parseInt(expiresMatch[1]);
            }

            // Validar se token não está expirado
            if (expiresIn < 300) {
                res.status(400).json({
                    success: false,
                    message: `Token expirado ou prestes a expirar! Tempo restante: ${Math.floor(expiresIn / 60)} minutos.`,
                });
                return;
            }

            // Atualizar .env
            const envPath = path.join(__dirname, '../../.env');
            let envContent = fs.readFileSync(envPath, 'utf-8');

            // Substituir INSS_TOKEN
            if (envContent.includes('INSS_TOKEN=')) {
                envContent = envContent.replace(/INSS_TOKEN=.*/g, `INSS_TOKEN=${token}`);
            } else {
                envContent += `\nINSS_TOKEN=${token}`;
            }

            fs.writeFileSync(envPath, envContent, 'utf-8');

            // Salvar timestamp do update
            this.saveTokenUpdateTimestamp();

            logger.info('Token INSS atualizado via painel admin');

            res.json({
                success: true,
                message: 'Token atualizado com sucesso',
                data: {
                    token_preview: `${token.substring(0, 10)}...`,
                    expires_in: expiresIn,
                    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
                },
            });
        } catch (error: any) {
            logger.error('Erro ao renovar token:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao renovar token',
                error: error.message,
            });
        }
    }

    /**
     * POST /api/v1/admin/worker/run
     * Executa worker INSS manualmente
     */
    async runWorker(req: Request, res: Response): Promise<void> {
        try {
            logger.info('Worker INSS iniciado via painel admin');

            // Executar worker de forma assíncrona
            const worker = new InssWorker();

            // Responder imediatamente e executar em background
            res.json({
                success: true,
                message: 'Worker iniciado com sucesso. Verifique os logs para acompanhar o progresso.',
                data: {
                    iniciado_em: new Date().toISOString(),
                },
            });

            // Executar em background
            worker.runManual().catch((error) => {
                logger.error('Erro ao executar worker:', error);
            });
        } catch (error: any) {
            logger.error('Erro ao iniciar worker:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao iniciar worker',
                error: error.message,
            });
        }
    }

    /**
     * GET /api/v1/admin/logs
     * Retorna últimas linhas dos logs
     */
    async getLogs(req: Request, res: Response): Promise<void> {
        try {
            const { type = 'all', lines = 50 } = req.query;

            const logPath = path.join(
                __dirname,
                '../../logs',
                type === 'error' ? 'error.log' : 'all.log'
            );

            if (!fs.existsSync(logPath)) {
                res.json({
                    success: true,
                    data: {
                        logs: [],
                        message: 'Arquivo de log não encontrado',
                    },
                });
                return;
            }

            const content = fs.readFileSync(logPath, 'utf-8');
            const allLines = content.split('\n').filter((line) => line.trim());
            const lastLines = allLines.slice(-Number(lines));

            res.json({
                success: true,
                data: {
                    logs: lastLines,
                    total: allLines.length,
                    showing: lastLines.length,
                },
            });
        } catch (error: any) {
            logger.error('Erro ao obter logs:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao obter logs',
                error: error.message,
            });
        }
    }

    // Métodos auxiliares privados

    private extractEnvVar(envContent: string, varName: string): string | null {
        const regex = new RegExp(`${varName}=(.*)`, 'i');
        const match = envContent.match(regex);
        return match ? match[1].trim() : null;
    }

    private getLastTokenUpdate(): number | null {
        const timestampPath = path.join(__dirname, '../../.token-timestamp');
        if (fs.existsSync(timestampPath)) {
            const content = fs.readFileSync(timestampPath, 'utf-8');
            return parseInt(content);
        }
        return null;
    }

    private saveTokenUpdateTimestamp(): void {
        const timestampPath = path.join(__dirname, '../../.token-timestamp');
        fs.writeFileSync(timestampPath, Date.now().toString(), 'utf-8');
    }

    /**
     * GET /api/v1/admin/usuarios
     * Lista todos os usuários do sistema
     */
    async getUsuarios(req: Request, res: Response): Promise<void> {
        try {
            const { rows } = await database.getPool().query(
                `SELECT id, nome, email, perfil, ativo, created_at 
                 FROM usuarios 
                 ORDER BY created_at DESC`
            );

            res.json({
                success: true,
                data: rows,
            });
        } catch (error: any) {
            logger.error('Erro ao listar usuários:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao listar usuários',
                error: error.message,
            });
        }
    }

    /**
     * POST /api/v1/admin/usuarios
     * Cria novo usuário
     */
    async createUsuario(req: Request, res: Response): Promise<void> {
        try {
            const { nome, email, senha, perfil } = req.body;

            if (!nome || !email || !senha || !perfil) {
                res.status(400).json({
                    success: false,
                    message: 'Nome, email, senha e perfil são obrigatórios',
                });
                return;
            }

            const bcrypt = require('bcryptjs');
            const senhaHash = await bcrypt.hash(senha, 10);

            const { rows } = await database.getPool().query(
                `INSERT INTO usuarios (nome, email, senha, perfil, ativo) 
                 VALUES ($1, $2, $3, $4, true) 
                 RETURNING id, nome, email, perfil, ativo, created_at`,
                [nome, email, senhaHash, perfil]
            );

            res.status(201).json({
                success: true,
                message: 'Usuário criado com sucesso',
                data: rows[0],
            });
        } catch (error: any) {
            logger.error('Erro ao criar usuário:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao criar usuário',
                error: error.message,
            });
        }
    }

    /**
     * PATCH /api/v1/admin/usuarios/:id
     * Atualiza dados do usuário
     */
    async updateUsuario(req: Request, res: Response): Promise<void> {
        try {
            const { id } = req.params;
            const { nome, email, perfil, ativo, senha } = req.body;

            let query = 'UPDATE usuarios SET ';
            const values: any[] = [];
            let paramCount = 1;

            if (nome) {
                query += `nome = $${paramCount++}, `;
                values.push(nome);
            }
            if (email) {
                query += `email = $${paramCount++}, `;
                values.push(email);
            }
            if (perfil) {
                query += `perfil = $${paramCount++}, `;
                values.push(perfil);
            }
            if (typeof ativo !== 'undefined') {
                query += `ativo = $${paramCount++}, `;
                values.push(ativo);
            }
            if (senha) {
                const bcrypt = require('bcryptjs');
                const senhaHash = await bcrypt.hash(senha, 10);
                query += `senha = $${paramCount++}, `;
                values.push(senhaHash);
            }

            query += `updated_at = NOW() WHERE id = $${paramCount} RETURNING id, nome, email, perfil, ativo`;
            values.push(id);

            const { rows } = await database.getPool().query(query, values);

            if (rows.length === 0) {
                res.status(404).json({
                    success: false,
                    message: 'Usuário não encontrado',
                });
                return;
            }

            res.json({
                success: true,
                message: 'Usuário atualizado com sucesso',
                data: rows[0],
            });
        } catch (error: any) {
            logger.error('Erro ao atualizar usuário:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao atualizar usuário',
                error: error.message,
            });
        }
    }

    /**
     * DELETE /api/v1/admin/usuarios/:id
     * Remove usuário do sistema
     */
    async deleteUsuario(req: Request, res: Response): Promise<void> {
        try {
            const { id } = req.params;

            const { rowCount } = await database.getPool().query(
                'DELETE FROM usuarios WHERE id = $1',
                [id]
            );

            if (rowCount === 0) {
                res.status(404).json({
                    success: false,
                    message: 'Usuário não encontrado',
                });
                return;
            }

            res.json({
                success: true,
                message: 'Usuário removido com sucesso',
            });
        } catch (error: any) {
            logger.error('Erro ao deletar usuário:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao deletar usuário',
                error: error.message,
            });
        }
    }
}

export default new AdminController();
