/**
 * Serviço de Aprendizado de Padrões de Etiquetas
 * 
 * Aprende automaticamente como cada escritório (cliente SaaS) organiza suas etiquetas
 * para manter consistência nas sincronizações automáticas.
 * 
 * Funcionalidades:
 * 1. Analisar ~100 clientes existentes no Tramitação
 * 2. Identificar padrões de etiquetas por tipo de benefício
 * 3. Mapear nomes do INSS → nomes usados pelo escritório
 * 4. Preservar etiquetas manuais durante atualizações
 */

import Database from '../database';
import logger from '../utils/logger';
import { TramitacaoService } from './TramitacaoService';
import { AIService } from './AIService';

// Mapeamento de benefícios INSS (padrão) para possíveis variações
const BENEFICIOS_INSS_PADROES: Record<string, string[]> = {
    // BPC / LOAS
    'BPC_LOAS': [
        'BPC', 'LOAS', 'BPC_LOAS', 'BPC-LOAS', 'BENEFICIO_ASSISTENCIAL',
        'BENEFÍCIO_ASSISTENCIAL', 'BENEFICIO_DE_PRESTACAO_CONTINUADA',
        'BENEFÍCIO_DE_PRESTAÇÃO_CONTINUADA', 'ASSISTENCIAL'
    ],
    // Aposentadoria por Idade
    'APOSENTADORIA_IDADE': [
        'APOSENTADORIA_IDADE', 'APOSENTADORIA_POR_IDADE', 'APOS_IDADE',
        'APOSENTADORIA', 'IDADE'
    ],
    // Aposentadoria por Tempo de Contribuição
    'APOSENTADORIA_TEMPO': [
        'APOSENTADORIA_TEMPO', 'APOSENTADORIA_TEMPO_CONTRIBUICAO',
        'APOSENTADORIA_POR_TEMPO', 'TEMPO_CONTRIBUICAO', 'APOS_TEMPO'
    ],
    // Aposentadoria por Invalidez
    'APOSENTADORIA_INVALIDEZ': [
        'APOSENTADORIA_INVALIDEZ', 'APOSENTADORIA_POR_INVALIDEZ',
        'INVALIDEZ', 'APOS_INVALIDEZ'
    ],
    // Auxílio-Doença / Incapacidade Temporária
    'AUXILIO_DOENCA': [
        'AUXILIO_DOENCA', 'AUXÍLIO_DOENÇA', 'AUXILIO-DOENCA',
        'INCAPACIDADE_TEMPORARIA', 'INCAPACIDADE', 'B31'
    ],
    // Pensão por Morte
    'PENSAO_MORTE': [
        'PENSAO_MORTE', 'PENSÃO_MORTE', 'PENSAO_POR_MORTE',
        'PENSÃO_POR_MORTE', 'PENSAO', 'PENSÃO'
    ],
    // Salário-Maternidade
    'SALARIO_MATERNIDADE': [
        'SALARIO_MATERNIDADE', 'SALÁRIO_MATERNIDADE', 'MATERNIDADE'
    ],
    // Rural
    'RURAL': [
        'RURAL', 'SEGURADO_ESPECIAL', 'TRABALHADOR_RURAL'
    ],
    // Urbano
    'URBANO': [
        'URBANO', 'SEGURADO_URBANO', 'TRABALHADOR_URBANO'
    ]
};

// Tags de status conhecidas (globais)
const TAGS_STATUS_CONHECIDAS = [
    'EXIGENCIA', 'EXIGÊNCIA', 'EM_EXIGENCIA', 'EM_EXIGÊNCIA',
    'EM_ANALISE', 'EM_ANÁLISE', 'ANALISE', 'ANÁLISE',
    'DEFERIDO', 'CONCEDIDO', 'APROVADO',
    'INDEFERIDO', 'NEGADO', 'REJEITADO',
    'PENDENTE', 'AGUARDANDO',
    'CONCLUIDO', 'CONCLUÍDA', 'FINALIZADO'
];

// Tags de fase conhecidas (globais)
const TAGS_FASE_CONHECIDAS = [
    'ADMINISTRATIVO', 'ADMINISTRATIVA', 'ADMIN',
    'JUDICIAL', 'JUDICIALIZADO', 'PROCESSO_JUDICIAL'
];

