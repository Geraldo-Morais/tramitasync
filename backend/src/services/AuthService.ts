import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import config from '../config';
import Database from '../database';
import logger from '../utils/logger';
import { PerfilUsuario } from '@inss-manager/shared';

interface LoginCredentials {
    email: string;
    senha: string;
}

interface RegisterData {
    nome: string;
    email: string;
    senha: string;
    perfil: PerfilUsuario;
}

interface AuthResponse {
    success: boolean;
    message?: string;
    data?: {
        token: string;
        user: {
            id: string;
            nome: string;
            email: string;
            perfil: PerfilUsuario;
        };
    };
}

/**
 * Serviço de Autenticação
 * Responsável por login, registro e geração de tokens JWT
 */
export class AuthService {
    /**
     * Realiza login do usuário
     * @param credentials Email e senha
     * @returns Token JWT e dados do usuário
     */
    async login(credentials: LoginCredentials): Promise<AuthResponse> {
        try {
            const { email, senha } = credentials;

            logger.info(`[AuthService] Tentativa de login: ${email}`);

            // 1. Buscar usuário no banco
            const result = await Database.query(
                'SELECT id, nome, email, senha, perfil, ativo FROM usuarios WHERE email = $1',
                [email.toLowerCase()]
            );

            if (result.length === 0) {
                logger.warn(`[AuthService] Usuário não encontrado: ${email}`);
                return {
                    success: false,
                    message: 'Email ou senha incorretos',
                };
            }

            const user = result[0];

            // 2. Verificar se usuário está ativo
            if (!user.ativo) {
                logger.warn(`[AuthService] Usuário inativo: ${email}`);
                return {
                    success: false,
                    message: 'Usuário inativo. Entre em contato com o administrador.',
                };
            }

            // 3. Comparar senha
            const senhaValida = await bcrypt.compare(senha, user.senha);

            if (!senhaValida) {
                logger.warn(`[AuthService] Senha incorreta para: ${email}`);
                return {
                    success: false,
                    message: 'Email ou senha incorretos',
                };
            }

            // 4. Gerar token JWT
            const token = this.generateToken({
                id: user.id,
                email: user.email,
                nome: user.nome,
                perfil: user.perfil,
            });

            logger.info(`[AuthService] Login bem-sucedido: ${email} (${user.perfil})`);

            return {
                success: true,
                data: {
                    token,
                    user: {
                        id: user.id,
                        nome: user.nome,
                        email: user.email,
                        perfil: user.perfil,
                    },
                },
            };
        } catch (error) {
            logger.error('[AuthService] Erro ao fazer login:', error);
            return {
                success: false,
                message: 'Erro ao fazer login',
            };
        }
    }

    /**
     * Registra novo usuário (apenas Admin pode fazer isso)
     * @param data Dados do novo usuário
     * @returns Token JWT e dados do usuário criado
     */
    async register(data: RegisterData): Promise<AuthResponse> {
        try {
            const { nome, email, senha, perfil } = data;

            logger.info(`[AuthService] Tentativa de registro: ${email}`);

            // 1. Verificar se email já existe
            const existingUser = await Database.query(
                'SELECT id FROM usuarios WHERE email = $1',
                [email.toLowerCase()]
            );

            if (existingUser.length > 0) {
                logger.warn(`[AuthService] Email já cadastrado: ${email}`);
                return {
                    success: false,
                    message: 'Email já cadastrado',
                };
            }

            // 2. Hash da senha
            const senhaHash = await bcrypt.hash(senha, 10);

            // 3. Inserir no banco
            const result = await Database.query(
                `INSERT INTO usuarios (nome, email, senha_hash, perfil, ativo)
         VALUES ($1, $2, $3, $4, true)
         RETURNING id, nome, email, perfil`,
                [nome, email.toLowerCase(), senhaHash, perfil]
            );

            const newUser = result[0];

            // 4. Gerar token JWT
            const token = this.generateToken({
                id: newUser.id,
                email: newUser.email,
                nome: newUser.nome,
                perfil: newUser.perfil,
            });

            logger.info(`[AuthService] Usuário registrado: ${email} (${perfil})`);

            return {
                success: true,
                data: {
                    token,
                    user: {
                        id: newUser.id,
                        nome: newUser.nome,
                        email: newUser.email,
                        perfil: newUser.perfil,
                    },
                },
            };
        } catch (error) {
            logger.error('[AuthService] Erro ao registrar usuário:', error);
            return {
                success: false,
                message: 'Erro ao registrar usuário',
            };
        }
    }

