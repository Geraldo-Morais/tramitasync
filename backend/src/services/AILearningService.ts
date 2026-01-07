/**
 * SERVIÇO DE APRENDIZADO CONTÍNUO PARA IA
 * 
 * Armazena e utiliza histórico de análises de exigências para melhorar precisão
 * 
 * Funcionalidades:
 * 1. Registrar todas as análises feitas pela IA
 * 2. Buscar exemplos similares para usar como contexto
 * 3. Validar análises para melhorar aprendizado
 * 4. Usar exemplos mais relevantes nos prompts (sem exceder tokens)
 */

import Database from '../database';
import logger from '../utils/logger';

interface ExigenciaHistorico {
    id: string;
    protocolo_inss: string;
    texto_bruto: string;
    classe_final: string;
    motivo_ia: string;
    documentos_exigidos: string[];
    confianca: number;
    validado: boolean;
    created_at: Date;
}

interface ExemploSimilar {
    texto_bruto: string;
    classe_final: string;
    motivo_ia: string;
    documentos_exigidos: string[];
    similaridade: number;
}

class AILearningService {
    /**
     * Registra uma análise de exigência no histórico (Logger robusto de dataset)
     * Tratamento de erro silencioso: NUNCA trava o fluxo principal
     */
    async registrarAnalise(dados: {
        protocolo: string;
        textoBruto: string;
        classeFinal: string;
        motivoIA: string;
        documentosExigidos: string[];
        confianca: number;
    }): Promise<string | null> {
        try {
            // Garantir que textoBruto está completo (não truncado)
            const textoBrutoCompleto = dados.textoBruto || '';
            if (!textoBrutoCompleto || textoBrutoCompleto.trim().length === 0) {
                logger.warn(`[AILearning] ⚠️ Texto bruto vazio para protocolo ${dados.protocolo}, pulando registro`);
                return null;
            }

            // Log do tamanho do texto para debug
            const tamanhoTexto = textoBrutoCompleto.length;
            logger.info(`[AILearning] 💾 Salvando dataset: Protocolo ${dados.protocolo} (${tamanhoTexto} caracteres)`);

            // Garantir que documentos_exigidos seja um array válido ou NULL
            // PostgreSQL aceita arrays diretamente, não precisa JSON.stringify
            const documentosExigidosArray = dados.documentosExigidos && dados.documentosExigidos.length > 0
                ? dados.documentosExigidos
                : null;

            const result = await Database.query(`
                INSERT INTO exigencias_ia_historico (
                    protocolo_inss, texto_bruto, classe_final, motivo_ia,
                    documentos_exigidos, confianca, validado
                ) VALUES ($1, $2, $3, $4, $5, $6, true)
                RETURNING id
            `, [
                dados.protocolo,
                textoBrutoCompleto, // Texto completo garantido
                dados.classeFinal,
                dados.motivoIA,
                documentosExigidosArray, // Array direto (PostgreSQL converte automaticamente)
                dados.confianca
            ]);

            const id = result[0]?.id;
            logger.info(`[AILearning] 💾 Dataset atualizado: Protocolo ${dados.protocolo} salvo para treinamento futuro (ID: ${id})`);
            return id || null;
        } catch (error: any) {
            // Tratamento de erro SILENCIOSO: não travar fluxo principal
            // Apenas logar erro sem propagar exceção
            logger.warn(`[AILearning] ⚠️ Erro ao salvar dataset (não crítico, continuando): ${error.message}`);
            logger.warn(`[AILearning] ⚠️ Stack: ${error.stack?.substring(0, 200)}`);
            // Retornar null sem propagar erro
            return null;
        }
    }