interface PadraoEscritorio {
    userId: string;
    mapeamentoBeneficios: Record<string, string>;
    etiquetasStatus: string[];
    etiquetasFase: string[];
    etiquetasResponsaveis: string[];
    etiquetasSistema: string[];
    etiquetasObrigatorias: string[];
    totalClientesAnalisados: number;
    ultimaAtualizacao: Date;
}

class PadroesEtiquetasService {
    private tramitacaoService: TramitacaoService | null = null;

    // Cache em memória para evitar consultas repetidas ao banco
    private cachePatroes: Map<string, PadraoEscritorio> = new Map();
    private cacheTTL = 5 * 60 * 1000; // 5 minutos
    private cacheTimestamps: Map<string, number> = new Map();

    /**
     * Obtém o padrão de etiquetas de um escritório
     * Se não existir ou estiver desatualizado, aprende automaticamente
     */
    async obterPadrao(userId: string, tramitacaoService: TramitacaoService): Promise<PadraoEscritorio | null> {
        this.tramitacaoService = tramitacaoService;

        // Verificar cache
        const cached = this.cachePatroes.get(userId);
        const cacheTime = this.cacheTimestamps.get(userId) || 0;

        if (cached && Date.now() - cacheTime < this.cacheTTL) {
            return cached;
        }

        // Buscar do banco
        const padrao = await this.buscarPadraoDoBanco(userId);

        if (padrao) {
            this.cachePatroes.set(userId, padrao);
            this.cacheTimestamps.set(userId, Date.now());
            return padrao;
        }

        return null;
    }

    /**
     * Verifica se precisa atualizar o padrão (mais de 7 dias sem atualizar)
     */
    async precisaAtualizar(userId: string): Promise<boolean> {
        const query = `
            SELECT ultima_atualizacao 
            FROM padroes_etiquetas_escritorio 
            WHERE user_id = $1
        `;

        const resultado = await Database.query(query, [userId]);

        if (resultado.length === 0) {
            return true; // Não existe, precisa criar
        }

        const ultimaAtualizacao = new Date(resultado[0].ultima_atualizacao);
        const diasDesdeAtualizacao = (Date.now() - ultimaAtualizacao.getTime()) / (1000 * 60 * 60 * 24);

        return diasDesdeAtualizacao > 7; // Atualizar se mais de 7 dias
    }

    /**
     * Aprende os padrões de etiquetas de um escritório analisando seus clientes
     * @param userId ID do usuário (escritório)
     * @param tramitacaoService Instância do serviço Tramitação autenticada
     * @param limite Número de clientes para analisar (padrão: 100)
     */
    async aprenderPadroes(
        userId: string,
        tramitacaoService: TramitacaoService,
        limite: number = 100
    ): Promise<PadraoEscritorio | null> {
        this.tramitacaoService = tramitacaoService;

        logger.info(`[PadroesEtiquetas] Iniciando aprendizado para usuário ${userId} (analisando ${limite} clientes)`);

        try {
            // 1. Buscar clientes do Tramitação (paginado)
            const clientes = await this.buscarClientesParaAnalise(limite);

            if (clientes.length === 0) {
                logger.info(`[PadroesEtiquetas] Nenhum cliente encontrado para análise`);
                return null;
            }

            logger.info(`[PadroesEtiquetas] ${clientes.length} clientes obtidos para análise`);

            // 2. Analisar etiquetas de cada cliente
            const analise = await this.analisarEtiquetas(clientes);

            // 3. Identificar padrões
            const padroes = this.identificarPadroes(analise, clientes.length);

            // 4. Salvar no banco
            await this.salvarPadroes(userId, padroes, clientes.length);

            // 5. Atualizar cache
            const padraoFinal = await this.buscarPadraoDoBanco(userId);
            if (padraoFinal) {
                this.cachePatroes.set(userId, padraoFinal);
                this.cacheTimestamps.set(userId, Date.now());
            }

            logger.info(`[PadroesEtiquetas] Aprendizado concluído para usuário ${userId}`);
            return padraoFinal;

        } catch (error: any) {
            logger.error(`[PadroesEtiquetas] Erro no aprendizado: ${error.message}`);
            return null;
        }
    }

