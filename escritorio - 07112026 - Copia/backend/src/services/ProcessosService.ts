import Database from '../database';
import logger from '../utils/logger';
import { StatusINSS, ClasseFinal, StatusFluxo } from '@inss-manager/shared';

interface FiltrosProcesso {
    status_inss?: StatusINSS;
    classe_final?: ClasseFinal;
    status_fluxo?: StatusFluxo;
    cpf?: string;
    protocolo?: string;
    tipo_beneficio?: string;
    mes?: string; // formato: YYYY-MM
    responsavel_id?: string;
    page?: number;
    limit?: number;
}

interface DashboardData {
    totais: {
        total: number;
        pendentes: number;
        em_analise: number;
        exigencias: number;
        concluidos: number;
    };
    resultados: {
        deferidos: number;
        indeferidos: number;
        cancelados: number;
    };
    por_tipo_beneficio: Array<{
        tipo: string;
        quantidade: number;
    }>;
    por_mes: Array<{
        mes: string;
        quantidade: number;
        deferidos: number;
        indeferidos: number;
    }>;
    exigencias_proximas_vencer: Array<{
        id: string;
        protocolo: string;
        nome: string;
        prazo: Date;
        dias_restantes: number;
    }>;
}

/**
 * Serviço de Processos
 * Lógica de negócio para gerenciamento de processos INSS
 */
export class ProcessosService {
    /**
     * Lista processos com filtros e paginação
     */
    async list(filtros: FiltrosProcesso): Promise<any> {
        try {
            const {
                status_inss,
                classe_final,
                status_fluxo,
                cpf,
                protocolo,
                tipo_beneficio,
                mes,
                responsavel_id,
                page = 1,
                limit = 20,
            } = filtros;

            // Construir query dinamicamente
            const whereConditions: string[] = [];
            const params: any[] = [];
            let paramIndex = 1;

            if (status_inss) {
                whereConditions.push(`p.status_inss = $${paramIndex++}`);
                params.push(status_inss);
            }

            if (classe_final) {
                whereConditions.push(`p.classe_final = $${paramIndex++}`);
                params.push(classe_final);
            }

            if (status_fluxo) {
                whereConditions.push(`p.status_fluxo = $${paramIndex++}`);
                params.push(status_fluxo);
            }

            if (cpf) {
                whereConditions.push(`p.cpf ILIKE $${paramIndex++}`);
                params.push(`%${cpf}%`);
            }

            if (protocolo) {
                whereConditions.push(`p.protocolo_inss ILIKE $${paramIndex++}`);
                params.push(`%${protocolo}%`);
            }

            if (tipo_beneficio) {
                whereConditions.push(`p.tipo_beneficio ILIKE $${paramIndex++}`);
                params.push(`%${tipo_beneficio}%`);
            }

            if (mes) {
                whereConditions.push(`TO_CHAR(p.der, 'YYYY-MM') = $${paramIndex++}`);
                params.push(mes);
            }

            if (responsavel_id) {
                whereConditions.push(`p.responsavel_id = $${paramIndex++}`);
                params.push(responsavel_id);
            }

            const whereClause =
                whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

            // Query de contagem
            const countQuery = `
        SELECT COUNT(*) as total
        FROM processos p
        ${whereClause}
      `;

            const countResult = await Database.query(countQuery, params);
            const total = parseInt(countResult[0].total);

            // Query de dados com paginação
            const offset = (page - 1) * limit;
            params.push(limit, offset);

            const dataQuery = `
        SELECT 
          p.id,
          p.protocolo_inss as protocolo,
          p.cpf_segurado as cpf,
          p.nome_segurado as nome,
          p.tipo_beneficio,
          p.der,
          p.status_inss,
          p.classe_final,
          p.status_fluxo,
          p.data_conclusao,
          p.created_at,
          p.updated_at,
          u.nome as responsavel_nome,
          u.perfil as responsavel_perfil,
          e.id as exigencia_id,
          e.prazo as exigencia_prazo,
          CASE 
            WHEN e.prazo IS NOT NULL 
            THEN EXTRACT(DAY FROM (e.prazo - NOW()))
            ELSE NULL
          END as dias_ate_prazo
        FROM processos p
        LEFT JOIN usuarios u ON p.responsavel_id = u.id
        LEFT JOIN exigencias e ON p.id = e.processo_id AND e.status = 'PENDENTE'
        ${whereClause}
        ORDER BY p.updated_at DESC
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}
      `;

            const processos = await Database.query(dataQuery, params);

            return {
                success: true,
                data: {
                    processos,
                    pagination: {
                        page,
                        limit,
                        total,
                        totalPages: Math.ceil(total / limit),
                    },
                },
            };
        } catch (error) {
            logger.error('[ProcessosService] Erro ao listar processos:', error);
            return {
                success: false,
                message: 'Erro ao listar processos',
            };
        }
    }

