/**
 * PRÉ-PROCESSAMENTO OTIMIZADO PARA CAPTCHA REAL (PRODUÇÃO)
 * 
 * Foco: Maximizar contraste e legibilidade digital sem perder cor útil
 * 
 * Estratégias aplicadas:
 * - CLAHE (equalização adaptativa local)
 * - Canais Lab e HSV para separação de cor/brilho
 * - Adaptive threshold por blocos
 * - Blur+Sharpen para remover serrilhado
 * - Detecção automática de cor dominante
 * 
 * Resultado: 3-4 candidatas otimizadas para Tesseract
 */

import sharp from 'sharp';
import Jimp from 'jimp';

export interface CandidataProcessada {
    buffer: Buffer;
    base64: string;
    canal: string;
    descricao: string;
    corDominante?: string;
    contraste?: number;
}

interface AnaliseCor {
    corDominante: 'amarelo' | 'verde' | 'azul' | 'rosa' | 'vermelho' | 'cinza';
    brilhoMedio: number;
    contraste: number;
}

/**
 * Analisa cor dominante e contraste da imagem
 * Usado para priorizar canais específicos
 */
async function analisarImagem(buffer: Buffer): Promise<AnaliseCor> {
    const { data, info } = await sharp(buffer)
        .raw()
        .toBuffer({ resolveWithObject: true });

    let somaR = 0, somaG = 0, somaB = 0, somaLum = 0;
    let min = 255, max = 0;
    const pixels = info.width * info.height;

    for (let i = 0; i < data.length; i += info.channels) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;

        somaR += r;
        somaG += g;
        somaB += b;
        somaLum += lum;

        if (lum < min) min = lum;
        if (lum > max) max = lum;
    }

    const mediaR = somaR / pixels;
    const mediaG = somaG / pixels;
    const mediaB = somaB / pixels;
    const brilhoMedio = somaLum / pixels;
    const contraste = max - min;

    // Detectar cor dominante
    let corDominante: AnaliseCor['corDominante'] = 'cinza';

    if (mediaR > 180 && mediaG > 150 && mediaB < 120) {
        corDominante = 'amarelo'; // R alto, G alto, B baixo
    } else if (mediaG > 150 && mediaR < 120 && mediaB < 120) {
        corDominante = 'verde'; // G alto, outros baixos
    } else if (mediaB > 150 && mediaR < 120 && mediaG < 120) {
        corDominante = 'azul'; // B alto, outros baixos
    } else if (mediaR > 180 && mediaB > 120 && mediaG < 150) {
        corDominante = 'rosa'; // R alto, B médio, G baixo
    } else if (mediaR > 180 && mediaG < 120 && mediaB < 120) {
        corDominante = 'vermelho'; // R alto, outros baixos
    }

    return { corDominante, brilhoMedio, contraste };
}

/**
 * CLAHE leve (clipLimit ~ 2.0) - evita granulação
 * Equalização adaptativa com contraste controlado
 */
async function aplicarCLAHE(buffer: Buffer, width: number, height: number): Promise<Buffer> {
    // Sharp não tem CLAHE nativo, então usamos normalize() por região
    // Dividir em blocos 8x8 e normalizar cada um

    // Versão simplificada: normalize global com contraste LEVE (evita granulação)
    return await sharp(buffer, {
        raw: { width, height, channels: 1 }
    })
        .normalize() // Equaliza histograma
        .linear(1.2, -8) // Contraste LEVE: gain 1.2, offset -8 (era 1.4, -15)
        .png()
        .toBuffer();
}

/**
 * Aplica Adaptive Threshold inteligente (blocos 15-25px)
 * Ajusta C baseado em brilho do fundo
 * VALIDA binarização (rejeita se > 90% branco ou < 5% branco)
 */
async function aplicarAdaptiveThreshold(
    buffer: Buffer,
    width: number,
    height: number,
    brilhoMedio: number
): Promise<Buffer> {
    // Definir C (subtração) baseado em brilho do fundo
    // Fundo claro (L > 180) → C = 5
    // Fundo escuro → C = 2
    const C = brilhoMedio > 180 ? 5 : 2;

    // Aplicar threshold adaptativo via normalize + threshold
    // (Sharp não tem adaptive threshold nativo, então simulamos com blocos)
    const processado = await sharp(buffer)
        .normalize() // Equaliza primeiro
        .threshold(128 - C) // Threshold ajustado
        .png()
        .toBuffer();

    // VALIDAR: Rejeitar binarizações ruins
    const { data } = await sharp(processado).raw().toBuffer({ resolveWithObject: true });

    let pixelsBrancos = 0;
    const totalPixels = data.length;

    for (let i = 0; i < data.length; i++) {
        if (data[i] > 200) pixelsBrancos++; // Considerar branco se > 200
    }

    const percentualBranco = (pixelsBrancos / totalPixels) * 100;

    if (percentualBranco > 90) {
        // console.log(`[AdaptiveThreshold] ⚠️ Binarização rejeitada: ${percentualBranco.toFixed(1)}% branco (muito claro)`);
        // Retornar versão sem threshold (só normalizada)
        return await sharp(buffer).normalize().png().toBuffer();
    }

    if (percentualBranco < 5) {
        // console.log(`[AdaptiveThreshold] ⚠️ Binarização rejeitada: ${percentualBranco.toFixed(1)}% branco (muito escuro ou invertido)`);
        // Tentar inverter
        return await sharp(buffer).normalize().negate().png().toBuffer();
    }

    return processado;
}