    /**
     * Busca clientes do Tramitação para análise
     */
    private async buscarClientesParaAnalise(limite: number): Promise<any[]> {
        if (!this.tramitacaoService) {
            throw new Error('TramitacaoService não configurado');
        }

        const clientes: any[] = [];
        let pagina = 1;
        const porPagina = 100;

        while (clientes.length < limite) {
            try {
                const response = await (this.tramitacaoService as any).client.get('/clientes', {
                    params: {
                        page: pagina,
                        per_page: Math.min(porPagina, limite - clientes.length)
                    }
                });

                const dados = response.data?.customers || response.data || [];

                if (dados.length === 0) break;

                clientes.push(...dados);

                // Verificar se tem mais páginas
                const pagination = response.data?.pagination;
                if (!pagination || pagina >= pagination.pages) break;

                pagina++;
            } catch (error: any) {
                logger.warn(`[PadroesEtiquetas] Erro ao buscar página ${pagina}: ${error.message}`);
                break;
            }
        }

        return clientes.slice(0, limite);
    }

    /**
     * Analisa as etiquetas de todos os clientes
     */
    private async analisarEtiquetas(clientes: any[]): Promise<{
        frequenciaTags: Map<string, number>;
        tagsPorCliente: Map<string, string[]>;
    }> {
        const frequenciaTags: Map<string, number> = new Map();
        const tagsPorCliente: Map<string, string[]> = new Map();

        for (const cliente of clientes) {
            const clienteId = cliente.id?.toString() || cliente.customer?.id?.toString();
            if (!clienteId) continue;

            // Extrair tags do cliente
            const tags = this.extrairTagsDoCliente(cliente);
            tagsPorCliente.set(clienteId, tags);

            // Contar frequência
            for (const tag of tags) {
                const tagNorm = tag.toUpperCase().trim();
                frequenciaTags.set(tagNorm, (frequenciaTags.get(tagNorm) || 0) + 1);
            }
        }

        return { frequenciaTags, tagsPorCliente };
    }

    /**
     * Extrai nomes das tags de um cliente
     */
    private extrairTagsDoCliente(cliente: any): string[] {
        const tags = cliente.tags || cliente.customer?.tags || [];

        return tags.map((tag: any) => {
            if (typeof tag === 'string') return tag;
            if (tag?.name) return tag.name;
            return '';
        }).filter(Boolean);
    }