    /**
     * Busca processo por ID
     */
    async findById(id: string): Promise<any> {
        try {
            const query = `
        SELECT 
          p.*,
          u.nome as responsavel_nome,
          u.email as responsavel_email,
          u.perfil as responsavel_perfil,
          e.id as exigencia_id,
          e.data_abertura as exigencia_data_abertura,
          e.prazo as exigencia_prazo,
          e.resumo as exigencia_resumo,
          e.documentos_exigidos as exigencia_documentos,
          e.status as exigencia_status,
          pj.id as processo_judicial_id,
          pj.numero_processo as processo_judicial_numero,
          pj.vara as processo_judicial_vara,
          pj.comarca as processo_judicial_comarca
        FROM processos p
        LEFT JOIN usuarios u ON p.responsavel_id = u.id
        LEFT JOIN exigencias e ON p.id = e.processo_id
        LEFT JOIN processos_judiciais pj ON p.id = pj.processo_id
        WHERE p.id = $1
      `;

            const result = await Database.query(query, [id]);

            if (result.length === 0) {
                return {
                    success: false,
                    message: 'Processo não encontrado',
                };
            }

            // Buscar histórico de status
            const historico = await Database.query(
                `SELECT id, status, observacao, created_at, usuario_id,
         (SELECT nome FROM usuarios WHERE id = historico_status.usuario_id) as usuario_nome
         FROM historico_status
         WHERE processo_id = $1
         ORDER BY created_at DESC`,
                [id]
            );

            const processo = result[0];
            processo.historico = historico;

            return {
                success: true,
                data: {
                    processo,
                },
            };
        } catch (error) {
            logger.error('[ProcessosService] Erro ao buscar processo:', error);
            return {
                success: false,
                message: 'Erro ao buscar processo',
            };
        }
    }

    /**
     * Atualiza status interno do fluxo de trabalho
     */
    async updateStatusFluxo(
        processoId: string,
        statusFluxo: StatusFluxo,
        observacao: string,
        usuarioId: string
    ): Promise<any> {
        try {
            // Atualizar processo
            await Database.query(
                `UPDATE processos 
         SET status_fluxo = $1, ultima_atualizacao = NOW()
         WHERE id = $2`,
                [statusFluxo, processoId]
            );

            // Registrar no histórico
            await Database.query(
                `INSERT INTO historico_status (processo_id, status, observacao, usuario_id)
         VALUES ($1, $2, $3, $4)`,
                [processoId, statusFluxo, observacao, usuarioId]
            );

            logger.info(
                `[ProcessosService] Status atualizado: processo ${processoId} → ${statusFluxo}`
            );

            return {
                success: true,
                message: 'Status atualizado com sucesso',
            };
        } catch (error) {
            logger.error('[ProcessosService] Erro ao atualizar status:', error);
            return {
                success: false,
                message: 'Erro ao atualizar status',
            };
        }
    }

    /**
     * Atribui responsável ao processo
     */
    async atribuirResponsavel(
        processoId: string,
        responsavelId: string,
        usuarioId: string
    ): Promise<any> {
        try {
            await Database.query(
                `UPDATE processos 
         SET responsavel_id = $1, ultima_atualizacao = NOW()
         WHERE id = $2`,
                [responsavelId, processoId]
            );

            // Registrar no histórico
            const responsavel = await Database.query(
                'SELECT nome FROM usuarios WHERE id = $1',
                [responsavelId]
            );

            await Database.query(
                `INSERT INTO historico_status (processo_id, status, observacao, usuario_id)
         VALUES ($1, $2, $3, $4)`,
                [
                    processoId,
                    'ATRIBUIDO',
                    `Processo atribuído a ${responsavel[0]?.nome || 'usuário'}`,
                    usuarioId,
                ]
            );

            logger.info(
                `[ProcessosService] Responsável atribuído: processo ${processoId} → usuário ${responsavelId}`
            );

            return {
                success: true,
                message: 'Responsável atribuído com sucesso',
            };
        } catch (error) {
            logger.error('[ProcessosService] Erro ao atribuir responsável:', error);
            return {
                success: false,
                message: 'Erro ao atribuir responsável',
            };
        }
    }