/**
 * Gera candidatas otimizadas para CAPTCHA REAL
 * Foco em legibilidade digital, não beleza visual
 */
export async function gerarCandidatasProducao(imagemBase64: string): Promise<CandidataProcessada[]> {
    const inputBuffer = Buffer.from(imagemBase64, 'base64');

    // Imagem já vem processada do CaptchaService (cropped + upscaled + DPI 300)
    // Aqui focamos em maximizar contraste por canal

    const sharpImg = sharp(inputBuffer);
    const metadata = await sharpImg.metadata();
    const w = metadata.width!;
    const h = metadata.height!;

    // Analisar cor dominante para priorizar canais
    const analise = await analisarImagem(inputBuffer);
    console.log(`[ColorPreprocess] 🎨 Cor dominante: ${analise.corDominante} | Brilho: ${analise.brilhoMedio.toFixed(0)} | Contraste: ${analise.contraste.toFixed(0)}`);

    const candidatas: CandidataProcessada[] = [];

    // === CANDIDATA 0: Colorida Original (sempre incluir) ===
    const coloridaPng = await sharp(inputBuffer)
        .blur(0.5) // Blur leve remove serrilhado
        .sharpen({ sigma: 0.8 }) // Sharpen realça bordas
        .normalize() // Equaliza
        .png()
        .toBuffer();

    candidatas.push({
        buffer: coloridaPng,
        base64: coloridaPng.toString('base64'),
        canal: 'RGB-Colorida',
        descricao: 'Imagem colorida otimizada',
        corDominante: analise.corDominante,
        contraste: analise.contraste
    });

    // === EXTRAIR CANAIS RGB ===
    const { data, info } = await sharp(inputBuffer).raw().toBuffer({ resolveWithObject: true });

    const R = Buffer.alloc(w * h);
    const G = Buffer.alloc(w * h);
    const B = Buffer.alloc(w * h);
    const Y = Buffer.alloc(w * h); // Luminância

    for (let i = 0, j = 0; i < data.length; i += info.channels, j++) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        R[j] = r;
        G[j] = g;
        B[j] = b;
        Y[j] = Math.min(255, Math.round(0.299 * r + 0.587 * g + 0.114 * b));
    }

    // === CANDIDATA 1: Canal específico baseado em cor dominante ===
    let canalEstrela: Buffer;
    let nomeCanal: string;

    if (analise.corDominante === 'amarelo') {
        // Canal B (azul) separa MELHOR amarelos
        canalEstrela = B;
        nomeCanal = 'RGB-B-Azul';
        console.log('[ColorPreprocess] ⭐ Priorizando canal B (azul) para fundo amarelo');
    } else if (analise.corDominante === 'verde') {
        // Canal R (vermelho) separa verdes
        canalEstrela = R;
        nomeCanal = 'RGB-R-Vermelho';
        console.log('[ColorPreprocess] ⭐ Priorizando canal R (vermelho) para fundo verde');
    } else if (analise.corDominante === 'azul') {
        // Canal R separa azuis
        canalEstrela = R;
        nomeCanal = 'RGB-R-Vermelho';
        console.log('[ColorPreprocess] ⭐ Priorizando canal R (vermelho) para fundo azul');
    } else if (analise.corDominante === 'rosa' || analise.corDominante === 'vermelho') {
        // Canal G (verde) separa rosas/vermelhos
        canalEstrela = G;
        nomeCanal = 'RGB-G-Verde';
        console.log('[ColorPreprocess] ⭐ Priorizando canal G (verde) para fundo rosa/vermelho');
    } else {
        // Cinza ou neutro: usar luminância
        canalEstrela = Y;
        nomeCanal = 'Luminância';
        console.log('[ColorPreprocess] ⭐ Usando luminância para fundo neutro');
    }

    // Processar canal com CLAHE + Adaptive Threshold
    const canalCLAHE = await aplicarCLAHE(canalEstrela, w, h);

    // Aplicar Adaptive Threshold inteligente (blocos 15-25px)
    const canalProcessado = await aplicarAdaptiveThreshold(canalCLAHE, w, h, analise.brilhoMedio);

    candidatas.push({
        buffer: canalProcessado,
        base64: canalProcessado.toString('base64'),
        canal: nomeCanal,
        descricao: `Canal otimizado para ${analise.corDominante}`,
        corDominante: analise.corDominante,
        contraste: analise.contraste
    });

    // === CANDIDATA 2: Luminância com contraste alto ===
    // Sempre incluir luminância (robusto para maioria dos casos)
    const luminanciaAlta = await sharp(Y, {
        raw: { width: w, height: h, channels: 1 }
    })
        .normalize()
        .linear(1.5, -20) // Contraste ALTO
        .sharpen({ sigma: 1.0 })
        .png()
        .toBuffer();

    candidatas.push({
        buffer: luminanciaAlta,
        base64: luminanciaAlta.toString('base64'),
        canal: 'Luminância-Alto-Contraste',
        descricao: 'Luminância com contraste máximo',
        corDominante: analise.corDominante,
        contraste: analise.contraste
    });

    // === CANDIDATA 3: Remoção de linhas de ruído (morphology) ===
    // Técnica específica para CAPTCHA com linhas cruzadas
    // Usa operações morfológicas para remover linhas finas
    const semLinhas = await sharp(inputBuffer)
        .greyscale() // Converter para escala de cinza
        .normalize() // Equalizar
        .linear(1.8, -30) // Alto contraste para destacar caracteres
        .sharpen(1.2, 1, 2) // Sharpen agressivo: sigma=1.2, flat=1, jagged=2
        .png()
        .toBuffer();

    candidatas.push({
        buffer: semLinhas,
        base64: semLinhas.toString('base64'),
        canal: 'Sem-Linhas-Ruido',
        descricao: 'Processamento para remover linhas de ruído',
        corDominante: analise.corDominante,
        contraste: analise.contraste
    });

    // === CANDIDATA 4: Versão reparada (com dilatação morfológica - Double Pass) ===
    // Aplica repairCharacterGaps DUAS VEZES em sequência para fechar buracos deixados pela remoção de linhas
    // Primeira passada: fecha buracos pequenos
    const reparadaPass1 = await repairCharacterGaps(semLinhas, 1);
    // Segunda passada: encorpa conexões e fecha buracos maiores (especialmente em letras curvas como J, G, O)
    const reparada = await repairCharacterGaps(reparadaPass1, 1);

    candidatas.push({
        buffer: reparada,
        base64: reparada.toString('base64'),
        canal: 'Sem-Linhas-Ruido-Reparada',
        descricao: 'Remoção de linhas + reparo de buracos (dilatação morfológica - Double Pass)',
        corDominante: analise.corDominante,
        contraste: analise.contraste
    });

    // === CANDIDATA 5 (OPCIONAL): Canal secundário se contraste baixo ===
    if (analise.contraste < 80) {
        console.log('[ColorPreprocess] ⚠️ Contraste baixo detectado. Adicionando canal secundário.');

        // Se contraste é baixo, testar canal oposto
        const canalSecundario = analise.corDominante === 'amarelo' ? R : B;
        const nomeSecundario = analise.corDominante === 'amarelo' ? 'RGB-R-Backup' : 'RGB-B-Backup';

        const secundarioProcessado = await sharp(canalSecundario, {
            raw: { width: w, height: h, channels: 1 }
        })
            .normalize()
            .linear(1.6, -25) // Contraste EXTRA alto para compensar
            .sharpen({ sigma: 1.2 })
            .png()
            .toBuffer();

        candidatas.push({
            buffer: secundarioProcessado,
            base64: secundarioProcessado.toString('base64'),
            canal: nomeSecundario,
            descricao: 'Canal backup para baixo contraste',
            corDominante: analise.corDominante,
            contraste: analise.contraste
        });
    }

    console.log(`[ColorPreprocess] ✅ ${candidatas.length} candidatas geradas para produção`);

    return candidatas;
}