    /**
     * Identifica os padrões a partir da análise de frequência
     */
    private identificarPadroes(
        analise: { frequenciaTags: Map<string, number>; tagsPorCliente: Map<string, string[]> },
        totalClientes: number
    ): {
        mapeamentoBeneficios: Record<string, string>;
        etiquetasStatus: string[];
        etiquetasFase: string[];
        etiquetasResponsaveis: string[];
        etiquetasSistema: string[];
    } {
        const { frequenciaTags } = analise;
        const frequenciaMinima = 0.15; // 15% dos clientes

        // Ordenar tags por frequência
        const tagsOrdenadas = Array.from(frequenciaTags.entries())
            .map(([tag, count]) => ({ tag, count, frequencia: count / totalClientes }))
            .sort((a, b) => b.count - a.count);

        // Identificar mapeamento de benefícios
        const mapeamentoBeneficios: Record<string, string> = {};

        for (const [beneficioPadrao, variacoes] of Object.entries(BENEFICIOS_INSS_PADROES)) {
            // Encontrar qual variação o escritório usa
            for (const { tag, frequencia } of tagsOrdenadas) {
                if (variacoes.some(v => tag.toUpperCase().includes(v.toUpperCase()))) {
                    if (frequencia >= frequenciaMinima) {
                        mapeamentoBeneficios[beneficioPadrao] = tag;
                        break;
                    }
                }
            }
        }

        // Identificar tags de status usadas
        const etiquetasStatus = tagsOrdenadas
            .filter(({ tag, frequencia }) =>
                frequencia >= frequenciaMinima &&
                TAGS_STATUS_CONHECIDAS.some(s => tag.toUpperCase().includes(s.toUpperCase()))
            )
            .map(({ tag }) => tag);

        // Identificar tags de fase usadas
        const etiquetasFase = tagsOrdenadas
            .filter(({ tag, frequencia }) =>
                frequencia >= frequenciaMinima &&
                TAGS_FASE_CONHECIDAS.some(f => tag.toUpperCase().includes(f.toUpperCase()))
            )
            .map(({ tag }) => tag);

        // Identificar possíveis responsáveis (tags frequentes que não são benefícios/status/fase)
        // Geralmente são nomes de pessoas ou departamentos
        const etiquetasResponsaveis = tagsOrdenadas
            .filter(({ tag, frequencia }) => {
                const tagUpper = tag.toUpperCase();

                // Não é benefício
                const ehBeneficio = Object.values(BENEFICIOS_INSS_PADROES)
                    .flat()
                    .some(v => tagUpper.includes(v.toUpperCase()));

                // Não é status
                const ehStatus = TAGS_STATUS_CONHECIDAS.some(s => tagUpper.includes(s.toUpperCase()));

                // Não é fase
                const ehFase = TAGS_FASE_CONHECIDAS.some(f => tagUpper.includes(f.toUpperCase()));

                // Não é tag comum conhecida
                const tagsComuns = ['CLIENTE_INSS', 'ESCRITORIO', 'ESCRITÓRIO', 'OUTROS'];
                const ehComum = tagsComuns.some(c => tagUpper.includes(c));

                return frequencia >= frequenciaMinima && !ehBeneficio && !ehStatus && !ehFase && !ehComum;
            })
            .slice(0, 20) // Máximo 20 possíveis responsáveis
            .map(({ tag }) => tag);

        // Montar lista completa de etiquetas do sistema
        const etiquetasSistema = [
            ...Object.values(mapeamentoBeneficios),
            ...etiquetasStatus,
            ...etiquetasFase,
            ...etiquetasResponsaveis,
            'CLIENTE_INSS' // Sempre incluir
        ].filter((v, i, a) => a.indexOf(v) === i); // Remover duplicatas

        logger.info(`[PadroesEtiquetas] Padrões identificados:`);
        logger.info(`  - Benefícios mapeados: ${Object.keys(mapeamentoBeneficios).length}`);
        logger.info(`  - Status: ${etiquetasStatus.length}`);
        logger.info(`  - Fases: ${etiquetasFase.length}`);
        logger.info(`  - Responsáveis: ${etiquetasResponsaveis.length}`);
        logger.info(`  - Total sistema: ${etiquetasSistema.length}`);

        return {
            mapeamentoBeneficios,
            etiquetasStatus,
            etiquetasFase,
            etiquetasResponsaveis,
            etiquetasSistema
        };
    }

    /**
     * Salva os padrões no banco de dados
     */
    private async salvarPadroes(
        userId: string,
        padroes: {
            mapeamentoBeneficios: Record<string, string>;
            etiquetasStatus: string[];
            etiquetasFase: string[];
            etiquetasResponsaveis: string[];
            etiquetasSistema: string[];
        },
        totalClientes: number
    ): Promise<void> {
        const query = `
            INSERT INTO padroes_etiquetas_escritorio (
                user_id,
                mapeamento_beneficios,
                etiquetas_status,
                etiquetas_fase,
                etiquetas_responsaveis,
                etiquetas_sistema,
                total_clientes_analisados,
                ultima_atualizacao
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
            ON CONFLICT (user_id) DO UPDATE SET
                mapeamento_beneficios = $2,
                etiquetas_status = $3,
                etiquetas_fase = $4,
                etiquetas_responsaveis = $5,
                etiquetas_sistema = $6,
                total_clientes_analisados = $7,
                ultima_atualizacao = NOW()
        `;

        await Database.query(query, [
            userId,
            JSON.stringify(padroes.mapeamentoBeneficios),
            padroes.etiquetasStatus,
            padroes.etiquetasFase,
            padroes.etiquetasResponsaveis,
            padroes.etiquetasSistema,
            totalClientes
        ]);
    }