    /**
     * Dados agregados para Dashboard
     */
    async getDashboardData(filtros?: { mes?: string }): Promise<DashboardData> {
        try {
            const { mes } = filtros || {};

            // Filtro de mês (opcional)
            const mesWhere = mes ? `WHERE TO_CHAR(der, 'YYYY-MM') = '${mes}'` : '';

            // 1. Totais gerais
            const totaisQuery = `
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status_inss = 'PENDENTE') as pendentes,
          COUNT(*) FILTER (WHERE status_inss = 'EM_ANALISE') as em_analise,
          COUNT(*) FILTER (WHERE status_inss = 'CUMPRIMENTO_DE_EXIGENCIA') as exigencias,
          COUNT(*) FILTER (WHERE status_inss IN ('CONCLUIDA', 'CANCELADA')) as concluidos
        FROM processos
        ${mesWhere}
      `;

            const totaisResult = await Database.query(totaisQuery);

            // 2. Resultados (deferidos/indeferidos)
            const resultadosQuery = `
        SELECT 
          COUNT(*) FILTER (WHERE classe_final = 'DEFERIDO') as deferidos,
          COUNT(*) FILTER (WHERE classe_final = 'INDEFERIDO') as indeferidos,
          COUNT(*) FILTER (WHERE classe_final = 'CANCELADO') as cancelados
        FROM processos
        WHERE status_inss = 'CONCLUIDA'
        ${mes ? `AND TO_CHAR(der, 'YYYY-MM') = '${mes}'` : ''}
      `;

            const resultadosResult = await Database.query(resultadosQuery);

            // 3. Por tipo de benefício
            const tipoQuery = `
        SELECT 
          tipo_beneficio as tipo,
          COUNT(*) as quantidade
        FROM processos
        ${mesWhere}
        GROUP BY tipo_beneficio
        ORDER BY quantidade DESC
        LIMIT 10
      `;

            const tipoResult = await Database.query(tipoQuery);

            // 4. Por mês (últimos 6 meses)
            const mesQuery = `
        SELECT 
          TO_CHAR(der, 'YYYY-MM') as mes,
          COUNT(*) as quantidade,
          COUNT(*) FILTER (WHERE classe_final = 'DEFERIDO') as deferidos,
          COUNT(*) FILTER (WHERE classe_final = 'INDEFERIDO') as indeferidos
        FROM processos
        WHERE der >= NOW() - INTERVAL '6 months'
        GROUP BY TO_CHAR(der, 'YYYY-MM')
        ORDER BY mes DESC
      `;

            const mesResult = await Database.query(mesQuery);

            // 5. Exigências próximas a vencer
            const exigenciasQuery = `
        SELECT 
          p.id,
          p.protocolo_inss as protocolo,
          p.nome_segurado as nome,
          e.prazo,
          EXTRACT(DAY FROM (e.prazo - NOW())) as dias_restantes
        FROM processos p
        INNER JOIN exigencias e ON p.id = e.processo_id
        WHERE e.status = 'PENDENTE'
          AND e.prazo >= NOW()
          AND e.prazo <= NOW() + INTERVAL '7 days'
        ORDER BY e.prazo ASC
        LIMIT 10
      `;

            const exigenciasResult = await Database.query(exigenciasQuery);

            return {
                totais: {
                    total: parseInt(totaisResult[0].total),
                    pendentes: parseInt(totaisResult[0].pendentes),
                    em_analise: parseInt(totaisResult[0].em_analise),
                    exigencias: parseInt(totaisResult[0].exigencias),
                    concluidos: parseInt(totaisResult[0].concluidos),
                },
                resultados: {
                    deferidos: parseInt(resultadosResult[0].deferidos),
                    indeferidos: parseInt(resultadosResult[0].indeferidos),
                    cancelados: parseInt(resultadosResult[0].cancelados),
                },
                por_tipo_beneficio: tipoResult,
                por_mes: mesResult,
                exigencias_proximas_vencer: exigenciasResult,
            };
        } catch (error) {
            logger.error('[ProcessosService] Erro ao obter dados do dashboard:', error);
            throw error;
        }
    }
}

export default new ProcessosService();
