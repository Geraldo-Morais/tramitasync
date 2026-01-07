import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import config from '../config';
import logger from '../utils/logger';
import { PerfilUsuario } from '@inss-manager/shared';

export interface AuthRequest extends Request {
    user?: {
        id: string;
        email: string;
        nome: string;
        perfil: PerfilUsuario;
    };
}

/**
 * Middleware de Autenticação
 * Verifica se o token JWT é válido e anexa os dados do usuário à requisição
 */
export const authenticate = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    try {
        // 1. Extrair token do header Authorization
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            res.status(401).json({
                success: false,
                message: 'Token não fornecido',
            });
            return;
        }

        const token = authHeader.substring(7); // Remove "Bearer "

        // 2. Verificar e decodificar token
        const decoded = jwt.verify(token, config.jwt.secret) as {
            id: string;
            email: string;
            nome: string;
            perfil: PerfilUsuario;
        };

        // 3. Anexar dados do usuário à requisição
        (req as AuthRequest).user = decoded;

        logger.info(`[Auth] Usuário autenticado: ${decoded.email} (${decoded.perfil})`);

        next();
    } catch (error) {
        if (error instanceof jwt.TokenExpiredError) {
            res.status(401).json({
                success: false,
                message: 'Token expirado',
            });
            return;
        }

        if (error instanceof jwt.JsonWebTokenError) {
            res.status(401).json({
                success: false,
                message: 'Token inválido',
            });
            return;
        }

        logger.error('[Auth] Erro ao autenticar:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao autenticar',
        });
    }
};

/**
 * Middleware de Autorização por Perfil
 * Verifica se o usuário tem um dos perfis permitidos
 * 
 * @param allowedPerfis Array de perfis permitidos
 * 
 * @example
 * router.get('/judicial', authenticate, authorize(['judicial', 'admin']), handler)
 */
export const authorize = (allowedPerfis: PerfilUsuario[]) => {
    return (req: Request, res: Response, next: NextFunction): void => {
        const authReq = req as AuthRequest;

        if (!authReq.user) {
            res.status(401).json({
                success: false,
                message: 'Usuário não autenticado',
            });
            return;
        }

        if (!allowedPerfis.includes(authReq.user.perfil)) {
            logger.warn(
                `[Auth] Acesso negado: ${authReq.user.email} (${authReq.user.perfil}) tentou acessar rota restrita a ${allowedPerfis.join(', ')}`
            );

            res.status(403).json({
                success: false,
                message: 'Acesso negado. Você não tem permissão para acessar este recurso.',
                requiredPerfis: allowedPerfis,
                userPerfil: authReq.user.perfil,
            });
            return;
        }

        next();
    };
};

/**
 * Middleware para verificar se é Admin
 */
export const requireAdmin = authorize([PerfilUsuario.ADMIN]);

/**
 * Middleware para verificar se é Secretaria ou Admin
 */
export const requireSecretaria = authorize([
    PerfilUsuario.SECRETARIA,
    PerfilUsuario.ADMIN
]);

/**
 * Middleware para verificar se é Administrativo ou Admin
 */
export const requireAdministrativo = authorize([
    PerfilUsuario.ADMINISTRATIVO,
    PerfilUsuario.ADMIN
]);

/**
 * Middleware para verificar se é Intermediação ou Admin
 */
export const requireIntermediacao = authorize([
    PerfilUsuario.INTERMEDIACAO,
    PerfilUsuario.ADMIN
]);

/**
 * Middleware para verificar se é Judicial ou Admin
 */
export const requireJudicial = authorize([
    PerfilUsuario.JUDICIAL,
    PerfilUsuario.ADMIN
]);
