import Database from '../database';
import logger from '../utils/logger';
import auditLogger from '../utils/auditLogger';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import config from '../config';

interface UsuarioExtensao {
    id: string;
    email: string;
    nome: string;
    geminiApiKey?: string;
    tramitacaoApiToken?: string;
    tramitacaoEmail?: string;
    tramitacaoSenha?: string;
    patToken?: string;
    patTokenTimestamp?: Date;
    licencaValidaAte?: Date;
    // Configurações de WhatsApp
    whatsappPersonalizadoAtivo?: boolean;
    whatsappNumeroUnico?: string;
    whatsappExigencia?: string;
    whatsappDeferido?: string;
    whatsappIndeferido?: string;
    whatsappEmAnalise?: string;
    whatsappAgendamento?: string;
    criadoEm: Date;
    atualizadoEm: Date;
}

export interface WhatsAppConfig {
    ativo: boolean;
    numeroUnico?: string;
    exigencia?: string;
    deferido?: string;
    indeferido?: string;
    emAnalise?: string;
    agendamento?: string;
}

/**
 * Controller de Autenticação para Extensão
 * Gerencia login, registro e configurações de usuários da extensão
 */
export class ExtensaoAuthController {
    /**
     * Verifica se um token JWT é válido e retorna o userId
     */
    async verificarToken(token: string): Promise<{ valid: boolean; userId?: string; email?: string }> {
        try {
            const decoded = jwt.verify(token, config.jwt.secret) as any;
            if (decoded.tipo !== 'extensao' || !decoded.userId) {
                return { valid: false };
            }
            return { valid: true, userId: decoded.userId, email: decoded.email };
        } catch {
            return { valid: false };
        }
    }

    /**
     * Registra um novo usuário da extensão
     */
    async registrar(email: string, password: string, nome: string): Promise<{
        success: boolean;
        message?: string;
        user?: any;
    }> {
        try {
            // Verificar se email já existe
            const usuarioExistente = await Database.query(
                'SELECT id FROM usuarios_extensao WHERE email = $1',
                [email.toLowerCase()]
            );

            if (usuarioExistente.length > 0) {
                return {
                    success: false,
                    message: 'Email já cadastrado'
                };
            }

            // Hash da senha
            const senhaHash = await bcrypt.hash(password, 10);

            // Calcular data de expiração da licença (lifetime = 100 anos)
            const licencaValidaAte = new Date();
            licencaValidaAte.setFullYear(licencaValidaAte.getFullYear() + 100);

            // Criar usuário
            const resultado = await Database.query(
                `INSERT INTO usuarios_extensao 
                (email, nome, senha_hash, licenca_valida_ate, criado_em, atualizado_em)
                VALUES ($1, $2, $3, $4, NOW(), NOW())
                RETURNING id, email, nome, licenca_valida_ate, criado_em`,
                [email.toLowerCase(), nome, senhaHash, licencaValidaAte]
            );

            const usuario = resultado[0];

            // Registro silencioso

            // Log de auditoria
            auditLogger.logAuth('Registro de novo usuário', usuario.id, usuario.email);

            return {
                success: true,
                user: {
                    id: usuario.id,
                    email: usuario.email,
                    nome: usuario.nome,
                    licencaValidaAte: usuario.licenca_valida_ate
                }
            };
        } catch (error: any) {
            logger.error(`❌ Erro ao registrar usuário da extensão: ${error.message}`, error);
            return {
                success: false,
                message: 'Erro ao registrar usuário'
            };
        }
    }

    /**
     * Autentica um usuário da extensão
     */
    async login(email: string, password: string): Promise<{
        success: boolean;
        message?: string;
        token?: string;
        user?: any;
    }> {
        try {
            // Buscar usuário
            const resultado = await Database.query(
                `SELECT id, email, nome, senha_hash, licenca_valida_ate, 
                        gemini_api_key, tramitacao_api_token, tramitacao_email, tramitacao_senha,
                        pat_token, pat_token_timestamp
                FROM usuarios_extensao 
                WHERE email = $1`,
                [email.toLowerCase()]
            );

            if (resultado.length === 0) {
                return {
                    success: false,
                    message: 'Email ou senha incorretos'
                };
            }

            const usuario = resultado[0];

            // Verificar senha
            const senhaValida = await bcrypt.compare(password, usuario.senha_hash);
            if (!senhaValida) {
                return {
                    success: false,
                    message: 'Email ou senha incorretos'
                };
            }

            // Verificar licença
            const licencaValidaAte = new Date(usuario.licenca_valida_ate);
            const agora = new Date();
            if (agora > licencaValidaAte) {
                return {
                    success: false,
                    message: 'Licença expirada. Entre em contato com o suporte.'
                };
            }

            // Gerar token JWT
            const token = jwt.sign(
                {
                    userId: usuario.id,
                    email: usuario.email,
                    tipo: 'extensao'
                },
                config.jwt.secret,
                { expiresIn: '30d' } // Token válido por 30 dias
            );

            // Login silencioso

            // Log de auditoria
            auditLogger.logAuth('Login realizado', usuario.id, usuario.email);

            return {
                success: true,
                token,
                user: {
                    id: usuario.id,
                    email: usuario.email,
                    nome: usuario.nome,
                    licencaValidaAte: usuario.licenca_valida_ate,
                    temGeminiApiKey: !!usuario.gemini_api_key,
                    temTramitacaoApiToken: !!usuario.tramitacao_api_token,
                    temPatToken: !!usuario.pat_token
                }
            };
        } catch (error: any) {
            logger.error(`❌ Erro ao fazer login: ${error.message}`, error);
            return {
                success: false,
                message: 'Erro ao fazer login'
            };
        }
    }

