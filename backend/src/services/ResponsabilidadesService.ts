/**
 * SERVICE: Responsabilidades
 * Gerencia atribuição configurável de responsáveis por benefício + fase
 */

import database from '../database';
import logger from '../utils/logger';

interface Beneficio {
    slug: string;
    nome: string;
    fase?: 'ADMINISTRATIVO' | 'JUDICIAL' | null;
}

interface ResponsabilidadesConfig {
    pode_administrativo: boolean;
    pode_judicial: boolean;
    responsavel_exigencia: boolean;
    beneficios: Array<{
        slug: string;
        fase?: 'ADMINISTRATIVO' | 'JUDICIAL' | null;
    }>;
}

interface TransferenciaParams {
    deUsuarioId: string;
    paraUsuarioId: string;
    tipos: Array<'EXIGENCIA' | 'ADMINISTRATIVO' | 'JUDICIAL'>;
    realizadoPorId: string;
}

class ResponsabilidadesService {
    /**
     * Listar todos os benefícios disponíveis
     */
    async listarBeneficios(): Promise<Beneficio[]> {
        try {
            const result = await database.getPool().query(`
        SELECT slug, nome 
        FROM beneficios 
        WHERE ativo = TRUE 
        ORDER BY nome
      `);
            return result.rows;
        } catch (error) {
            logger.error('[ResponsabilidadesService] Erro ao listar benefícios:', error);
            throw error;
        }
    }

    /**
     * Obter responsabilidades de um usuário
     */
    async obterResponsabilidades(usuarioId: string): Promise<ResponsabilidadesConfig> {
        try {
            const result = await database.getPool().query(`
        SELECT 
          BOOL_OR(pode_administrativo) as pode_administrativo,
          BOOL_OR(pode_judicial) as pode_judicial,
          BOOL_OR(responsavel_exigencia) as responsavel_exigencia,
          json_agg(
            json_build_object(
              'slug', b.slug,
              'nome', b.nome,
              'fase', ur.fase
            )
          ) FILTER (WHERE b.slug IS NOT NULL) as beneficios
        FROM usuario_responsabilidades ur
        JOIN beneficios b ON b.id = ur.beneficio_id
        WHERE ur.usuario_id = $1
        GROUP BY ur.usuario_id
      `, [usuarioId]);

            if (result.rows.length === 0) {
                return {
                    pode_administrativo: false,
                    pode_judicial: false,
                    responsavel_exigencia: false,
                    beneficios: []
                };
            }

            const row = result.rows[0];
            return {
                pode_administrativo: row.pode_administrativo || false,
                pode_judicial: row.pode_judicial || false,
                responsavel_exigencia: row.responsavel_exigencia || false,
                beneficios: row.beneficios || []
            };
        } catch (error) {
            logger.error('[ResponsabilidadesService] Erro ao obter responsabilidades:', error);
            throw error;
        }
    }

