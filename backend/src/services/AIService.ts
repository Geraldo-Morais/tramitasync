import config from '../config';
import logger from '../utils/logger';
import aiLearningService from './AILearningService';

interface ResultadoAnaliseIA {
    classe_final:
    | 'DEFERIDO'
    | 'INDEFERIDO'
    | 'EXIGENCIA'
    | 'PERICIA'
    | 'RECURSO'
    | 'CANCELADO'
    | 'EM_ANALISE'
    | 'PENDENTE'
    | 'DUPLICADO';
    motivo_ia: string;
    documentos_exigidos?: string[];
    data_evento?: Date;
    confianca: number;
    tipo_indeferimento?: 'CULPA' | 'MERITO'; // Novo campo: classificação do tipo de indeferimento
}

/**
 * Serviço de Inteligência Artificial
 * Responsável por analisar textos do INSS e extrair informações estruturadas
 * usando o Google Gemini AI
 */
export class AIService {
    private apiKey: string;
    private model: string;
    private captchaModel: string;

    constructor(apiKey?: string) {
        // ⚠️ SEGURANÇA: NUNCA usar fallback de API key padrão em produção
        // API key deve ser sempre fornecida pelo usuário
        // Warnings só serão exibidos quando o serviço for realmente usado sem credenciais
        this.apiKey = apiKey || '';
        this.model = config.gemini.model || 'gemini-2.0-flash';
        this.captchaModel = config.gemini.captchaModel || 'gemini-2.0-flash-lite';
    }

    /**
     * Define uma nova API key dinamicamente
     * Útil para usar credenciais específicas de cada usuário
     */
    setApiKey(apiKey: string): void {
        if (!apiKey || apiKey.trim() === '') {
            logger.warn('[AIService] Tentativa de definir API key vazia, mantendo atual');
            return;
        }
        this.apiKey = apiKey.trim();
        logger.info('[AIService] API key atualizada dinamicamente');
    }