    /**
     * Busca usuário pelo ID
     * @param userId ID do usuário
     * @returns Dados do usuário (sem senha)
     */
    async getUserById(userId: string): Promise<any> {
        try {
            const result = await Database.query(
                'SELECT id, nome, email, perfil, ativo, created_at FROM usuarios WHERE id = $1',
                [userId]
            );

            return result[0] || null;
        } catch (error) {
            logger.error('[AuthService] Erro ao buscar usuário:', error);
            return null;
        }
    }

    /**
     * Lista todos os usuários (apenas Admin)
     * @returns Lista de usuários
     */
    async listUsers(): Promise<any[]> {
        try {
            const result = await Database.query(
                'SELECT id, nome, email, perfil, ativo, created_at FROM usuarios ORDER BY nome'
            );

            return result;
        } catch (error) {
            logger.error('[AuthService] Erro ao listar usuários:', error);
            return [];
        }
    }

    /**
     * Atualiza perfil do usuário (apenas Admin)
     * @param userId ID do usuário
     * @param perfil Novo perfil
     * @returns Sucesso ou falha
     */
    async updateUserPerfil(
        userId: string,
        perfil: PerfilUsuario
    ): Promise<boolean> {
        try {
            await Database.query(
                'UPDATE usuarios SET perfil = $1 WHERE id = $2',
                [perfil, userId]
            );

            logger.info(`[AuthService] Perfil atualizado: usuário ${userId} → ${perfil}`);
            return true;
        } catch (error) {
            logger.error('[AuthService] Erro ao atualizar perfil:', error);
            return false;
        }
    }

    /**
     * Ativa/Desativa usuário (apenas Admin)
     * @param userId ID do usuário
     * @param ativo true para ativar, false para desativar
     * @returns Sucesso ou falha
     */
    async toggleUserStatus(userId: string, ativo: boolean): Promise<boolean> {
        try {
            await Database.query(
                'UPDATE usuarios SET ativo = $1 WHERE id = $2',
                [ativo, userId]
            );

            logger.info(`[AuthService] Status atualizado: usuário ${userId} → ${ativo ? 'ativo' : 'inativo'}`);
            return true;
        } catch (error) {
            logger.error('[AuthService] Erro ao atualizar status:', error);
            return false;
        }
    }

    /**
     * Altera senha do usuário
     * @param userId ID do usuário
     * @param senhaAtual Senha atual (para validação)
     * @param novaSenha Nova senha
     * @returns Sucesso ou falha
     */
    async changePassword(
        userId: string,
        senhaAtual: string,
        novaSenha: string
    ): Promise<AuthResponse> {
        try {
            // 1. Buscar usuário
            const result = await Database.query(
                'SELECT senha_hash FROM usuarios WHERE id = $1',
                [userId]
            );

            if (result.length === 0) {
                return {
                    success: false,
                    message: 'Usuário não encontrado',
                };
            }

            // 2. Verificar senha atual
            const senhaValida = await bcrypt.compare(senhaAtual, result[0].senha_hash);

            if (!senhaValida) {
                return {
                    success: false,
                    message: 'Senha atual incorreta',
                };
            }

            // 3. Hash da nova senha
            const novaSenhaHash = await bcrypt.hash(novaSenha, 10);

            // 4. Atualizar no banco
            await Database.query(
                'UPDATE usuarios SET senha_hash = $1 WHERE id = $2',
                [novaSenhaHash, userId]
            );

            logger.info(`[AuthService] Senha alterada: usuário ${userId}`);

            return {
                success: true,
                message: 'Senha alterada com sucesso',
            };
        } catch (error) {
            logger.error('[AuthService] Erro ao alterar senha:', error);
            return {
                success: false,
                message: 'Erro ao alterar senha',
            };
        }
    }

    /**
     * Gera token JWT
     * @param payload Dados a serem incluídos no token
     * @returns Token JWT
     */
    private generateToken(payload: {
        id: string;
        email: string;
        nome: string;
        perfil: PerfilUsuario;
    }): string {
        return jwt.sign(payload, config.jwt.secret, {
            expiresIn: config.jwt.expiresIn
        } as jwt.SignOptions);
    }

    /**
     * Valida formato de email
     */
    private isValidEmail(email: string): boolean {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    }

    /**
     * Valida força da senha
     * Mínimo 8 caracteres
     */
    private isStrongPassword(senha: string): boolean {
        return senha.length >= 8;
    }
}

export default new AuthService();