    /**
     * Configurar responsabilidades de um usuário
     */
    async configurarResponsabilidades(
        usuarioId: string,
        config: ResponsabilidadesConfig
    ): Promise<void> {
        const client = await database.getPool().connect();

        try {
            await client.query('BEGIN');

            // 1. Apagar responsabilidades antigas
            await client.query(
                'DELETE FROM usuario_responsabilidades WHERE usuario_id = $1',
                [usuarioId]
            );

            // 2. Inserir novas responsabilidades
            for (const beneficio of config.beneficios) {
                // Buscar ID do benefício
                const beneficioResult = await client.query(
                    'SELECT id FROM beneficios WHERE slug = $1',
                    [beneficio.slug]
                );

                if (beneficioResult.rows.length === 0) {
                    logger.warn(`Benefício ${beneficio.slug} não encontrado, pulando...`);
                    continue;
                }

                const beneficioId = beneficioResult.rows[0].id;

                // Determinar prioridade (responsável de exigência tem maior prioridade)
                const prioridade = config.responsavel_exigencia ? 100 : 80;

                await client.query(`
          INSERT INTO usuario_responsabilidades (
            usuario_id,
            beneficio_id,
            pode_administrativo,
            pode_judicial,
            responsavel_exigencia,
            fase,
            prioridade
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (usuario_id, beneficio_id, fase) DO UPDATE
          SET 
            pode_administrativo = EXCLUDED.pode_administrativo,
            pode_judicial = EXCLUDED.pode_judicial,
            responsavel_exigencia = EXCLUDED.responsavel_exigencia,
            prioridade = EXCLUDED.prioridade
        `, [
                    usuarioId,
                    beneficioId,
                    config.pode_administrativo,
                    config.pode_judicial,
                    config.responsavel_exigencia,
                    beneficio.fase || null,
                    prioridade
                ]);
            }

            await client.query('COMMIT');

            logger.info(`[ResponsabilidadesService] Responsabilidades configuradas para usuário ${usuarioId}`);
        } catch (error) {
            await client.query('ROLLBACK');
            logger.error('[ResponsabilidadesService] Erro ao configurar responsabilidades:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Transferir responsabilidades de um usuário para outro
     */
    async transferirResponsabilidades(params: TransferenciaParams): Promise<{
        processosAfetados: number;
        tarefasAfetadas: number;
    }> {
        const client = await database.getPool().connect();
        let processosAfetados = 0;
        let tarefasAfetadas = 0;

        try {
            await client.query('BEGIN');

            // Buscar nomes dos usuários
            const usuarios = await client.query(`
        SELECT id, nome FROM usuarios WHERE id IN ($1, $2)
      `, [params.deUsuarioId, params.paraUsuarioId]);

            const deUsuario = usuarios.rows.find(u => u.id === params.deUsuarioId);
            const paraUsuario = usuarios.rows.find(u => u.id === params.paraUsuarioId);

            if (!deUsuario || !paraUsuario) {
                throw new Error('Usuário de origem ou destino não encontrado');
            }

            // Transferir por tipo
            for (const tipo of params.tipos) {
                if (tipo === 'EXIGENCIA') {
                    // Transferir processos em exigência
                    const result = await client.query(`
            UPDATE processos
            SET 
              responsavel_atual_id = $2,
              resp_exigencia_id = $2,
              updated_at = NOW()
            WHERE responsavel_atual_id = $1
              AND status_fluxo IN (
                'EXIGENCIA_DETECTADA',
                'CUMPRIMENTO_DE_EXIGENCIA',
                'SOLICITADO_CINTIA',
                'CONTATO_COLABORADOR'
              )
            RETURNING id
          `, [params.deUsuarioId, params.paraUsuarioId]);

                    processosAfetados += result.rowCount || 0;

                    // Transferir tarefas de exigência
                    const tarefasResult = await client.query(`
            UPDATE tarefas
            SET responsavel_usuario_id = $2
            WHERE responsavel_usuario_id = $1
              AND tipo IN ('SOLICITAR_DOCUMENTO', 'ANEXAR_DOCUMENTO')
              AND status != 'CONCLUIDA'
          `, [params.deUsuarioId, params.paraUsuarioId]);

                    tarefasAfetadas += tarefasResult.rowCount || 0;
                }

                if (tipo === 'ADMINISTRATIVO') {
                    // Transferir processos administrativos
                    const result = await client.query(`
            UPDATE processos
            SET 
              resp_administrativo_id = $2,
              responsavel_atual_id = CASE 
                WHEN fase = 'ADMINISTRATIVO' AND status_fluxo NOT IN (
                  'EXIGENCIA_DETECTADA', 'CUMPRIMENTO_DE_EXIGENCIA', 
                  'SOLICITADO_CINTIA', 'CONTATO_COLABORADOR'
                ) THEN $2
                ELSE responsavel_atual_id
              END,
              updated_at = NOW()
            WHERE resp_administrativo_id = $1
            RETURNING id
          `, [params.deUsuarioId, params.paraUsuarioId]);

                    processosAfetados += result.rowCount || 0;
                }

                if (tipo === 'JUDICIAL') {
                    // Transferir processos judiciais
                    const result = await client.query(`
            UPDATE processos
            SET 
              resp_judicial_id = $2,
              responsavel_atual_id = CASE 
                WHEN fase = 'JUDICIAL' THEN $2
                ELSE responsavel_atual_id
              END,
              updated_at = NOW()
            WHERE resp_judicial_id = $1
            RETURNING id
          `, [params.deUsuarioId, params.paraUsuarioId]);

                    processosAfetados += result.rowCount || 0;
                }
            }

            // Registrar histórico
            await client.query(`
        INSERT INTO historico_transferencias (
          de_usuario_id,
          para_usuario_id,
          de_usuario_nome,
          para_usuario_nome,
          tipo_transferencia,
          processos_afetados,
          realizado_por_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [
                params.deUsuarioId,
                params.paraUsuarioId,
                deUsuario.nome,
                paraUsuario.nome,
                params.tipos.join('+'),
                processosAfetados,
                params.realizadoPorId
            ]);

            await client.query('COMMIT');

            logger.info(`[ResponsabilidadesService] Transferência concluída: ${processosAfetados} processos, ${tarefasAfetadas} tarefas`);

            return { processosAfetados, tarefasAfetadas };
        } catch (error) {
            await client.query('ROLLBACK');
            logger.error('[ResponsabilidadesService] Erro ao transferir responsabilidades:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Listar histórico de transferências
     */
    async listarHistoricoTransferencias(limite: number = 50): Promise<any[]> {
        try {
            const result = await database.getPool().query(`
        SELECT 
          ht.*,
          u_realizado.nome as realizado_por_nome
        FROM historico_transferencias ht
        LEFT JOIN usuarios u_realizado ON u_realizado.id = ht.realizado_por_id
        ORDER BY ht.created_at DESC
        LIMIT $1
      `, [limite]);

            return result.rows;
        } catch (error) {
            logger.error('[ResponsabilidadesService] Erro ao listar histórico:', error);
            throw error;
        }
    }
}

export default new ResponsabilidadesService();