    /**
     * Busca o padrão do banco de dados
     */
    private async buscarPadraoDoBanco(userId: string): Promise<PadraoEscritorio | null> {
        const query = `
            SELECT * FROM padroes_etiquetas_escritorio
            WHERE user_id = $1
        `;

        const resultado = await Database.query(query, [userId]);

        if (resultado.length === 0) return null;

        const row = resultado[0];
        return {
            userId: row.user_id,
            mapeamentoBeneficios: row.mapeamento_beneficios || {},
            etiquetasStatus: row.etiquetas_status || [],
            etiquetasFase: row.etiquetas_fase || [],
            etiquetasResponsaveis: row.etiquetas_responsaveis || [],
            etiquetasSistema: row.etiquetas_sistema || [],
            etiquetasObrigatorias: row.etiquetas_obrigatorias || ['CLIENTE_INSS'],
            totalClientesAnalisados: row.total_clientes_analisados || 0,
            ultimaAtualizacao: new Date(row.ultima_atualizacao)
        };
    }

    /**
     * Verifica se uma etiqueta é do sistema (não é manual)
     */
    isEtiquetaSistema(etiqueta: string, padrao: PadraoEscritorio): boolean {
        const etiquetaUpper = etiqueta.toUpperCase().trim();

        // Verificar se está na lista de etiquetas do sistema
        const sistemaNorm = padrao.etiquetasSistema.map(e => e.toUpperCase().trim());
        if (sistemaNorm.includes(etiquetaUpper)) {
            return true;
        }

        // Verificar se é uma etiqueta de status conhecida (global)
        if (TAGS_STATUS_CONHECIDAS.some(s => etiquetaUpper.includes(s.toUpperCase()))) {
            return true;
        }

        // Verificar se é uma etiqueta de fase conhecida (global)
        if (TAGS_FASE_CONHECIDAS.some(f => etiquetaUpper.includes(f.toUpperCase()))) {
            return true;
        }

        return false;
    }

    /**
     * Mapeia um benefício do INSS para a etiqueta usada pelo escritório
     * Usa mapeamento estatístico primeiro, depois IA como fallback
     */
    mapearBeneficio(beneficioINSS: string, padrao: PadraoEscritorio): string | null {
        const beneficioNorm = beneficioINSS.toUpperCase().replace(/\s+/g, '_');

        // 1. Tentar encontrar mapeamento direto no padrão aprendido
        for (const [padraoBeneficio, etiquetaEscritorio] of Object.entries(padrao.mapeamentoBeneficios)) {
            const variacoes = BENEFICIOS_INSS_PADROES[padraoBeneficio] || [];

            for (const variacao of variacoes) {
                if (beneficioNorm.includes(variacao.toUpperCase())) {
                    return etiquetaEscritorio;
                }
            }
        }

        // 2. Fallback: tentar match por palavras-chave conhecidas
        if (beneficioNorm.includes('BPC') || beneficioNorm.includes('LOAS') || beneficioNorm.includes('ASSISTENCIAL') || beneficioNorm.includes('AMPARO')) {
            return padrao.mapeamentoBeneficios['BPC_LOAS'] || null;
        }
        if (beneficioNorm.includes('IDADE')) {
            return padrao.mapeamentoBeneficios['APOSENTADORIA_IDADE'] || null;
        }
        if (beneficioNorm.includes('TEMPO') || beneficioNorm.includes('CONTRIBUI')) {
            return padrao.mapeamentoBeneficios['APOSENTADORIA_TEMPO'] || null;
        }
        if (beneficioNorm.includes('INVALIDEZ')) {
            return padrao.mapeamentoBeneficios['APOSENTADORIA_INVALIDEZ'] || null;
        }
        if (beneficioNorm.includes('DOENCA') || beneficioNorm.includes('DOENÇA') || beneficioNorm.includes('INCAPACIDADE')) {
            return padrao.mapeamentoBeneficios['AUXILIO_DOENCA'] || null;
        }
        if (beneficioNorm.includes('PENSAO') || beneficioNorm.includes('PENSÃO') || beneficioNorm.includes('MORTE')) {
            return padrao.mapeamentoBeneficios['PENSAO_MORTE'] || null;
        }
        if (beneficioNorm.includes('MATERNIDADE')) {
            return padrao.mapeamentoBeneficios['SALARIO_MATERNIDADE'] || null;
        }

        // Não encontrou por estatística - retorna null (IA será chamada de forma assíncrona separadamente)
        return null;
    }