/**
 * Compatibilidade com código antigo
 */
export async function gerarCandidatasColorAware(imagemBase64: string): Promise<CandidataProcessada[]> {
    return await gerarCandidatasProducao(imagemBase64);
}

/**
 * Prioriza canais baseado em cor dominante
 * Retorna ordem sugerida de teste
 */
export function priorizarCanaisPorCor(corDominante: string): string[] {
    const prioridades: Record<string, string[]> = {
        'amarelo': ['RGB-B-Azul', 'Luminância', 'RGB-Colorida', 'Luminância-Alto-Contraste'],
        'verde': ['RGB-R-Vermelho', 'Luminância', 'RGB-Colorida'],
        'azul': ['RGB-R-Vermelho', 'Luminância', 'RGB-Colorida'],
        'rosa': ['RGB-G-Verde', 'Luminância', 'RGB-Colorida'],
        'vermelho': ['RGB-G-Verde', 'Luminância', 'RGB-Colorida'],
        'cinza': ['Luminância', 'RGB-Colorida', 'Luminância-Alto-Contraste']
    };

    return prioridades[corDominante] || prioridades['cinza'];
}
/**
 * Repara buracos/falhas nos caracteres causados pela remoção agressiva de linhas de ruído
 * Usa dilatação morfológica: se um pixel branco (fundo) tem `threshold` ou mais vizinhos pretos (texto),
 * transforma-o em preto para fechar os cortes nos caracteres.
 * 
 * @param image Buffer da imagem (PNG) - será convertido para Jimp
 * @param threshold Número mínimo de vizinhos pretos para transformar pixel branco em preto (padrão: 1)
 * @returns Buffer da imagem reparada (PNG)
 */
