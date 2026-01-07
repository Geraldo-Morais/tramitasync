/**
 * Sistema de Logs de Auditoria
 * 
 * Registra ações importantes do sistema:
 * - Logins e autenticações
 * - Sincronizações INSS (início, status, conclusão)
 * - Erros suspeitos (possíveis invasões)
 * - Ações administrativas
 * - Configurações alteradas
 */

import fs from 'fs';
import path from 'path';
import logger from './logger';

interface AuditLogEntry {
    timestamp: string;
    level: 'info' | 'warn' | 'error' | 'security';
    category: 'auth' | 'sync' | 'config' | 'admin' | 'security' | 'whatsapp';
    userId?: string;
    userEmail?: string;
    action: string;
    details?: any;
    ip?: string;
    userAgent?: string;
}

class AuditLogger {
    private readonly logDir: string;
    private readonly logFile: string;
    private readonly maxFileSize = 10 * 1024 * 1024; // 10MB
    private readonly maxFiles = 5;

    constructor() {
        this.logDir = path.join(process.cwd(), 'logs', 'audit');
        this.logFile = path.join(this.logDir, 'audit.log');

        // Criar diretório se não existir
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
    }

    /**
     * Escrever log de auditoria
     */
    private writeLog(entry: AuditLogEntry): void {
        try {
            const logLine = JSON.stringify(entry) + '\n';

            // Verificar tamanho do arquivo
            if (fs.existsSync(this.logFile)) {
                const stats = fs.statSync(this.logFile);
                if (stats.size > this.maxFileSize) {
                    this.rotateLogs();
                }
            }

            // Escrever no arquivo
            fs.appendFileSync(this.logFile, logLine, 'utf-8');

            // Também logar no console com formatação especial
            const emoji = this.getEmojiForCategory(entry.category);
            const levelColor = this.getLevelColor(entry.level);

            logger.info(
                `${emoji} [AUDITORIA] ${entry.category.toUpperCase()} | ${entry.action} | ` +
                `${entry.userEmail || entry.userId || 'Sistema'} | ${entry.ip || 'N/A'}`
            );
        } catch (error) {
            logger.error('Erro ao escrever log de auditoria:', error);
        }
    }

    /**
     * Rotacionar logs antigos
     */
    private rotateLogs(): void {
        try {
            // Mover arquivo atual para .1
            for (let i = this.maxFiles - 1; i >= 1; i--) {
                const oldFile = `${this.logFile}.${i}`;
                const newFile = `${this.logFile}.${i + 1}`;

                if (fs.existsSync(oldFile)) {
                    if (i + 1 <= this.maxFiles) {
                        fs.renameSync(oldFile, newFile);
                    } else {
                        fs.unlinkSync(oldFile);
                    }
                }
            }

            // Mover arquivo atual
            if (fs.existsSync(this.logFile)) {
                fs.renameSync(this.logFile, `${this.logFile}.1`);
            }
        } catch (error) {
            logger.error('Erro ao rotacionar logs de auditoria:', error);
        }
    }

    /**
     * Obter emoji para categoria
     */
    private getEmojiForCategory(category: string): string {
        const emojis: Record<string, string> = {
            auth: '🔐',
            sync: '🔄',
            config: '⚙️',
            admin: '👤',
            security: '🚨',
            whatsapp: '📱'
        };
        return emojis[category] || '📝';
    }

    /**
     * Obter cor para nível
     */
    private getLevelColor(level: string): string {
        const colors: Record<string, string> = {
            info: '\x1b[32m', // verde
            warn: '\x1b[33m', // amarelo
            error: '\x1b[31m', // vermelho
            security: '\x1b[35m' // magenta
        };
        return colors[level] || '';
    }

    /**
     * Log de autenticação
     */
    logAuth(action: string, userId?: string, userEmail?: string, ip?: string, details?: any): void {
        this.writeLog({
            timestamp: new Date().toISOString(),
            level: 'info',
            category: 'auth',
            userId,
            userEmail,
            action,
            details,
            ip
        });
    }

    /**
     * Log de sincronização
     */
    logSync(action: string, userId?: string, userEmail?: string, details?: any): void {
        this.writeLog({
            timestamp: new Date().toISOString(),
            level: 'info',
            category: 'sync',
            userId,
            userEmail,
            action,
            details
        });
    }

    /**
     * Log de configuração
     */
    logConfig(action: string, userId?: string, userEmail?: string, details?: any): void {
        this.writeLog({
            timestamp: new Date().toISOString(),
            level: 'info',
            category: 'config',
            userId,
            userEmail,
            action,
            details
        });
    }

    /**
     * Log de segurança (erros suspeitos, tentativas de invasão)
     */
    logSecurity(action: string, userId?: string, userEmail?: string, ip?: string, details?: any): void {
        this.writeLog({
            timestamp: new Date().toISOString(),
            level: 'security',
            category: 'security',
            userId,
            userEmail,
            action,
            details,
            ip
        });
    }

    /**
     * Log de WhatsApp
     */
    logWhatsApp(action: string, userId?: string, userEmail?: string, details?: any): void {
        this.writeLog({
            timestamp: new Date().toISOString(),
            level: 'info',
            category: 'whatsapp',
            userId,
            userEmail,
            action,
            details
        });
    }

    /**
     * Log de ação administrativa
     */
    logAdmin(action: string, userId?: string, userEmail?: string, details?: any): void {
        this.writeLog({
            timestamp: new Date().toISOString(),
            level: 'info',
            category: 'admin',
            userId,
            userEmail,
            action,
            details
        });
    }

    /**
     * Ler logs de auditoria (últimas N linhas)
     */
    readLogs(limit: number = 100): AuditLogEntry[] {
        try {
            if (!fs.existsSync(this.logFile)) {
                return [];
            }

            const content = fs.readFileSync(this.logFile, 'utf-8');
            const lines = content.trim().split('\n').filter(line => line.trim());
            const entries = lines
                .slice(-limit)
                .map(line => {
                    try {
                        return JSON.parse(line) as AuditLogEntry;
                    } catch {
                        return null;
                    }
                })
                .filter(entry => entry !== null) as AuditLogEntry[];

            return entries.reverse(); // Mais recentes primeiro
        } catch (error) {
            logger.error('Erro ao ler logs de auditoria:', error);
            return [];
        }
    }
}

export default new AuditLogger();

