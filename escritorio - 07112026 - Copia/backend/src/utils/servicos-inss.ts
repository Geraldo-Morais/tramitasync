/**
 * Mapeamento de Serviços do INSS para Tags Normalizadas
 * 
 * Este arquivo contém o mapeamento de todos os serviços do INSS
 * para suas respectivas tags normalizadas no Tramitação Inteligente.
 * 
 * Baseado na documentação da API do Tramitação Inteligente (docs.yaml)
 * e nas tags existentes no sistema:
 * 
 * REGRAS DE NOMENCLATURA:
 * 1. Sempre especificar RURAL ou URBANO/URBANA quando o benefício tiver essas versões
 * 2. Benefícios que NÃO têm versão RURAL/URBANA não devem ter sufixo RURAL/URBANO
 * 3. Serviços não-benefícios: usar o nome que o portal dá e normalizar (MAIÚSCULAS com underscore)
 * 4. Se não especificar RURAL/URBANO, o sistema usa padrão URBANO/URBANA
 * 
 * Tags padronizadas:
 * - BENEFICIO_POR_INCAPACIDADE_URBANO
 * - BENEFICIO_POR_INCAPACIDADE_RURAL
 * - APOSENTADORIA_POR_IDADE_URBANA
 * - APOSENTADORIA_POR_IDADE_RURAL
 * - APOSENTADORIA_POR_TEMPO_DE_CONTRIBUICAO (sem RURAL/URBANO)
 * - APOSENTADORIA_ESPECIAL (sem RURAL/URBANO)
 * - APOSENTADORIA_PESSOA_COM_DEFICIENCIA (sem RURAL/URBANO)
 * - AUXILIO_ACIDENTE (sem RURAL/URBANO)
 * - AUXILIO_RECLUSAO (sem RURAL/URBANO)
 * - PENSAO_POR_MORTE_URBANA
 * - PENSAO_POR_MORTE_RURAL
 * - SALARIO_MATERNIDADE_URBANO
 * - SALARIO_MATERNIDADE_RURAL
 * - BENEFICIO_DE_PRESTACAO_CONTINUADA_LOAS (sem RURAL/URBANO)
 * 
 * Formato das tags conforme docs.yaml:
 * - Tags são strings simples em um array: ["VIP", "Ativo"]
 * - Ao receber da API podem vir como objetos: { name: "VIP", color: "#ff0000" }
 * - Ao enviar para API devem ser strings simples: ["VIP", "Ativo"]
 */

/**
 * Mapeamento de serviços do INSS para tags normalizadas
 * Chave: nome do serviço (case-insensitive, com variações)
 * Valor: tag normalizada no Tramitação
 */