    /**
     * Analisa o texto bruto extraído do INSS
     * @param textoInss Texto completo da página de detalhes do protocolo INSS OU array dos últimos 3 cards com contexto
     * @param protocolo Número do protocolo (para contexto)
     * @param dataNascimento Data de nascimento do requerente (DD/MM/YYYY) para verificar se é menor
     * @returns Análise estruturada com classe_final, motivo, documentos e data
     */
    async analisarTextoInss(
        textoInss: string | Array<{ data: string; texto: string }>,
        protocolo: string,
        dataNascimento?: string
    ): Promise<ResultadoAnaliseIA> {
        try {
            logger.info(`[AIService] Analisando protocolo ${protocolo}`);

            // Processar texto: se for array de cards, montar contexto com últimos 3
            let textoParaAnalise: string;
            if (Array.isArray(textoInss)) {
                // Pegar últimos 3 cards (mais recentes)
                const ultimosCards = textoInss.slice(-3).reverse(); // Reverter para ordem cronológica (mais antigo primeiro)
                textoParaAnalise = ultimosCards.map((card, idx) => {
                    return `[CARD ${ultimosCards.length - idx} - ${card.data}]:\n${card.texto}`;
                }).join('\n\n---\n\n');
                logger.info(`[AIService] 📋 Analisando últimos ${ultimosCards.length} card(s) com contexto completo`);
            } else {
                textoParaAnalise = textoInss;
            }

            // Verificar se é menor de 18 anos
            let ehMenor = false;
            if (dataNascimento) {
                try {
                    const [dia, mes, ano] = dataNascimento.split('/').map(Number);
                    const dataNasc = new Date(ano, mes - 1, dia);
                    const hoje = new Date();
                    const idade = hoje.getFullYear() - dataNasc.getFullYear() -
                        (hoje.getMonth() < dataNasc.getMonth() ||
                            (hoje.getMonth() === dataNasc.getMonth() && hoje.getDate() < dataNasc.getDate()) ? 1 : 0);
                    ehMenor = idade < 18;
                    if (ehMenor) {
                        logger.info(`[AIService] 👶 Requerente é menor de idade (${idade} anos)`);
                    }
                } catch (error) {
                    logger.warn(`[AIService] ⚠️ Erro ao calcular idade: ${error}`);
                }
            }

            // 🔥 DESATIVADO: Busca de exemplos similares (Zero-Shot Learning)
            // Focando em análise pura sem viés de exemplos passados
            // logger.info('[AIService] 🔍 Buscando exemplos similares no histórico...');
            // const exemplosSimilares = await aiLearningService.buscarExemplosSimilares(textoParaAnalise, 3, 0.7);
            const exemplosSimilares: any[] = []; // Array vazio - não usar exemplos

            // Prompt otimizado para Gemini (Zero-Shot: sem exemplos)
            const prompt = this.buildPrompt(textoParaAnalise, protocolo, exemplosSimilares, ehMenor);

            // Chamada à API do Google Gemini
            const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        contents: [
                            {
                                parts: [
                                    {
                                        text: prompt,
                                    },
                                ],
                            },
                        ],
                        generationConfig: {
                            temperature: 0.1, // Temperatura muito baixa para respostas consistentes
                            topK: 20,
                            topP: 0.8,
                            maxOutputTokens: 2048,
                            responseMimeType: 'application/json', // Forçar resposta JSON
                        },
                        safetySettings: [
                            {
                                category: 'HARM_CATEGORY_HARASSMENT',
                                threshold: 'BLOCK_NONE',
                            },
                            {
                                category: 'HARM_CATEGORY_HATE_SPEECH',
                                threshold: 'BLOCK_NONE',
                            },
                            {
                                category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
                                threshold: 'BLOCK_NONE',
                            },
                            {
                                category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
                                threshold: 'BLOCK_NONE',
                            },
                        ],
                    }),
                }
            );

            if (!response.ok) {
                throw new Error(`Gemini API error: ${response.statusText}`);
            }

            const data: any = await response.json();
            const textoResposta =
                data.candidates?.[0]?.content?.parts?.[0]?.text || '';

            // Parse da resposta JSON do Gemini
            const resultado = this.parseRespostaIA(textoResposta);

            logger.info(
                `[AIService] Protocolo ${protocolo} analisado: ${resultado.classe_final} (confiança: ${resultado.confianca})`
            );

            // 🔥 Registrar análise no histórico para dataset futuro (Zero-Shot Learning)
            // Tratamento silencioso: não travar fluxo principal se falhar
            const textoBrutoCompleto = Array.isArray(textoInss) ? textoParaAnalise : textoInss;
            aiLearningService.registrarAnalise({
                protocolo,
                textoBruto: textoBrutoCompleto, // Texto completo garantido
                classeFinal: resultado.classe_final,
                motivoIA: resultado.motivo_ia,
                documentosExigidos: resultado.documentos_exigidos || [],
                confianca: resultado.confianca
            }).catch((error) => {
                // Erro já tratado silenciosamente no AILearningService
                // Apenas logar aqui para visibilidade
                logger.debug(`[AIService] Dataset não salvo (não crítico): ${error.message}`);
            });

            return resultado;
        } catch (error) {
            logger.error(`[AIService] Erro ao analisar protocolo ${protocolo}:`, error);

            // Fallback: retorna EM_ANALISE com baixa confiança
            return {
                classe_final: 'EM_ANALISE',
                motivo_ia: 'Erro na análise automática. Revisar manualmente.',
                confianca: 0,
            };
        }
    }

    /**
     * Constrói o prompt otimizado para o Gemini
     */
    private buildPrompt(textoInss: string, protocolo: string, exemplosSimilares: any[] = [], ehMenor: boolean = false): string {
        return `Você é um assistente jurídico especializado em análise de processos previdenciários do INSS com 10 anos de experiência.

Analise o texto abaixo, extraído do sistema INSS (protocolo ${protocolo}), e retorne APENAS um objeto JSON válido (sem blocos markdown, sem explicações adicionais).

${ehMenor ? '⚠️ ATENÇÃO: O requerente é MENOR DE 18 ANOS. Quando mencionar assinaturas, termos ou biometria, sempre indique que deve ser feito pelo REPRESENTANTE LEGAL do beneficiário, não pelo menor.\n\n' : ''}

CONTEXTO IMPORTANTE:
- O texto pode conter múltiplos cards (comentários) em ordem cronológica.
- Se o último card não contém a exigência real (ex: "tarefa transferida", "agendamento realizado"), analise os cards anteriores para encontrar a exigência real.
- Sempre priorize encontrar a EXIGÊNCIA REAL, mesmo que esteja em um card anterior ao último.
- Se o status é "Exigência", SEMPRE há uma exigência a ser cumprida - procure nos cards anteriores se necessário.

FORMATO DE SAÍDA (OBRIGATÓRIO):
{
  "classe_final": "EXIGENCIA|DEFERIDO|INDEFERIDO|PERICIA|RECURSO|CANCELADO|EM_ANALISE",
  "motivo_ia": "Explicação clara em 1-2 frases do status atual",
  "documentos_exigidos": ["doc1", "doc2", "doc3"] ou null,
  "data_evento": "YYYY-MM-DD" ou null,
  "confianca": 0.85,
  "tipo_indeferimento": "CULPA|MERITO" ou null (APENAS se classe_final for INDEFERIDO)
}

DIRETRIZES CRÍTICAS:
1. Escreva sempre em português jurídico simples.
2. "motivo_ia" deve ser UMA única frase de até 140 caracteres, focada no próximo passo para o cliente. Evite copiar trechos literais do texto do INSS.
3. Se for EXIGÊNCIA, mantenha "motivo_ia" no formato "Cumprir exigência: <resumo objetivo>".
4. "documentos_exigidos" deve conter no máximo 5 itens únicos, cada um com até 6 palavras (ex.: "Autodeclaração Rural (Meu INSS)").
5. Padronize documentos rurais conforme exemplos (Autodeclaração, DAP/ITR, Comprovantes rurais). Se o texto citar apenas a apresentação de autodeclaração rural, retorne somente esse item.
6. Normalize espaços extras, remova listas numeradas e não inclua títulos como "Documentos".
7. Ignore documentos condicionais (frases com "caso", "se for", "se indígena", "se pescador", "quilombola"). Liste apenas o que serve para todos os segurados do texto.
8. Descreva sempre uma ação concreta no "motivo_ia" (ex.: "Enviar Autodeclaração Rural pelo Meu INSS" ou "Anexar comprovantes rurais no portal").

REGRAS DE CLASSIFICAÇÃO (Prioridade decrescente):

1. DUPLICADO (MÁXIMA PRIORIDADE - palavras-chave: "já existe requerimento anterior", "processo duplicado", "duplicidade"):
   - Motivo: "Processo Duplicado, consultar número correto"
   - Confiança: 0.99

2. CANCELADO (palavras-chave: "cancelado", "excluído", "cancelamento", "exclusão"):
   - Motivo deve explicar razão do cancelamento
   - Confiança: 0.95

3. INDEFERIDO (palavras-chave: "indeferido", "negado", "não reconhecido o direito", "foi negado"):
   - **CLASSIFICAÇÃO OBRIGATÓRIA DO TIPO DE INDEFERIMENTO (tipo_indeferimento):**
     * Se o motivo indica CULPA DO CLIENTE/ESCRITÓRIO (falha processual) → "tipo_indeferimento": "CULPA"
       - Exemplos de CULPA:
         * "não compareceu", "ausência", "não comparecimento"
         * "não apresentou", "não cumpriu", "exigência não cumprida"
         * "prazo vencido", "desistência", "faltou"
         * "falta de documento", "documentação incompleta"
       - Ação: Nova entrada administrativa (mantém fase ADMINISTRATIVO)
     
     * Se o motivo indica CRITÉRIO/MÉRITO não atendido → "tipo_indeferimento": "MERITO"
       - Exemplos de MÉRITO:
         * "não reconheceu", "não comprovou", "não atende critério"
         * "renda", "miserabilidade", "deficiência não caracterizada"
         * "impedimento de longo prazo não", "não atende requisito"
         * "critério", "requisito", "incapacidade não", "não caracteriza"
       - Ação: Processo convertido para JUDICIAL
   
   - Sub-casos específicos:
     a) "não comparecimento à avaliação social" → Motivo: "Não compareceu à avaliação social" | tipo_indeferimento: "CULPA"
     b) "não comparecimento à perícia" ou "exame médico" → Motivo: "Não compareceu à perícia médica" | tipo_indeferimento: "CULPA"
     c) "exigência não cumprida" → Motivo: "Não cumpriu exigência no prazo" | tipo_indeferimento: "CULPA"
     d) "desistência escrita do titular" → Motivo: "Desistência do titular" | tipo_indeferimento: "CULPA"
     e) "não ficar comprovada a condição de trabalhador rural" ou "ausência de prova material" → Motivo: "Não comprovou atividade rural na carência" | tipo_indeferimento: "MERITO"
     f) "não ficar comprovada a condição de filiado ao RGPS" → Motivo: "Sem filiação ao RGPS na data do fato" | tipo_indeferimento: "MERITO"
     g) "não atende critério de renda" → Motivo: "Não atende critério de renda per capita" | tipo_indeferimento: "MERITO"
     h) "deficiência não caracterizada" → Motivo: "Deficiência não caracterizada conforme legislação" | tipo_indeferimento: "MERITO"
   - Motivo genérico: "Indeferido (genérico)" se não houver razão específica | tipo_indeferimento: "MERITO" (assumir mérito quando ambíguo)
   - Confiança: 0.95

4. DEFERIDO (palavras-chave: "deferido", "concedido", "aprovado", "benefício concedido", "foi reconhecido o direito"):
   - **IMPORTANTE:** Verificar que o texto NÃO contém "indeferido" (evitar falsos positivos)
   - Motivo: "Requerimento deferido. Benefício concedido."
   - Incluir tipo de benefício se mencionado
   - Confiança: 0.95

5. EXIGENCIA (palavras-chave: "exigência", "complementação", "documentação", "pendência", "prazo para cumprimento", "NR:", "Prezado(a) Senhor(a)"):
   - **CRÍTICO:** Se o último card não contém a exigência real (ex: "tarefa transferida", "agendamento realizado", "perícia agendada"), analise os cards anteriores para encontrar a exigência real.
   - Se o status é "Exigência", SEMPRE há uma exigência a ser cumprida - procure nos cards anteriores se necessário.
   - Extrair TODOS os documentos mencionados em uma lista limpa
   - **ESPECIFICIDADE:** Se a exigência menciona membros específicos da família (ex: "CPF do membro Y", "certidão de casamento do membro X"), mantenha essa especificidade. Não generalize.
   - **MENOR DE IDADE:** ${ehMenor ? 'Se mencionar biometria, assinatura ou termo, sempre indique que é do REPRESENTANTE LEGAL do beneficiário, não do menor.' : 'Se o requerente for menor de 18 anos, biometria e assinaturas são do representante legal.'}
   - **PRAZO (CRÍTICO):** 
     * Se o texto mencionar uma data específica de prazo (ex: "até 20/11/2025", "prazo até DD/MM/YYYY"), use essa data como "data_evento".
     * Se mencionar "30 dias" ou "prazo de 30 dias", calcule: DATA DO CARD + 30 dias = "data_evento".
     * Se mencionar prazo específico diferente (ex: "120 dias", "60 dias"), calcule: DATA DO CARD + número de dias mencionado = "data_evento".
     * Se não mencionar prazo específico, use: DATA DO CARD + 30 dias (padrão).
     * IMPORTANTE: A data do card está no formato "[CARD X - DD/MM/YYYY]". Use essa data como base para cálculo.
     * Exemplo: Se o card é "[CARD 1 - 07/08/2025]" e menciona "30 dias", então data_evento = "2025-09-06" (07/08/2025 + 30 dias).
   - Documentos devem ser nomes curtos e objetivos (ex: "Laudo médico atualizado", "Comprovante de renda")
   - Documentos comuns:
     a) "AUTODECLARAÇÃO DO SEGURADO ESPECIAL NO SISTEMA MEU INSS" → "Autodeclaração Rural (Meu INSS)"
     b) "CTPS" ou "carteira de trabalho" → "CTPS (todas as páginas, ordem cronológica)"
     c) "Registro Biométrico" ou "CIN" ou "CNH" ou "Título Eleitoral" → ${ehMenor ? '"Registro Biométrico do Representante Legal (CIN/Título/CNH)"' : '"Registro Biométrico (CIN/Título/CNH)"'}
     d) "Procuração" → "Procuração (Memorando-Circular 12/2015)"
     e) "DAP" ou "ITR" ou "INCRA" → "Provas rurais (DAP/ITR/INCRA/contratos)"
     f) "Termo de responsabilidade" → ${ehMenor ? '"Termo de responsabilidade preenchido e assinado pelo representante legal"' : '"Termo de responsabilidade preenchido e assinado"'}
   - Confiança: 0.95

6. PERICIA (palavras-chave: "perícia", "agendamento", "avaliação médica", "avaliação social", "comparecer"):
   - Extrair data/hora do agendamento para "data_evento" (formato YYYY-MM-DD)
   - Motivo deve incluir tipo de perícia (médica/social) e local se mencionado
   - Confiança: 0.90

7. EM_ANALISE (palavras-chave: "em análise", "aguardando", "processamento", "tramitação"):
   - Usar apenas se não houver nenhuma outra classificação clara
   - Motivo deve ser as últimas 2 frases do texto (resumo do último comentário)
   - Confiança baixa (0.5-0.7)

REGRA ESPECIAL - ORDEM DE LEITURA:
- Sempre leia o texto **DE TRÁS PARA FRENTE** (comentário mais recente primeiro)
- O último comentário tem prioridade sobre comentários antigos
- Se o último comentário for DEFERIDO mas um anterior for INDEFERIDO, classificar como DEFERIDO

EXEMPLOS DE SAÍDA:

Exemplo 1 - EXIGENCIA:
{
  "classe_final": "EXIGENCIA",
  "motivo_ia": "Documentação incompleta. Prazo de 30 dias para apresentar documentos complementares.",
  "documentos_exigidos": ["Autodeclaração Rural (Meu INSS)", "Provas rurais (DAP/ITR/INCRA/contratos)", "Documentos pessoais do grupo familiar"],
  "data_evento": "2025-12-05",
  "confianca": 0.95
}

Exemplo 2 - PERICIA:
{
  "classe_final": "PERICIA",
  "motivo_ia": "Perícia médica agendada para avaliação de incapacidade na APS Salvador.",
  "documentos_exigidos": null,
  "data_evento": "2025-11-20",
  "confianca": 0.98
}

Exemplo 3 - DEFERIDO:
{
  "classe_final": "DEFERIDO",
  "motivo_ia": "Benefício de Aposentadoria por Idade Rural concedido. Processo finalizado com sucesso.",
  "documentos_exigidos": null,
  "data_evento": null,
  "confianca": 0.99
}

Exemplo 4 - INDEFERIDO (não compareceu - CULPA):
{
  "classe_final": "INDEFERIDO",
  "motivo_ia": "Não compareceu à perícia médica agendada.",
  "documentos_exigidos": null,
  "data_evento": null,
  "confianca": 0.97,
  "tipo_indeferimento": "CULPA"
}

Exemplo 5 - INDEFERIDO (não comprovou - MERITO):
{
  "classe_final": "INDEFERIDO",
  "motivo_ia": "Não comprovou atividade rural na carência exigida. Ausência de prova material contemporânea.",
  "documentos_exigidos": null,
  "data_evento": null,
  "confianca": 0.96,
  "tipo_indeferimento": "MERITO"
}

Exemplo 6 - INDEFERIDO (exigência não cumprida - CULPA):
{
  "classe_final": "INDEFERIDO",
  "motivo_ia": "Não cumpriu exigência no prazo estipulado (30 dias).",
  "documentos_exigidos": null,
  "data_evento": null,
  "confianca": 0.95,
  "tipo_indeferimento": "CULPA"
}

Exemplo 6b - INDEFERIDO (não atende critério de renda - MERITO):
{
  "classe_final": "INDEFERIDO",
  "motivo_ia": "Não atende critério de renda per capita para BPC/LOAS.",
  "documentos_exigidos": null,
  "data_evento": null,
  "confianca": 0.95,
  "tipo_indeferimento": "MERITO"
}

Exemplo 7 - CANCELADO:
{
  "classe_final": "CANCELADO",
  "motivo_ia": "Processo cancelado/excluído pelo sistema.",
  "documentos_exigidos": null,
  "data_evento": null,
  "confianca": 0.95
}

Exemplo 8 - DUPLICADO:
{
  "classe_final": "DUPLICADO",
  "motivo_ia": "Processo duplicado. Já existe requerimento anterior para este benefício.",
  "documentos_exigidos": null,
  "data_evento": null,
  "confianca": 0.99
}

Exemplo 9 - EM_ANALISE:
{
  "classe_final": "EM_ANALISE",
  "motivo_ia": "Processo em análise pela equipe técnica. Aguardando decisão administrativa.",
  "documentos_exigidos": null,
  "data_evento": null,
  "confianca": 0.65
}

ATENÇÃO ESPECIAL:
- Se o texto mencionar "PREENCHER A AUTODECLARAÇÃO", incluir na lista de documentos
- Datas no formato DD/MM/YYYY devem ser convertidas para YYYY-MM-DD
- Se houver múltiplas exigências, listar todas separadamente
- Confiança deve refletir clareza do texto (texto ambíguo = confiança baixa)
- **CRÍTICO:** Se classe_final for INDEFERIDO, SEMPRE classificar tipo_indeferimento como CULPA ou MERITO

TEXTO DO INSS:
---
${textoInss}
---

Retorne APENAS o JSON limpo, sem blocos de código markdown, sem explicações.
    `;
    }

    /**
     * Faz o parse da resposta JSON da IA
     */
    private parseRespostaIA(textoResposta: string): ResultadoAnaliseIA {
        try {
            // Remove possíveis blocos de markdown ```json ... ```
            let jsonText = textoResposta.trim();

            if (jsonText.startsWith('```json')) {
                jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
            } else if (jsonText.startsWith('```')) {
                jsonText = jsonText.replace(/```\n?/g, '');
            }

            const parsed = JSON.parse(jsonText);

            // Conversão de data_evento para Date se existir
            if (parsed.data_evento) {
                parsed.data_evento = new Date(parsed.data_evento);
            }

            parsed.motivo_ia = this.normalizarMotivo(parsed.motivo_ia);

            if (Array.isArray(parsed.documentos_exigidos)) {
                const documentosNormalizados = this.normalizarDocumentos(
                    parsed.documentos_exigidos
                );
                parsed.documentos_exigidos =
                    documentosNormalizados.length > 0
                        ? documentosNormalizados
                        : null;
            }

            // Validar tipo_indeferimento se presente
            if (parsed.tipo_indeferimento && !['CULPA', 'MERITO'].includes(parsed.tipo_indeferimento)) {
                logger.warn(`[AIService] ⚠️ tipo_indeferimento inválido: ${parsed.tipo_indeferimento}. Removendo.`);
                delete parsed.tipo_indeferimento;
            }

            // Validação básica
            if (!parsed.classe_final || !parsed.motivo_ia) {
                throw new Error('Resposta da IA incompleta');
            }

            return parsed;
        } catch (error) {
            logger.error('[AIService] Erro ao fazer parse da resposta da IA:', error);
            logger.error('[AIService] Resposta recebida:', textoResposta);

            // Fallback
            return {
                classe_final: 'EM_ANALISE',
                motivo_ia: 'Erro ao interpretar resposta da IA',
                confianca: 0,
            };
        }
    }

    private normalizarMotivo(motivo?: string): string {
        if (typeof motivo !== 'string') {
            return 'Resumo indisponível';
        }

        const semQuebras = motivo.replace(/\s+/g, ' ').replace(/^[-\d).]+\s*/, '').trim();

        if (!semQuebras) {
            return 'Resumo indisponível';
        }

        if (semQuebras.length <= 140) {
            return semQuebras;
        }

        const primeiraFrase = semQuebras.match(/[^.!?]+[.!?]/)?.[0]?.trim();

        if (primeiraFrase && primeiraFrase.length <= 140) {
            return primeiraFrase;
        }

        return `${semQuebras.slice(0, 137).trimEnd().replace(/[,:;]$/, '')}…`;
    }

    private normalizarDocumentos(documentos: unknown[]): string[] {
        if (!Array.isArray(documentos)) {
            return [];
        }

        const vistos = new Set<string>();
        const resultado: string[] = [];

        for (const documento of documentos) {
            if (typeof documento !== 'string') {
                continue;
            }

            let texto = documento
                .replace(/\s+/g, ' ')
                .replace(/^[-\d).]+\s*/, '')
                .trim();

            if (!texto) {
                continue;
            }

            const textoLower = texto.toLowerCase();
            const termosCondicionais = [
                'caso ',
                'se ',
                'indígena',
                'pescador',
                'quilombola',
                'pessoa com deficiência',
                'somente se',
                'apenas se'
            ];

            if (termosCondicionais.some((termo) => textoLower.includes(termo))) {
                continue;
            }

            texto = this.limitarPalavras(texto, 6);

            if (texto.length > 80) {
                texto = `${texto.slice(0, 77).trimEnd()}…`;
            }

            const chave = texto
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .toLowerCase();

            if (vistos.has(chave)) {
                continue;
            }

            vistos.add(chave);
            resultado.push(texto);

            if (resultado.length >= 5) {
                break;
            }
        }

        return resultado;
    }

    private limitarPalavras(texto: string, maximoPalavras: number): string {
        const palavras = texto.split(' ').filter(Boolean);

        if (palavras.length <= maximoPalavras) {
            return palavras.join(' ');
        }

        return palavras.slice(0, maximoPalavras).join(' ');
    }

    /**
     * Valida se a API está configurada corretamente
     */
    isConfigured(): boolean {
        return !!this.apiKey && this.apiKey !== 'your-google-gemini-api-key';
    }

    /**
     * Classifica complexidade de uma exigência
     * @param descricaoExigencia Texto da exigência
     * @returns 'SIMPLES', 'MEDIA' ou 'COMPLEXA'
     */
    async classificarComplexidadeExigencia(
        descricaoExigencia: string
    ): Promise<'SIMPLES' | 'MEDIA' | 'COMPLEXA'> {
        try {
            logger.info('[AIService] Classificando complexidade da exigência');

            const prompt = `Você é um especialista em processos do INSS.

Analise a seguinte EXIGÊNCIA e classifique sua COMPLEXIDADE de cumprimento:

EXIGÊNCIA:
"""
${descricaoExigencia}
"""

CRITÉRIOS DE CLASSIFICAÇÃO:

1. SIMPLES (tarefas rápidas, sem dependência externa):
   - **APENAS** preencher autodeclaração no Meu INSS
   - **APENAS** preencher formulário online
   - **APENAS** assinar documentos já prontos
   - **APENAS** comparecer presencialmente
   - **APENAS** agendar perícia
   - **APENAS** confirmar dados
   
   ⚠️ IMPORTANTE: Se a exigência for SOMENTE "preencher autodeclaração", É SIMPLES!
   
2. MEDIA (requer 1-2 documentos OU ações externas):
   - Apresentar 1 ou 2 documentos específicos (RG, CPF, comprovante)
   - Atualizar um cadastro externo
   - Obter certidão simples de cartório
   - Preencher autodeclaração + 1 documento
   
3. COMPLEXA (múltiplos documentos/ações OU difíceis de obter):
   - Lista com 3 ou mais documentos diferentes
   - Preencher autodeclaração + múltiplos documentos de terceiros
   - Documentos de cartório + junta comercial
   - Atualizar múltiplos cadastros (CadÚnico + outros)
   - Laudos médicos complexos ou especializados
   - Provas documentais extensas (ITR, contratos, DAP, etc)
   - Documentos de grupo familiar (pais, cônjuges, filhos)

EXEMPLOS REAIS:

Exemplo SIMPLES:
"Preencher Autodeclaração Rural no Meu INSS" → SIMPLES (1 item, online, rápido)

Exemplo MEDIA:
"Preencher Autodeclaração + apresentar RG" → MEDIA (2 itens)

Exemplo COMPLEXA:
"Preencher Autodeclaração + ITR + DAP + Contratos + Documentos do grupo familiar" → COMPLEXA (múltiplos documentos)

Retorne APENAS uma das palavras: SIMPLES, MEDIA ou COMPLEXA (sem aspas, sem explicações).`;

            const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        contents: [
                            {
                                parts: [
                                    {
                                        text: prompt,
                                    },
                                ],
                            },
                        ],
                        generationConfig: {
                            temperature: 0.1,
                            topK: 20,
                            topP: 0.8,
                            maxOutputTokens: 10,
                        },
                        safetySettings: [
                            {
                                category: 'HARM_CATEGORY_HARASSMENT',
                                threshold: 'BLOCK_NONE',
                            },
                            {
                                category: 'HARM_CATEGORY_HATE_SPEECH',
                                threshold: 'BLOCK_NONE',
                            },
                            {
                                category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
                                threshold: 'BLOCK_NONE',
                            },
                            {
                                category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
                                threshold: 'BLOCK_NONE',
                            },
                        ],
                    }),
                }
            );

            if (!response.ok) {
                throw new Error(`Gemini API error: ${response.statusText}`);
            }

            const data: any = await response.json();
            const textoResposta =
                data.candidates?.[0]?.content?.parts?.[0]?.text || '';

            const complexidade = textoResposta.trim().toUpperCase();

            if (complexidade.includes('SIMPLES')) {
                return 'SIMPLES';
            } else if (complexidade.includes('COMPLEXA')) {
                return 'COMPLEXA';
            } else {
                return 'MEDIA';
            }
        } catch (error) {
            logger.error('[AIService] Erro ao classificar complexidade:', error);
            return 'MEDIA'; // Fallback
        }
    }

    /**
     * 🤖 Resolve CAPTCHA usando Gemini Flash Lite (fallback quando OCR local falha)
     * @param imagemBuffer Buffer da imagem do CAPTCHA (PNG)
     * @returns Texto do CAPTCHA (4 caracteres) ou null se falhar
     */
    async solveCaptcha(imagemBuffer: Buffer): Promise<string | null> {
        try {
            if (!this.apiKey) {
                logger.warn('[AIService] ⚠️ Gemini API Key não configurada. Não é possível usar fallback de CAPTCHA.');
                return null;
            }

            logger.info('[AIService] 🤖 Chamando Gemini Flash Lite para resolver CAPTCHA...');

            // Converter Buffer para base64
            const base64Image = imagemBuffer.toString('base64');
            const mimeType = 'image/png';

            // Prompt otimizado para CAPTCHA
            const prompt = `Analise esta imagem de CAPTCHA e retorne APENAS o texto de 4 caracteres que aparece na imagem.
            
REGRAS CRÍTICAS:
1. Retorne APENAS os 4 caracteres (letras maiúsculas e/ou números)
2. NÃO inclua espaços, pontos, traços ou qualquer outro caractere
3. NÃO inclua explicações ou comentários
4. Se não conseguir identificar claramente, retorne "ERRO"

Exemplo de resposta válida: "A3B7"
Exemplo de resposta inválida: "O texto é A3B7" ou "A 3 B 7"`;

            // Chamada à API do Gemini com suporte a imagem
            const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${this.captchaModel}:generateContent?key=${this.apiKey}`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        contents: [
                            {
                                parts: [
                                    {
                                        text: prompt,
                                    },
                                    {
                                        inline_data: {
                                            mime_type: mimeType,
                                            data: base64Image,
                                        },
                                    },
                                ],
                            },
                        ],
                        generationConfig: {
                            temperature: 0.1, // Baixa temperatura para respostas consistentes
                            topK: 1,
                            topP: 0.1,
                            maxOutputTokens: 10, // CAPTCHA tem apenas 4 caracteres
                        },
                        safetySettings: [
                            {
                                category: 'HARM_CATEGORY_HARASSMENT',
                                threshold: 'BLOCK_NONE',
                            },
                            {
                                category: 'HARM_CATEGORY_HATE_SPEECH',
                                threshold: 'BLOCK_NONE',
                            },
                            {
                                category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
                                threshold: 'BLOCK_NONE',
                            },
                            {
                                category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
                                threshold: 'BLOCK_NONE',
                            },
                        ],
                    }),
                }
            );

            if (!response.ok) {
                const errorText = await response.text();
                logger.error(`[AIService] ❌ Gemini API error: ${response.status} ${response.statusText}`);
                logger.error(`[AIService] Resposta: ${errorText}`);
                return null;
            }

            const data: any = await response.json();
            const textoResposta =
                data.candidates?.[0]?.content?.parts?.[0]?.text || '';

            // Limpar e validar resposta
            let textoLimpo = textoResposta.trim().toUpperCase();

            // Remover espaços, pontos, traços, etc
            textoLimpo = textoLimpo.replace(/[^A-Z0-9]/g, '');

            // Validar se tem 4 caracteres
            if (textoLimpo.length === 4 && !textoLimpo.includes('ERRO')) {
                logger.info(`[AIService] ✅ Gemini resolveu CAPTCHA: "${textoLimpo}"`);
                return textoLimpo;
            } else {
                logger.warn(`[AIService] ⚠️ Gemini retornou resposta inválida: "${textoResposta}" (limpo: "${textoLimpo}")`);
                return null;
            }
        } catch (error: any) {
            logger.error(`[AIService] ❌ Erro ao resolver CAPTCHA com Gemini: ${error.message}`);
            logger.error(`[AIService] Stack: ${error.stack}`);
            return null;
        }
    }

    /**
     * 🧠 Classifica qual etiqueta do escritório corresponde a um benefício do INSS
     * Usa IA semântica para entender o significado e fazer o match
     * 
     * @param nomeInss Nome do benefício como aparece no INSS (ex: "Amparo Social à Pessoa com Deficiência")
     * @param etiquetasEscritorio Lista de etiquetas usadas pelo escritório (ex: ["BPC", "LOAS_DEF", "APOSENTADORIA"])
     * @returns Objeto com a etiqueta identificada e a confiança
     */
    async classificarEtiquetaBeneficio(
        nomeInss: string,
        etiquetasEscritorio: string[]
    ): Promise<{ etiqueta: string | null; confianca: number; explicacao: string }> {
        try {
            if (!this.apiKey) {
                logger.warn('[AIService] API Key não configurada para classificação de etiquetas');
                return { etiqueta: null, confianca: 0, explicacao: 'API Key não disponível' };
            }

            if (!nomeInss || etiquetasEscritorio.length === 0) {
                return { etiqueta: null, confianca: 0, explicacao: 'Dados insuficientes' };
            }

            logger.info(`[AIService] Classificando benefício: "${nomeInss}" entre ${etiquetasEscritorio.length} etiquetas`);

            const prompt = `Você é um especialista em direito previdenciário brasileiro. Sua tarefa é identificar qual etiqueta de um escritório de advocacia corresponde a um benefício do INSS.

**Benefício do INSS:**
"${nomeInss}"

**Etiquetas disponíveis no escritório:**
${etiquetasEscritorio.map((e, i) => `${i + 1}. ${e}`).join('\n')}

**Regras de classificação:**
- BPC, LOAS, AMPARO SOCIAL, BENEFÍCIO ASSISTENCIAL são equivalentes
- APOSENTADORIA POR IDADE, APOSENTADORIA_IDADE, APOS_IDADE são equivalentes
- AUXÍLIO-DOENÇA, INCAPACIDADE TEMPORÁRIA, B31 são equivalentes
- Considere abreviações e variações de escrita

**Retorne EXATAMENTE neste formato JSON (sem markdown):**
{
  "etiqueta": "NOME_DA_ETIQUETA_ESCOLHIDA",
  "confianca": 0.95,
  "explicacao": "Breve explicação do motivo"
}

Se nenhuma etiqueta corresponder adequadamente, retorne:
{
  "etiqueta": null,
  "confianca": 0,
  "explicacao": "Nenhuma etiqueta compatível encontrada"
}`;

            const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: {
                            temperature: 0.1,
                            topK: 1,
                            topP: 0.1,
                            maxOutputTokens: 200,
                        },
                    }),
                }
            );

            if (!response.ok) {
                throw new Error(`Gemini API error: ${response.statusText}`);
            }

            const data: any = await response.json();
            let textoResposta = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

            // Limpar markdown se existir
            textoResposta = textoResposta.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

            try {
                const resultado = JSON.parse(textoResposta);

                // Validar se a etiqueta retornada realmente existe na lista
                if (resultado.etiqueta && !etiquetasEscritorio.some(e =>
                    e.toUpperCase() === resultado.etiqueta.toUpperCase()
                )) {
                    logger.warn(`[AIService] IA retornou etiqueta não existente: ${resultado.etiqueta}`);
                    return { etiqueta: null, confianca: 0, explicacao: 'Etiqueta retornada não existe na lista' };
                }

                logger.info(`[AIService] Etiqueta identificada: "${resultado.etiqueta}" (confiança: ${resultado.confianca})`);
                return {
                    etiqueta: resultado.etiqueta,
                    confianca: resultado.confianca || 0,
                    explicacao: resultado.explicacao || ''
                };
            } catch (parseError) {
                logger.error(`[AIService] Erro ao parsear resposta: ${textoResposta}`);
                return { etiqueta: null, confianca: 0, explicacao: 'Erro ao processar resposta da IA' };
            }
        } catch (error: any) {
            logger.error(`[AIService] Erro ao classificar etiqueta: ${error.message}`);
            return { etiqueta: null, confianca: 0, explicacao: error.message };
        }
    }

    /**
     * 🧠 Sugere uma nova etiqueta quando não há correspondência
     * Baseado no nome do benefício, sugere como o escritório poderia nomear
     */
    async sugerirEtiquetaBeneficio(nomeInss: string): Promise<string> {
        try {
            if (!this.apiKey) {
                // Fallback: normalizar o nome diretamente
                return nomeInss.toUpperCase()
                    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                    .replace(/[^A-Z0-9]/g, '_')
                    .replace(/_+/g, '_')
                    .replace(/^_|_$/g, '')
                    .substring(0, 30);
            }

            const prompt = `Você é especialista em direito previdenciário. Dado o nome de um benefício do INSS, sugira uma etiqueta curta e padronizada para uso em sistema de gestão de escritório de advocacia.

**Benefício:** "${nomeInss}"

**Regras:**
- Use UPPERCASE
- Sem acentos
- Use underscore para separar palavras
- Máximo 20 caracteres
- Priorize siglas conhecidas (BPC, LOAS, APOS)

**Exemplos:**
- "Amparo Social à Pessoa com Deficiência" → "BPC_DEFICIENCIA"
- "Aposentadoria por Idade Urbana" → "APOS_IDADE_URBANO"
- "Auxílio por Incapacidade Temporária" → "AUXILIO_DOENCA"

Retorne APENAS a etiqueta sugerida, sem explicação.`;

            const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: {
                            temperature: 0.2,
                            maxOutputTokens: 50,
                        },
                    }),
                }
            );

            if (!response.ok) {
                throw new Error('API error');
            }

            const data: any = await response.json();
            const sugestao = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';

            // Limpar e validar
            const etiquetaLimpa = sugestao.toUpperCase()
                .replace(/[^A-Z0-9_]/g, '')
                .substring(0, 30);

            return etiquetaLimpa || nomeInss.substring(0, 20).toUpperCase().replace(/\s+/g, '_');
        } catch (error) {
            // Fallback simples
            return nomeInss.toUpperCase()
                .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                .replace(/[^A-Z0-9]/g, '_')
                .replace(/_+/g, '_')
                .substring(0, 20);
        }
    }
}

export default new AIService();

