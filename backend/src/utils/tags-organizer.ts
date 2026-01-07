/**
 * Utilitário para organizar tags por prioridade e aplicar cores
 * 
 * Ordem de prioridade:
 * 1. Fases (ADMINISTRATIVO, JUDICIAL)
 * 2. Responsáveis (GERALDO, JULIO, etc.)
 * 3. Status (EXIGENCIA, DEFERIDO, INDEFERIDO, EM_ANALISE)
 * 4. Benefícios (com cores por tipo: RURAL=verde, URBANO=azul)
 * 5. Parceiros (PARCEIRO:*)
 * 6. Outras tags
 */

export interface TagComCor {
    name: string;
    color: string;
}

/**
 * Define a cor de uma tag baseado no seu tipo
 * 
 * Esquema de cores:
 * - Fases: ADMINISTRATIVO (azul), JUDICIAL (vermelho)
 * - Responsáveis: Laranja (#F59E0B)
 * - Status: EXIGENCIA (laranja escuro), INDEFERIDO (vermelho escuro), DEFERIDO (verde), EM_ANALISE (roxo)
 * - Ações: Amarelo (#EAB308)
 * - Benefícios RURAL: Verde (#22C55E)
 * - Benefícios URBANO/URBANA: Azul (#3B82F6)
 * - Benefícios sem RURAL/URBANO: Cinza (#6B7280)
 * - Parceiros: Roxo (#A855F7)
 * - Outras: Cinza (#6B7280)
 */
function definirCorTag(tag: string): string {
    const tagUpper = tag.toUpperCase();

    // 1. Fases - cores distintas
    if (tagUpper === 'ADMINISTRATIVO') {
        return '#3B82F6'; // Azul
    }
    if (tagUpper === 'JUDICIAL') {
        return '#EF4444'; // Vermelho
    }

    // 2. Responsáveis - cor laranja
    const responsaveis = ['GERALDO', 'JULIO', 'ELLEN', 'IAN', 'JULIA'];
    if (responsaveis.some(r => tagUpper === r)) {
        return '#F59E0B'; // Laranja
    }

    // 3. Status - cores por status
    if (tagUpper === 'EXIGENCIA') {
        return '#F97316'; // Laranja escuro
    }
    if (tagUpper === 'INDEFERIDO') {
        return '#DC2626'; // Vermelho escuro
    }
    if (tagUpper === 'DEFERIDO') {
        return '#10B981'; // Verde
    }
    if (tagUpper === 'EM_ANALISE' || tagUpper === 'EM_ANÁLISE') {
        return '#6366F1'; // Roxo
    }

    // 4. Ações - cor amarela
    if (tagUpper.includes('FAZER') || tagUpper.includes('REQ')) {
        return '#EAB308'; // Amarelo
    }

    // 5. Benefícios RURAL - verde
    if (tagUpper.includes('_RURAL')) {
        return '#22C55E'; // Verde
    }

    // 6. Benefícios URBANO/URBANA - azul
    if (tagUpper.includes('_URBANO') || tagUpper.includes('_URBANA')) {
        return '#3B82F6'; // Azul
    }

    // 7. Parceiros - cor roxa
    if (tagUpper.startsWith('PARCEIRO:')) {
        return '#A855F7'; // Roxo
    }

    // 8. Outras tags (benefícios sem RURAL/URBANO, outras) - cinza
    return '#6B7280'; // Cinza
}

/**
 * Define a prioridade de uma tag (quanto menor o número, maior a prioridade)
 */
function obterPrioridadeTag(tag: string): number {
    const tagUpper = tag.toUpperCase();

    // 1. Fases (prioridade 1)
    if (tagUpper === 'ADMINISTRATIVO' || tagUpper === 'JUDICIAL') {
        return 1;
    }

    // 2. Responsáveis (prioridade 2)
    const responsaveis = ['GERALDO', 'JULIO', 'ELLEN', 'IAN', 'JULIA'];
    if (responsaveis.some(r => tagUpper === r)) {
        return 2;
    }

    // 3. Status (prioridade 3)
    const status = ['EXIGENCIA', 'INDEFERIDO', 'DEFERIDO', 'EM_ANALISE', 'EM_ANÁLISE'];
    if (status.some(s => tagUpper === s)) {
        return 3;
    }

    // 4. Ações (prioridade 3.5)
    if (tagUpper.includes('FAZER') || tagUpper.includes('REQ')) {
        return 3.5;
    }

    // 5. Benefícios (prioridade 4)
    const beneficios = [
        'BENEFICIO', 'APOSENTADORIA', 'PENSAO', 'SALARIO', 'AUXILIO',
        'EMPRESTIMO', 'REVISAO'
    ];
    if (beneficios.some(b => tagUpper.includes(b))) {
        return 4;
    }

    // 6. Parceiros (prioridade 5)
    if (tagUpper.startsWith('PARCEIRO:')) {
        return 5;
    }

    // 7. Outras tags (prioridade 6)
    return 6;
}

/**
 * Organiza tags por prioridade e aplica cores
 * @param tags Array de nomes de tags
 * @returns Array de tags organizadas com cores
 */
export function organizarTagsComCores(tags: string[]): TagComCor[] {
    // Remover duplicatas
    const tagsUnicas = [...new Set(tags)];

    // Organizar por prioridade
    const tagsOrganizadas = tagsUnicas
        .map(tag => ({
            name: tag,
            priority: obterPrioridadeTag(tag),
            color: definirCorTag(tag)
        }))
        .sort((a, b) => {
            // Ordenar por prioridade
            if (a.priority !== b.priority) {
                return a.priority - b.priority;
            }
            // Se mesma prioridade, ordenar alfabeticamente
            return a.name.localeCompare(b.name);
        })
        .map(({ name, color }) => ({ name, color }));

    return tagsOrganizadas;
}

/**
 * Converte tags organizadas para formato de string simples (fallback)
 * @param tagsComCor Array de tags com cores
 * @returns Array de strings simples
 */
export function tagsParaStrings(tagsComCor: TagComCor[]): string[] {
    return tagsComCor.map(tag => tag.name);
}

/**
 * Extrai apenas os nomes das tags de um array que pode conter strings ou objetos
 */
export function extrairNomesTags(tags: Array<string | { name: string; color?: string }>): string[] {
    return tags.map(tag =>
        typeof tag === 'string' ? tag : tag.name
    );
}

