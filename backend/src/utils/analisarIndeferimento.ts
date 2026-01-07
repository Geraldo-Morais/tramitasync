import logger from './logger';

/**
 * Analisa se um indeferimento foi por culpa do cliente/escritório ou por mérito (critérios não atendidos)
 * @param textoDespacho Texto completo do despacho de indeferimento
 * @returns 'CULPA' se for por culpa (nova entrada administrativa) ou 'MERITO' se for por mérito (judicial)
 */
export function analisarTipoIndeferimento(textoDespacho: string): 'CULPA' | 'MERITO' {
    const textoLower = textoDespacho.toLowerCase();

    // Palavras-chave que indicam culpa do CLIENTE/ESCRITÓRIO
    const palavrasCulpa = [
        'não compareceu',
        'nao compareceu',
        'ausência',
        'ausencia',
        'não apresentou',
        'nao apresentou',
        'não cumpriu',
        'nao cumpriu',
        'exigência não atendida',
        'exigencia nao atendida',
        'exigência não cumprida',
        'exigencia nao cumprida',
        'prazo vencido',
        'desistência',
        'desistencia',
        'faltou',
        'falta de documento',
        'documentação incompleta',
        'documentacao incompleta'
    ];

    // Palavras-chave que indicam CRITÉRIO/MÉRITO não atendido
    const palavrasMerito = [
        'não reconhec',
        'nao reconhec',
        'não comprovou',
        'nao comprovou',
        'renda',
        'miserabilidade',
        'deficiência não caracterizada',
        'deficiencia nao caracterizada',
        'impedimento de longo prazo não',
        'não atende critério',
        'nao atende criterio',
        'não atende requisito',
        'nao atende requisito',
        'critério',
        'criterio',
        'requisito',
        'incapacidade não',
        'incapacidade nao',
        'não caracteriza',
        'nao caracteriza'
    ];

    let pontosCulpa = 0;
    let pontosMerito = 0;

    for (const palavra of palavrasCulpa) {
        if (textoLower.includes(palavra)) pontosCulpa++;
    }

    for (const palavra of palavrasMerito) {
        if (textoLower.includes(palavra)) pontosMerito++;
    }

    // Se tiver evidência clara, retornar automaticamente
    if (pontosCulpa > pontosMerito && pontosCulpa >= 1) {
        logger.info(`🤖 Indeferimento detectado como CULPA (pontos: ${pontosCulpa} vs ${pontosMerito})`);
        return 'CULPA';
    }

    if (pontosMerito > pontosCulpa && pontosMerito >= 1) {
        logger.info(`🤖 Indeferimento detectado como MÉRITO (pontos: ${pontosMerito} vs ${pontosCulpa})`);
        return 'MERITO';
    }

    // Se ambíguo, assumir MÉRITO (mais conservador - vai para judicial)
    logger.warn(`⚠️ Indeferimento ambíguo (pontos: culpa=${pontosCulpa}, mérito=${pontosMerito}). Assumindo MÉRITO (judicial).`);
    return 'MERITO';
}