const MAPEAMENTO_SERVICOS: Record<string, string> = {
    // Aposentadorias - Por Idade
    'aposentadoria por idade rural': 'APOSENTADORIA_POR_IDADE_RURAL',
    'aposentadoria idade rural': 'APOSENTADORIA_POR_IDADE_RURAL',
    'aposentadoria rural': 'APOSENTADORIA_POR_IDADE_RURAL',

    'aposentadoria por idade urbana': 'APOSENTADORIA_POR_IDADE_URBANA',
    'aposentadoria idade urbana': 'APOSENTADORIA_POR_IDADE_URBANA',
    'aposentadoria urbana': 'APOSENTADORIA_POR_IDADE_URBANA',
    'aposentadoria por idade': 'APOSENTADORIA_POR_IDADE_URBANA', // Default para urbana se não especificado

    // Aposentadorias - Por Tempo de Contribuição (NÃO tem RURAL/URBANO)
    'aposentadoria por tempo de contribuição': 'APOSENTADORIA_POR_TEMPO_DE_CONTRIBUICAO',
    'aposentadoria tempo contribuição': 'APOSENTADORIA_POR_TEMPO_DE_CONTRIBUICAO',
    'aposentadoria contribuição': 'APOSENTADORIA_POR_TEMPO_DE_CONTRIBUICAO',
    'aposentadoria por tempo': 'APOSENTADORIA_POR_TEMPO_DE_CONTRIBUICAO',

    'revisão de aposentadoria': 'REVISAO_DE_APOSENTADORIA',
    'revisão aposentadoria': 'REVISAO_DE_APOSENTADORIA',
    'revisão': 'REVISAO_DE_APOSENTADORIA',

    'aposentadoria pessoa com deficiência': 'APOSENTADORIA_PESSOA_COM_DEFICIENCIA',
    'aposentadoria pessoa deficiencia': 'APOSENTADORIA_PESSOA_COM_DEFICIENCIA',
    'aposentadoria por deficiência': 'APOSENTADORIA_PESSOA_COM_DEFICIENCIA',
    'aposentadoria por deficiencia': 'APOSENTADORIA_PESSOA_COM_DEFICIENCIA',

    // Benefícios por Incapacidade (tem RURAL/URBANO - padronizado, sem distinção permanente/temporária)
    'benefício por incapacidade rural': 'BENEFICIO_POR_INCAPACIDADE_RURAL',
    'benefício incapacidade rural': 'BENEFICIO_POR_INCAPACIDADE_RURAL',
    'incapacidade rural': 'BENEFICIO_POR_INCAPACIDADE_RURAL',
    'auxílio-doença rural': 'BENEFICIO_POR_INCAPACIDADE_RURAL',
    'auxilio doença rural': 'BENEFICIO_POR_INCAPACIDADE_RURAL',
    'auxílio doença rural': 'BENEFICIO_POR_INCAPACIDADE_RURAL',

    // Permanente também mapeia para RURAL/URBANO (sem distinção)
    'benefício por incapacidade permanente rural': 'BENEFICIO_POR_INCAPACIDADE_RURAL',
    'benefício incapacidade permanente rural': 'BENEFICIO_POR_INCAPACIDADE_RURAL',
    'incapacidade permanente rural': 'BENEFICIO_POR_INCAPACIDADE_RURAL',
    'auxílio-doença permanente rural': 'BENEFICIO_POR_INCAPACIDADE_RURAL',
    'auxilio doença permanente rural': 'BENEFICIO_POR_INCAPACIDADE_RURAL',
    'auxílio doença permanente rural': 'BENEFICIO_POR_INCAPACIDADE_RURAL',

    'benefício por incapacidade urbano': 'BENEFICIO_POR_INCAPACIDADE_URBANO',
    'benefício incapacidade urbano': 'BENEFICIO_POR_INCAPACIDADE_URBANO',
    'incapacidade urbano': 'BENEFICIO_POR_INCAPACIDADE_URBANO',
    'auxílio-doença urbano': 'BENEFICIO_POR_INCAPACIDADE_URBANO',
    'auxilio doença urbano': 'BENEFICIO_POR_INCAPACIDADE_URBANO',
    'auxílio doença urbano': 'BENEFICIO_POR_INCAPACIDADE_URBANO',

    // Permanente também mapeia para RURAL/URBANO (sem distinção)
    'benefício por incapacidade permanente urbano': 'BENEFICIO_POR_INCAPACIDADE_URBANO',
    'benefício incapacidade permanente urbano': 'BENEFICIO_POR_INCAPACIDADE_URBANO',
    'incapacidade permanente urbano': 'BENEFICIO_POR_INCAPACIDADE_URBANO',
    'auxílio-doença permanente urbano': 'BENEFICIO_POR_INCAPACIDADE_URBANO',
    'auxilio doença permanente urbano': 'BENEFICIO_POR_INCAPACIDADE_URBANO',
    'auxílio doença permanente urbano': 'BENEFICIO_POR_INCAPACIDADE_URBANO',

    // Se não especificar RURAL/URBANO, usar padrão URBANO
    'benefício por incapacidade permanente': 'BENEFICIO_POR_INCAPACIDADE_URBANO',
    'benefício incapacidade permanente': 'BENEFICIO_POR_INCAPACIDADE_URBANO',
    'incapacidade permanente': 'BENEFICIO_POR_INCAPACIDADE_URBANO',

    // BPC / LOAS (NÃO tem RURAL/URBANO)
    'benefício de prestação continuada': 'BENEFICIO_DE_PRESTACAO_CONTINUADA_LOAS',
    'beneficio de prestacao continuada': 'BENEFICIO_DE_PRESTACAO_CONTINUADA_LOAS',
    'benefício prestação continuada': 'BENEFICIO_DE_PRESTACAO_CONTINUADA_LOAS',
    'beneficio prestacao continuada': 'BENEFICIO_DE_PRESTACAO_CONTINUADA_LOAS',
    'bpc': 'BENEFICIO_DE_PRESTACAO_CONTINUADA_LOAS',
    'loas': 'BENEFICIO_DE_PRESTACAO_CONTINUADA_LOAS',
    'prestação continuada': 'BENEFICIO_DE_PRESTACAO_CONTINUADA_LOAS',
    'prestacao continuada': 'BENEFICIO_DE_PRESTACAO_CONTINUADA_LOAS',
    'prestação continuada da assistência social': 'BENEFICIO_DE_PRESTACAO_CONTINUADA_LOAS',
    'prestacao continuada da assistencia social': 'BENEFICIO_DE_PRESTACAO_CONTINUADA_LOAS',
    'prestação continuada assistência social': 'BENEFICIO_DE_PRESTACAO_CONTINUADA_LOAS',
    'prestacao continuada assistencia social': 'BENEFICIO_DE_PRESTACAO_CONTINUADA_LOAS',

    // Benefício Assistencial (LOAS) - Pessoa com Deficiência e Idoso
    'benefício assistencial à pessoa com deficiência': 'BENEFICIO_DE_PRESTACAO_CONTINUADA_LOAS',
    'beneficio assistencial a pessoa com deficiencia': 'BENEFICIO_DE_PRESTACAO_CONTINUADA_LOAS',
    'benefício assistencial pessoa com deficiência': 'BENEFICIO_DE_PRESTACAO_CONTINUADA_LOAS',
    'beneficio assistencial pessoa com deficiencia': 'BENEFICIO_DE_PRESTACAO_CONTINUADA_LOAS',
    'benefício assistencial ao idoso': 'BENEFICIO_DE_PRESTACAO_CONTINUADA_LOAS',
    'beneficio assistencial ao idoso': 'BENEFICIO_DE_PRESTACAO_CONTINUADA_LOAS',
    'benefício assistencial idoso': 'BENEFICIO_DE_PRESTACAO_CONTINUADA_LOAS',
    'beneficio assistencial idoso': 'BENEFICIO_DE_PRESTACAO_CONTINUADA_LOAS',

    // Pensão
    'pensão por morte rural': 'PENSAO_POR_MORTE_RURAL',
    'pensão morte rural': 'PENSAO_POR_MORTE_RURAL',

    'pensão por morte urbana': 'PENSAO_POR_MORTE_URBANA',
    'pensão morte urbana': 'PENSAO_POR_MORTE_URBANA',

    // Se não especificar RURAL/URBANA, tentar detectar ou usar padrão URBANA
    'pensão por morte': 'PENSAO_POR_MORTE_URBANA', // Default para urbana se não especificado
    'pensão': 'PENSAO_POR_MORTE_URBANA',

    // Salário Maternidade
    'salário maternidade rural': 'SALARIO_MATERNIDADE_RURAL',
    'salário-maternidade rural': 'SALARIO_MATERNIDADE_RURAL',
    'salario maternidade rural': 'SALARIO_MATERNIDADE_RURAL',

    'salário maternidade urbano': 'SALARIO_MATERNIDADE_URBANO',
    'salário-maternidade urbano': 'SALARIO_MATERNIDADE_URBANO',
    'salario maternidade urbano': 'SALARIO_MATERNIDADE_URBANO',

    // Se não especificar RURAL/URBANO, tentar detectar ou usar padrão URBANO
    'salário maternidade': 'SALARIO_MATERNIDADE_URBANO', // Default para urbano se não especificado
    'salario maternidade': 'SALARIO_MATERNIDADE_URBANO',

    // Empréstimo
    'empréstimo': 'EMPRESTIMO',
    'emprestimo': 'EMPRESTIMO',
    'empréstimo consignado': 'EMPRESTIMO',
    'consignado': 'EMPRESTIMO',

    // Outros serviços comuns do INSS (criados seguindo o padrão)
    'auxílio-acidente': 'AUXILIO_ACIDENTE',
    'auxilio acidente': 'AUXILIO_ACIDENTE',
    'auxílio acidente': 'AUXILIO_ACIDENTE',

    'auxílio-reclusão': 'AUXILIO_RECLUSAO',
    'auxilio reclusão': 'AUXILIO_RECLUSAO',
    'auxílio reclusão': 'AUXILIO_RECLUSAO',
    'reclusão': 'AUXILIO_RECLUSAO',

    'aposentadoria especial': 'APOSENTADORIA_ESPECIAL',

    // Se não especificar RURAL/URBANO, tentar detectar ou usar padrão URBANO
    'auxílio-doença': 'BENEFICIO_POR_INCAPACIDADE_URBANO', // Default para urbano se não especificado
    'auxilio doença': 'BENEFICIO_POR_INCAPACIDADE_URBANO',
    'auxílio doença': 'BENEFICIO_POR_INCAPACIDADE_URBANO',
    'benefício por incapacidade': 'BENEFICIO_POR_INCAPACIDADE_URBANO', // Default para urbano se não especificado

};