    /**
     * Obtém configurações do usuário autenticado
     */
    async obterConfig(token: string): Promise<{
        success: boolean;
        message?: string;
        config?: any;
    }> {
        try {
            // Verificar token
            const decoded = jwt.verify(token, config.jwt.secret) as any;
            if (decoded.tipo !== 'extensao') {
                return {
                    success: false,
                    message: 'Token inválido'
                };
            }

            // Buscar configurações
            const resultado = await Database.query(
                `SELECT gemini_api_key, tramitacao_api_token, tramitacao_email, tramitacao_senha,
                        pat_token, pat_token_timestamp, licenca_valida_ate
                FROM usuarios_extensao 
                WHERE id = $1`,
                [decoded.userId]
            );

            if (resultado.length === 0) {
                return {
                    success: false,
                    message: 'Usuário não encontrado'
                };
            }

            const configs = resultado[0];

            // ⚠️ SEGURANÇA: NUNCA retornar dados sensíveis para o client-side
            // Retornar apenas flags booleanos indicando se está configurado
            return {
                success: true,
                config: {
                    // Apenas flags booleanos - NUNCA os valores reais
                    temGeminiApiKey: !!configs.gemini_api_key,
                    temTramitacaoApiToken: !!configs.tramitacao_api_token,
                    temTramitacaoEmail: !!configs.tramitacao_email,
                    temTramitacaoSenha: !!configs.tramitacao_senha,
                    temPatToken: !!configs.pat_token,
                    patTokenTimestamp: configs.pat_token_timestamp || null, // Timestamp é seguro
                    licencaValidaAte: configs.licenca_valida_ate
                }
            };
        } catch (error: any) {
            if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
                return {
                    success: false,
                    message: 'Token inválido ou expirado'
                };
            }
            logger.error(`❌ Erro ao obter configurações: ${error.message}`, error);
            return {
                success: false,
                message: 'Erro ao obter configurações'
            };
        }
    }

    /**
     * Atualiza configurações do usuário autenticado
     */
    async atualizarConfig(token: string, configs: {
        geminiApiKey?: string;
        tramitacaoApiToken?: string;
        tramitacaoEmail?: string;
        tramitacaoSenha?: string;
        patToken?: string;
    }): Promise<{
        success: boolean;
        message?: string;
        config?: any;
    }> {
        try {
            // Verificar token
            const decoded = jwt.verify(token, config.jwt.secret) as any;
            if (decoded.tipo !== 'extensao') {
                return {
                    success: false,
                    message: 'Token inválido'
                };
            }

            // ⚠️ SEGURANÇA: Validação no backend (não no client-side)
            // Token do Tramitação é obrigatório para sincronização funcionar
            if (configs.tramitacaoApiToken !== undefined && !configs.tramitacaoApiToken?.trim()) {
                return {
                    success: false,
                    message: 'Token do Tramitação é obrigatório para sincronização'
                };
            }

            // Montar query de atualização dinâmica
            const updates: string[] = [];
            const values: any[] = [];
            let paramIndex = 1;

            if (configs.geminiApiKey !== undefined) {
                updates.push(`gemini_api_key = $${paramIndex++}`);
                values.push(configs.geminiApiKey || null);
            }

            if (configs.tramitacaoApiToken !== undefined) {
                updates.push(`tramitacao_api_token = $${paramIndex++}`);
                values.push(configs.tramitacaoApiToken || null);
            }

            if (configs.tramitacaoEmail !== undefined) {
                updates.push(`tramitacao_email = $${paramIndex++}`);
                values.push(configs.tramitacaoEmail || null);
            }

            if (configs.tramitacaoSenha !== undefined) {
                updates.push(`tramitacao_senha = $${paramIndex++}`);
                values.push(configs.tramitacaoSenha || null);
            }

            if (configs.patToken !== undefined) {
                updates.push(`pat_token = $${paramIndex++}`);
                updates.push(`pat_token_timestamp = NOW()`);
                values.push(configs.patToken || null);
            }

            if (updates.length === 0) {
                return {
                    success: false,
                    message: 'Nenhuma configuração fornecida'
                };
            }

            updates.push(`atualizado_em = NOW()`);
            values.push(decoded.userId);

            const query = `
                UPDATE usuarios_extensao 
                SET ${updates.join(', ')}
                WHERE id = $${paramIndex}
                RETURNING gemini_api_key, tramitacao_api_token, tramitacao_email, tramitacao_senha,
                          pat_token, pat_token_timestamp
            `;

            const resultado = await Database.query(query, values);

            // Configurações atualizadas silenciosamente

            // Log de auditoria
            const camposAtualizados = Object.keys(configs).filter(key => configs[key as keyof typeof configs] !== undefined);
            auditLogger.logConfig('Configurações atualizadas', decoded.userId, decoded.email, {
                camposAtualizados
            });

            const configAtualizado = resultado[0];

            // ⚠️ SEGURANÇA: NUNCA retornar dados sensíveis para o client-side
            // Retornar apenas flags booleanos indicando se foi atualizado
            return {
                success: true
                // Não retornar config com valores sensíveis
            };
        } catch (error: any) {
            if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
                return {
                    success: false,
                    message: 'Token inválido ou expirado'
                };
            }
            logger.error(`❌ Erro ao atualizar configurações: ${error.message}`, error);
            return {
                success: false,
                message: 'Erro ao atualizar configurações'
            };
        }
    }

    /**
     * Lista de emails de administradores do sistema
     * ⚠️ SEGURANÇA: Esta é a única fonte de verdade para validação de admin
     * NUNCA confiar em validações vindas do frontend
     */
    private static readonly ADMIN_EMAILS: string[] = [
        'gerald.morais.0192@gmail.com'
    ];

    /**
     * Verifica se um email é de administrador
     * ⚠️ SEGURANÇA: Validação no backend - não confiar no frontend
     */
    private isAdminEmail(email: string): boolean {
        return ExtensaoAuthController.ADMIN_EMAILS.includes(email.toLowerCase());
    }

    /**
     * Obtém configurações de WhatsApp do usuário autenticado
     * Inclui flag isAdmin validada no backend
     */
    async obterConfigWhatsApp(token: string): Promise<{
        success: boolean;
        message?: string;
        config?: WhatsAppConfig;
        isAdmin?: boolean;
    }> {
        try {
            // Verificar token
            const decoded = jwt.verify(token, config.jwt.secret) as any;
            if (decoded.tipo !== 'extensao') {
                return {
                    success: false,
                    message: 'Token inválido'
                };
            }

            // Buscar configurações de WhatsApp e email para validar admin
            const resultado = await Database.query(
                `SELECT email, whatsapp_personalizado_ativo, whatsapp_numero_unico,
                        whatsapp_exigencia, whatsapp_deferido, whatsapp_indeferido,
                        whatsapp_em_analise, whatsapp_agendamento
                FROM usuarios_extensao 
                WHERE id = $1`,
                [decoded.userId]
            );

            if (resultado.length === 0) {
                return {
                    success: false,
                    message: 'Usuário não encontrado'
                };
            }

            const configs = resultado[0];

            // ⚠️ SEGURANÇA: Validação de admin feita exclusivamente no backend
            const isAdmin = this.isAdminEmail(configs.email);

            return {
                success: true,
                isAdmin, // Flag de admin vem do backend, não do frontend
                config: {
                    ativo: configs.whatsapp_personalizado_ativo || false,
                    numeroUnico: configs.whatsapp_numero_unico || undefined,
                    exigencia: configs.whatsapp_exigencia || undefined,
                    deferido: configs.whatsapp_deferido || undefined,
                    indeferido: configs.whatsapp_indeferido || undefined,
                    emAnalise: configs.whatsapp_em_analise || undefined,
                    agendamento: configs.whatsapp_agendamento || undefined
                }
            };
        } catch (error: any) {
            if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
                return {
                    success: false,
                    message: 'Token inválido ou expirado'
                };
            }
            logger.error(`❌ Erro ao obter configurações de WhatsApp: ${error.message}`, error);
            return {
                success: false,
                message: 'Erro ao obter configurações de WhatsApp'
            };
        }
    }

    /**
     * Valida número de WhatsApp (formato: 10-13 dígitos, sem +)
     */
    private validarNumeroWhatsApp(numero: string): boolean {
        if (!numero) return false;
        // Remove espaços e caracteres não numéricos
        const numeroLimpo = numero.replace(/\D/g, '');
        // Deve ter entre 10 e 13 dígitos (formato brasileiro ou internacional)
        return numeroLimpo.length >= 10 && numeroLimpo.length <= 13;
    }

    /**
     * Atualiza configurações de WhatsApp do usuário autenticado
     */
    async atualizarConfigWhatsApp(token: string, whatsappConfig: WhatsAppConfig): Promise<{
        success: boolean;
        message?: string;
        config?: WhatsAppConfig;
    }> {
        try {
            // Verificar token
            const decoded = jwt.verify(token, config.jwt.secret) as any;
            if (decoded.tipo !== 'extensao') {
                return {
                    success: false,
                    message: 'Token inválido'
                };
            }

            // Validar números se fornecidos (apenas os que não são undefined ou vazios)
            const numerosParaValidar = [
                whatsappConfig.numeroUnico,
                whatsappConfig.exigencia,
                whatsappConfig.deferido,
                whatsappConfig.indeferido,
                whatsappConfig.emAnalise,
                whatsappConfig.agendamento
            ].filter(n => n && n.trim && n.trim().length > 0);

            logger.info(`[ExtensaoAuth] Números para validar: ${JSON.stringify(numerosParaValidar)}`);

            for (const numero of numerosParaValidar) {
                if (numero && !this.validarNumeroWhatsApp(numero)) {
                    logger.warn(`[ExtensaoAuth] Número inválido: ${numero}`);
                    return {
                        success: false,
                        message: `Número de WhatsApp inválido: ${numero}. Use formato: 557788682628 (10-13 dígitos, sem +)`
                    };
                }
            }

            // Limpar números (remover caracteres não numéricos)
            const limparNumero = (num?: string): string | null => {
                if (!num) return null;
                const limpo = num.replace(/\D/g, '');
                return limpo.length >= 10 ? limpo : null;
            };

            // Montar query de atualização
            const updates: string[] = [];
            const values: any[] = [];
            let paramIndex = 1;

            updates.push(`whatsapp_personalizado_ativo = $${paramIndex++}`);
            values.push(whatsappConfig.ativo || false);

            if (whatsappConfig.numeroUnico !== undefined) {
                updates.push(`whatsapp_numero_unico = $${paramIndex++}`);
                values.push(limparNumero(whatsappConfig.numeroUnico));
            }

            if (whatsappConfig.exigencia !== undefined) {
                updates.push(`whatsapp_exigencia = $${paramIndex++}`);
                values.push(limparNumero(whatsappConfig.exigencia));
            }

            if (whatsappConfig.deferido !== undefined) {
                updates.push(`whatsapp_deferido = $${paramIndex++}`);
                values.push(limparNumero(whatsappConfig.deferido));
            }

            if (whatsappConfig.indeferido !== undefined) {
                updates.push(`whatsapp_indeferido = $${paramIndex++}`);
                values.push(limparNumero(whatsappConfig.indeferido));
            }

            if (whatsappConfig.emAnalise !== undefined) {
                updates.push(`whatsapp_em_analise = $${paramIndex++}`);
                values.push(limparNumero(whatsappConfig.emAnalise));
            }

            if (whatsappConfig.agendamento !== undefined) {
                updates.push(`whatsapp_agendamento = $${paramIndex++}`);
                values.push(limparNumero(whatsappConfig.agendamento));
            }

            if (updates.length === 0) {
                return {
                    success: false,
                    message: 'Nenhuma configuração fornecida'
                };
            }

            values.push(decoded.userId);
            const query = `UPDATE usuarios_extensao 
                SET ${updates.join(', ')}
                WHERE id = $${paramIndex}`;

            // Removido log de query (segurança - não expor valores)

            await Database.query(query, values);

            // WhatsApp config atualizada silenciosamente

            // Log de auditoria
            auditLogger.logWhatsApp('Configurações WhatsApp atualizadas', decoded.userId, decoded.email, {
                ativo: whatsappConfig.ativo,
                temNumeroUnico: !!whatsappConfig.numeroUnico,
                temNumerosEspecificos: !!(whatsappConfig.exigencia || whatsappConfig.deferido || whatsappConfig.indeferido || whatsappConfig.emAnalise || whatsappConfig.agendamento)
            });

            return {
                success: true,
                message: 'Configurações de WhatsApp atualizadas com sucesso',
                config: whatsappConfig
            };
        } catch (error: any) {
            if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
                return {
                    success: false,
                    message: 'Token inválido ou expirado'
                };
            }

            // Log detalhado do erro
            logger.error(`❌ Erro ao atualizar configurações de WhatsApp: ${error.message}`, error);
            logger.error(`❌ Stack trace: ${error.stack}`);

            // Retornar mensagem mais detalhada em desenvolvimento
            const errorMessage = config.env === 'development'
                ? `Erro ao atualizar configurações de WhatsApp: ${error.message}`
                : 'Erro ao atualizar configurações de WhatsApp';

            return {
                success: false,
                message: errorMessage
            };
        }
    }
}

