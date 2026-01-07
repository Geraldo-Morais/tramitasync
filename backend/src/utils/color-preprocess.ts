/**
 * PRÉ-PROCESSAMENTO COLOR-AWARE PARA OCR
 * 
 * Estratégia: gerar múltiplas versões "candidatas" da imagem,
 * explorando diferentes canais de cor (RGB, HSV-like, Luminância)
 * para maximizar contraste em fundos coloridos (amarelo, rosa, azul, etc.)
 * 
 * Observações dos testes:
 * - Fundos amarelos: canal B (azul) e luminância separam melhor
 * - Fundos vermelhos/rosa: canal G (verde) funciona bem
 * - Fundos azuis: canal R (vermelho) e luminância
 * - Fundos verdes: luminância e canal R
 */

import sharp from 'sharp';

export interface CandidataProcessada {
    buffer: Buffer;
    base64: string;
    canal: string;
    descricao: string;
}

/**
 * Gera múltiplas versões "candidatas" otimizadas para OCR
 * Cada candidata explora um canal de cor diferente
 */
export async function gerarCandidatasColorAware(imagemBase64: string): Promise<CandidataProcessada[]> {
    const inputBuffer = Buffer.from(imagemBase64, 'base64');

    // 1) UPSCALE com Sharp (2x) + sharpen leve
    const sharpImg = sharp(inputBuffer);
    const metadata = await sharpImg.metadata();
    const width = Math.max(280, Math.round((metadata.width || 160) * 2));
    const height = Math.max(100, Math.round((metadata.height || 60) * 2));

    const upscaledBuffer = await sharpImg
        .resize({
            width,
            height,
            kernel: 'lanczos3',
            fit: 'fill'
        })
        .sharpen({ sigma: 0.5 })
        .toBuffer();

    const candidatas: CandidataProcessada[] = [];

    // CANDIDATA 0: Imagem colorida original (upscaled) - converter para PNG
    const upscaledPng = await sharp(upscaledBuffer).png().toBuffer();
    candidatas.push({
        buffer: upscaledPng,
        base64: upscaledPng.toString('base64'),
        canal: 'RGB-Original',
        descricao: 'Imagem colorida upscaled (baseline)'
    });

    // 2) Extrair canais RGB usando Sharp
    const { data, info } = await sharp(upscaledBuffer)
        .raw()
        .toBuffer({ resolveWithObject: true });

    const w = info.width;
    const h = info.height;
    const channels = info.channels;

    // Alocar buffers para cada canal
    const R = Buffer.alloc(w * h);
    const G = Buffer.alloc(w * h);
    const B = Buffer.alloc(w * h);
    const Y = Buffer.alloc(w * h); // Luminância (0.299R + 0.587G + 0.114B)

    // Separar canais RGB do buffer interleaved
    for (let i = 0, j = 0; i < data.length; i += channels, j++) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        R[j] = r;
        G[j] = g;
        B[j] = b;
        Y[j] = Math.min(255, Math.round(0.299 * r + 0.587 * g + 0.114 * b));
    }

    // Helper: processar canal cinza para OCR
    const processarCanal = async (canal: Buffer, nome: string, desc: string) => {
        try {
            const processado = await sharp(canal, {
                raw: { width: w, height: h, channels: 1 }
            })
                .normalize()      // Equaliza histograma
                .linear(1.2, 0)   // Aumenta contraste (gain=1.2)
                .sharpen()        // Aguça bordas
                .threshold(128)   // Binarização (Otsu-like)
                .png()            // Converter para PNG válido
                .toBuffer();


            candidatas.push({
                buffer: processado,
                base64: processado.toString('base64'),
                canal: nome,
                descricao: desc
            });
        } catch (error: any) {
            console.warn(`⚠️ Erro processando ${nome}: ${error.message}`);
        }
    };

    // CANDIDATA 1: Canal R (vermelho) - bom para fundos azuis/verdes
    await processarCanal(R, 'RGB-R', 'Canal vermelho (ótimo p/ fundos azuis/verdes)');

    // CANDIDATA 2: Canal G (verde) - bom para fundos rosa/vermelho
    await processarCanal(G, 'RGB-G', 'Canal verde (ótimo p/ fundos rosa/vermelho)');

    // CANDIDATA 3: Canal B (azul) - EXCELENTE para fundos amarelos
    await processarCanal(B, 'RGB-B', 'Canal azul (MELHOR p/ fundos amarelos!)');

    // CANDIDATA 4: Luminância - robusta para a maioria dos casos
    await processarCanal(Y, 'Luminância', 'Luminância Y (0.299R+0.587G+0.114B)');

    // CANDIDATA 5: Grayscale "clássico" do Sharp (SEM threshold)
    try {
        const grayscaleClassico = await sharp(upscaledBuffer)
            .grayscale()
            .normalize()
            .linear(1.2, 0)
            .sharpen()
            .png()
            .toBuffer();

        candidatas.push({
            buffer: grayscaleClassico,
            base64: grayscaleClassico.toString('base64'),
            canal: 'Grayscale-Normalizado',
            descricao: 'Grayscale normalizado (sem binarização)'
        });
    } catch (error: any) {
        console.warn(`⚠️ Erro processando Grayscale: ${error.message}`);
    }

    return candidatas;
}

/**
 * Versão simplificada: retorna apenas Base64 das candidatas
 * (para manter compatibilidade com código existente)
 */
export async function gerarCandidatasBase64(imagemBase64: string): Promise<string[]> {
    const candidatas = await gerarCandidatasColorAware(imagemBase64);
    return candidatas.map(c => c.base64);
}

/**
 * Detecta cor dominante do fundo para priorizar canais
 * Retorna sugestão de ordem de teste
 */
export function priorizarCanaisPorCor(_imagemBase64: string): string[] {
    // Análise simplificada da cor dominante
    // Em produção, você pode fazer um histograma RGB real

    // Por padrão, ordem baseada nos testes:
    // 1. Canal B (amarelos)
    // 2. Luminância (geral)
    // 3. Canal G (rosa/vermelho)
    // 4. Canal R (azul/verde)
    // 5. Colorida original
    // 6. Grayscale
    // 7. Alto contraste

    return [
        'RGB-B',                        // MELHOR para amarelos (P2Q6R8)
        'Luminância',                   // Robusto geral
        'RGB-G',                        // Bom para rosa/vermelho
        'RGB-R',                        // Bom para azul/verde
        'RGB-Original',                 // Baseline colorido
        'Luminância-Alto-Contraste',    // Textos muito escuros
        'Grayscale'                     // Baseline processado
    ];
}