    /**
     * Busca exemplos similares de exigências anteriores
     * Usa busca full-text e similaridade de palavras-chave
     * 
     * @param textoBruto Texto da exigência atual
     * @param limite Máximo de exemplos a retornar (padrão: 5)
     * @param minConfianca Confiança mínima dos exemplos (padrão: 0.7)
     * @returns Array de exemplos similares ordenados por relevância
     */
    async buscarExemplosSimilares(
        textoBruto: string,
        limite: number = 5,
        minConfianca: number = 0.7
    ): Promise<ExemploSimilar[]> {
        try {
            // Extrair palavras-chave do texto (remover stopwords comuns)
            const palavrasChave = this.extrairPalavrasChave(textoBruto);

            if (palavrasChave.length === 0) {
                logger.warn('[AILearning] ⚠️ Nenhuma palavra-chave extraída, retornando exemplos gerais');
                return await this.buscarExemplosGerais(limite, minConfianca);
            }

            // Buscar usando similaridade de texto (PostgreSQL tsvector)
            const query = `
                SELECT 
                    texto_bruto,
                    classe_final,
                    motivo_ia,
                    documentos_exigidos,
                    confianca,
                    ts_rank(
                        to_tsvector('portuguese', texto_bruto),
                        plainto_tsquery('portuguese', $1)
                    ) as similaridade
                FROM exigencias_ia_historico
                WHERE 
                    confianca >= $2
                    AND (validado = true OR validado IS NULL)
                    AND to_tsvector('portuguese', texto_bruto) @@ plainto_tsquery('portuguese', $1)
                ORDER BY similaridade DESC, confianca DESC, created_at DESC
                LIMIT $3
            `;

            const termosBusca = palavrasChave.join(' & ');
            const result = await Database.query(query, [termosBusca, minConfianca, limite]);

            const exemplos: ExemploSimilar[] = result.map((row: any) => ({
                texto_bruto: row.texto_bruto,
                classe_final: row.classe_final,
                motivo_ia: row.motivo_ia,
                documentos_exigidos: Array.isArray(row.documentos_exigidos)
                    ? row.documentos_exigidos
                    : JSON.parse(row.documentos_exigidos || '[]'),
                similaridade: parseFloat(row.similaridade) || 0
            }));

            logger.info(`[AILearning] ✅ ${exemplos.length} exemplo(s) similar(es) encontrado(s)`);
            return exemplos;

        } catch (error: any) {
            logger.error(`[AILearning] ❌ Erro ao buscar exemplos similares: ${error.message}`);
            // Fallback: buscar exemplos gerais
            return await this.buscarExemplosGerais(limite, minConfianca);
        }
    }

    /**
     * Busca exemplos gerais (quando não há similaridade específica)
     */
    private async buscarExemplosGerais(
        limite: number = 5,
        minConfianca: number = 0.7
    ): Promise<ExemploSimilar[]> {
        try {
            const result = await Database.query(`
                SELECT 
                    texto_bruto,
                    classe_final,
                    motivo_ia,
                    documentos_exigidos,
                    confianca,
                    0.5 as similaridade
                FROM exigencias_ia_historico
                WHERE 
                    confianca >= $1
                    AND (validado = true OR validado IS NULL)
                ORDER BY confianca DESC, created_at DESC
                LIMIT $2
            `, [minConfianca, limite]);

            return result.map((row: any) => ({
                texto_bruto: row.texto_bruto,
                classe_final: row.classe_final,
                motivo_ia: row.motivo_ia,
                documentos_exigidos: Array.isArray(row.documentos_exigidos)
                    ? row.documentos_exigidos
                    : JSON.parse(row.documentos_exigidos || '[]'),
                similaridade: 0.5
            }));
        } catch (error: any) {
            logger.error(`[AILearning] ❌ Erro ao buscar exemplos gerais: ${error.message}`);
            return [];
        }
    }