    /**
     * Mapeia benefício usando IA como fallback (quando estatística falha)
     * Método assíncrono para ser chamado quando mapearBeneficio retornar null
     */
    async mapearBeneficioComIA(
        beneficioINSS: string,
        padrao: PadraoEscritorio,
        aiService: AIService
    ): Promise<{ etiqueta: string | null; usouIA: boolean; confianca: number }> {
        // Primeiro tenta o mapeamento estatístico
        const resultadoEstatistico = this.mapearBeneficio(beneficioINSS, padrao);

        if (resultadoEstatistico) {
            return { etiqueta: resultadoEstatistico, usouIA: false, confianca: 1.0 };
        }

        // Se não encontrou, usa IA
        logger.info(`[PadroesEtiquetas] Mapeamento estatístico falhou para "${beneficioINSS}", usando IA...`);

        // Montar lista de etiquetas do escritório para a IA analisar
        const etiquetasDisponiveis = [
            ...Object.values(padrao.mapeamentoBeneficios),
            ...padrao.etiquetasSistema
        ].filter((v, i, a) => a.indexOf(v) === i); // Remover duplicatas

        if (etiquetasDisponiveis.length === 0) {
            logger.warn('[PadroesEtiquetas] Nenhuma etiqueta disponível para classificação por IA');
            return { etiqueta: null, usouIA: true, confianca: 0 };
        }

        try {
            const resultadoIA = await aiService.classificarEtiquetaBeneficio(
                beneficioINSS,
                etiquetasDisponiveis
            );

            if (resultadoIA.etiqueta && resultadoIA.confianca >= 0.7) {
                logger.info(`[PadroesEtiquetas] IA classificou: "${beneficioINSS}" → "${resultadoIA.etiqueta}" (confiança: ${resultadoIA.confianca})`);

                // Salvar no mapeamento para próximas vezes (aprendizado contínuo)
                await this.salvarMapeamentoAprendido(
                    padrao.userId,
                    beneficioINSS,
                    resultadoIA.etiqueta
                );

                return {
                    etiqueta: resultadoIA.etiqueta,
                    usouIA: true,
                    confianca: resultadoIA.confianca
                };
            } else {
                logger.info(`[PadroesEtiquetas] IA não conseguiu classificar com confiança suficiente`);
                return { etiqueta: null, usouIA: true, confianca: resultadoIA.confianca };
            }
        } catch (error: any) {
            logger.error(`[PadroesEtiquetas] Erro ao usar IA: ${error.message}`);
            return { etiqueta: null, usouIA: true, confianca: 0 };
        }
    }

    /**
     * Salva um mapeamento aprendido via IA no banco para uso futuro
     */
    private async salvarMapeamentoAprendido(
        userId: string,
        beneficioINSS: string,
        etiqueta: string
    ): Promise<void> {
        try {
            // Normalizar nome do benefício para key
            const beneficioKey = beneficioINSS.toUpperCase()
                .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                .replace(/[^A-Z0-9]/g, '_')
                .replace(/_+/g, '_');

            const query = `
                UPDATE padroes_etiquetas_escritorio
                SET mapeamento_beneficios = mapeamento_beneficios || $2::jsonb,
                    updated_at = NOW()
                WHERE user_id = $1
            `;

            const novoMapeamento = { [beneficioKey]: etiqueta };
            await Database.query(query, [userId, JSON.stringify(novoMapeamento)]);

            logger.info(`[PadroesEtiquetas] Mapeamento salvo: ${beneficioKey} → ${etiqueta}`);

            // Limpar cache para forçar reload
            this.limparCache(userId);
        } catch (error: any) {
            logger.error(`[PadroesEtiquetas] Erro ao salvar mapeamento: ${error.message}`);
        }
    }

    /**
     * Limpa o cache de um escritório (forçar recarregar do banco)
     */
    limparCache(userId?: string): void {
        if (userId) {
            this.cachePatroes.delete(userId);
            this.cacheTimestamps.delete(userId);
        } else {
            this.cachePatroes.clear();
            this.cacheTimestamps.clear();
        }
    }
}

export default new PadroesEtiquetasService();