/**
 * Normaliza o nome do serviço para uma tag padrão
 * Remove acentos, caracteres especiais e converte para maiúsculas
 */
export function normalizarServico(servico: string): string {
    if (!servico || typeof servico !== 'string') {
        return 'SERVICO_NAO_INFORMADO';
    }

    // Remove acentos e caracteres especiais
    const semAcentos = servico
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();

    // Remove espaços extras e caracteres especiais
    return semAcentos
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, '_')
        .replace(/^_|_$/g, '')
        .toUpperCase();
}

/**
 * Mapeia um serviço do INSS para sua tag normalizada
 * 
 * @param servico Nome do serviço (ex: "Aposentadoria por Idade Rural")
 * @returns Tag normalizada (ex: "APOSENTADORIA_POR_IDADE_RURAL")
 */
export function mapearServicoParaTag(servico: string): string {
    if (!servico || typeof servico !== 'string') {
        return 'SERVICO_NAO_INFORMADO';
    }

    // Normalizar entrada
    const servicoNormalizado = servico
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();

    // Buscar no mapeamento
    const tagMapeada = MAPEAMENTO_SERVICOS[servicoNormalizado];

    if (tagMapeada) {
        return tagMapeada;
    }

    // Se não encontrou no mapeamento, tentar busca parcial
    // (ex: "Aposentadoria por Idade Rural - Requerimento" → "APOSENTADORIA_POR_IDADE_RURAL")
    for (const [chave, tag] of Object.entries(MAPEAMENTO_SERVICOS)) {
        if (servicoNormalizado.includes(chave) || chave.includes(servicoNormalizado)) {
            return tag;
        }
    }

    // Se não encontrou, normalizar automaticamente
    return normalizarServico(servico);
}

/**
 * Lista todos os serviços mapeados
 */
export function listarServicosMapeados(): string[] {
    return Object.values(MAPEAMENTO_SERVICOS);
}

/**
 * Verifica se um serviço está mapeado
 */
export function servicoEstaMapeado(servico: string): boolean {
    const servicoNormalizado = servico
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();

    return servicoNormalizado in MAPEAMENTO_SERVICOS;
}