    /**
     * Extrai palavras-chave relevantes do texto
     * Remove stopwords e retorna termos mais significativos
     */
    private extrairPalavrasChave(texto: string): string[] {
        const stopwords = [
            'a', 'o', 'e', 'de', 'do', 'da', 'em', 'no', 'na', 'para', 'por', 'com',
            'que', 'é', 'são', 'foi', 'ser', 'ter', 'ter', 'fazer', 'solicitar',
            'apresentar', 'enviar', 'preencher', 'atualizar', 'documento', 'documentos'
        ];

        // Normalizar e tokenizar
        const palavras = texto
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^\w\s]/g, ' ')
            .split(/\s+/)
            .filter(p => p.length > 3) // Palavras com mais de 3 caracteres
            .filter(p => !stopwords.includes(p));

        // Remover duplicatas e retornar até 10 palavras mais relevantes
        const unicas = [...new Set(palavras)];
        return unicas.slice(0, 10);
    }

    /**
     * Valida uma análise (marcar como correta/incorreta)
     * Isso ajuda o sistema a aprender quais análises são mais confiáveis
     */
    async validarAnalise(
        historicoId: string,
        validado: boolean,
        validadoPor: string,
        observacoes?: string
    ): Promise<boolean> {
        try {
            await Database.query(`
                UPDATE exigencias_ia_historico
                SET 
                    validado = $1,
                    validado_por = $2,
                    validado_em = NOW(),
                    observacoes_validacao = $3,
                    updated_at = NOW()
                WHERE id = $4
            `, [validado, validadoPor, observacoes || null, historicoId]);

            logger.info(`[AILearning] ✅ Análise ${historicoId} validada: ${validado ? 'CORRETA' : 'INCORRETA'}`);
            return true;
        } catch (error: any) {
            logger.error(`[AILearning] ❌ Erro ao validar análise: ${error.message}`);
            return false;
        }
    }

    /**
     * Formata exemplos similares para incluir no prompt da IA
     * Limita tamanho para não exceder tokens
     */
    formatarExemplosParaPrompt(exemplos: ExemploSimilar[], maxTokens: number = 1000): string {
        if (exemplos.length === 0) {
            return '';
        }

        let texto = '\n\nEXEMPLOS DE ANÁLISES SIMILARES (para referência):\n\n';
        let tokensUsados = 0;

        for (const exemplo of exemplos) {
            const exemploTexto = `
Exemplo ${exemplos.indexOf(exemplo) + 1}:
Texto: "${exemplo.texto_bruto.substring(0, 200)}..."
Classe: ${exemplo.classe_final}
Documentos: ${exemplo.documentos_exigidos.join(', ')}
---
`;

            const tokensExemplo = exemploTexto.length / 4; // Aproximação: 1 token ≈ 4 caracteres

            if (tokensUsados + tokensExemplo > maxTokens) {
                break;
            }

            texto += exemploTexto;
            tokensUsados += tokensExemplo;
        }

        return texto;
    }

    /**
     * Estatísticas do sistema de aprendizado
     */
    async obterEstatisticas(): Promise<{
        totalAnalises: number;
        analisesValidadas: number;
        taxaValidacao: number;
        confiancaMedia: number;
        classesMaisComuns: Array<{ classe: string; quantidade: number }>;
    }> {
        try {
            const stats = await Database.query(`
                SELECT 
                    COUNT(*) as total,
                    COUNT(*) FILTER (WHERE validado = true) as validadas,
                    AVG(confianca) as confianca_media
                FROM exigencias_ia_historico
            `);

            const classes = await Database.query(`
                SELECT 
                    classe_final,
                    COUNT(*) as quantidade
                FROM exigencias_ia_historico
                GROUP BY classe_final
                ORDER BY quantidade DESC
                LIMIT 10
            `);

            const total = parseInt(stats[0]?.total || '0');
            const validadas = parseInt(stats[0]?.validadas || '0');
            const confiancaMedia = parseFloat(stats[0]?.confianca_media || '0');

            return {
                totalAnalises: total,
                analisesValidadas: validadas,
                taxaValidacao: total > 0 ? (validadas / total) * 100 : 0,
                confiancaMedia: confiancaMedia,
                classesMaisComuns: classes.map((r: any) => ({
                    classe: r.classe_final,
                    quantidade: parseInt(r.quantidade)
                }))
            };
        } catch (error: any) {
            logger.error(`[AILearning] ❌ Erro ao obter estatísticas: ${error.message}`);
            return {
                totalAnalises: 0,
                analisesValidadas: 0,
                taxaValidacao: 0,
                confiancaMedia: 0,
                classesMaisComuns: []
            };
        }
    }
}

export default new AILearningService();