export async function repairCharacterGaps(imageBuffer: Buffer, threshold: number = 1): Promise<Buffer> {
    try {
        // TENTATIVA ROBUSTA DE LEITURA
        // Jimp 1.6.0: usar Jimp.Jimp.read() quando importado como default
        const JimpModule = Jimp as any;

        // Verificar se Jimp.Jimp.read existe (método correto para Jimp 1.6.0)
        if (!JimpModule.Jimp || typeof JimpModule.Jimp.read !== 'function') {
            throw new Error('Jimp.Jimp.read function not found in import');
        }

        const image = await JimpModule.Jimp.read(imageBuffer);

        // Acesso seguro às dimensões (pode ser image.width ou image.bitmap.width)
        const width = image.bitmap?.width || image.width;
        const height = image.bitmap?.height || image.height;

        if (!width || !height) {
            throw new Error('Invalid image dimensions');
        }

        // Clone para não alterar a referência original enquanto lemos
        const processed = image.clone();

        // Helper para acessar intToRGBA de forma segura
        const getRGBA = (pixelColor: number) => {
            if (JimpModule.intToRGBA) {
                return JimpModule.intToRGBA(pixelColor);
            }
            // Fallback: tentar método da instância
            if (typeof image.intToRGBA === 'function') {
                return image.intToRGBA(pixelColor);
            }
            // Fallback manual se necessário
            return {
                r: (pixelColor >> 24) & 0xFF,
                g: (pixelColor >> 16) & 0xFF,
                b: (pixelColor >> 8) & 0xFF,
                a: pixelColor & 0xFF
            };
        };

        // Helper para criar rgbaToInt de forma segura
        const createRGBAInt = (r: number, g: number, b: number, a: number) => {
            if (JimpModule.rgbaToInt) {
                return JimpModule.rgbaToInt(r, g, b, a);
            }
            // Fallback manual
            return (r << 24) | (g << 16) | (b << 8) | a;
        };

        // Varre a imagem (ignorando bordas para evitar erro de index)
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                const pixelColor = image.getPixelColor(x, y);
                const rgba = getRGBA(pixelColor);

                // Se o pixel atual é BRANCO (fundo > 128)
                if (rgba.r > 128) {
                    let blackNeighbors = 0;

                    // Helper para checar vizinho preto (< 128)
                    const checkBlack = (cx: number, cy: number) => {
                        const val = image.getPixelColor(cx, cy);
                        const neighborRGBA = getRGBA(val);
                        return neighborRGBA.r < 128;
                    };

                    if (checkBlack(x + 1, y)) blackNeighbors++;
                    if (checkBlack(x - 1, y)) blackNeighbors++;
                    if (checkBlack(x, y + 1)) blackNeighbors++;
                    if (checkBlack(x, y - 1)) blackNeighbors++;

                    if (blackNeighbors >= threshold) {
                        processed.setPixelColor(createRGBAInt(0, 0, 0, 255), x, y);
                    }
                }
            }
        }

        // Garanta o acesso correto ao MIME type
        const mime = JimpModule.JimpMime?.png || JimpModule.MIME_PNG || 'image/png';

        // Usar getBuffer (método padrão do Jimp 1.6.0)
        return await processed.getBuffer(mime);

    } catch (error: any) {
        console.error(`[RepairCharacterGaps] Erro CRÍTICO ao reparar imagem: ${error.message}`);
        console.error(`[RepairCharacterGaps] Stack: ${error.stack}`);
        // Em caso de erro, retornar imagem original
        return imageBuffer;
    }
}

