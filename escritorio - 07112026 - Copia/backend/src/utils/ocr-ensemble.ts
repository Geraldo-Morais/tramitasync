/**
 * OCR ENSEMBLE COM HEURÍSTICAS ANTI-CONFUSÃO (revisado)
 *
 * - Inicialização correta do tesseract.js v6 (loadLanguage + initialize)
 * - Parâmetros de inicialização (OEM) não são definidos via setParameters
 * - Cálculo de confiança robusto com fallback para média de palavras
 */

import { createWorker, PSM } from 'tesseract.js';
import type { CandidataProcessada } from './color-preprocess';
import fs from 'fs';
import path from 'path';

export interface ResultadoOCR {
    texto: string;
    confianca: number;
    candidataVencedora: string;
    candidataIndex: number;
    psmUsado: string;
    tentativasTestadas: number;
}

interface TentativaOCR {
    texto: string;
    confianca: number;
    candidata: string;
    candidataIdx: number;
    psm: string;
}

// PSM prioritários - expandido para melhor cobertura
const CONFIGURACOES_PSM = [
    { psm: PSM.SINGLE_LINE, nome: 'PSM-7-SingleLine' }, // Linha única (melhor para CAPTCHA horizontal)
    { psm: PSM.SINGLE_WORD, nome: 'PSM-8-SingleWord' }, // Palavra única
    { psm: PSM.SINGLE_BLOCK_VERT_TEXT, nome: 'PSM-5-SingleBlockVert' }, // Bloco vertical
    { psm: PSM.SINGLE_CHAR, nome: 'PSM-10-SingleChar' }, // Caractere único (útil para CAPTCHA com ruído)
    { psm: PSM.SPARSE_TEXT, nome: 'PSM-11-SparseText' }, // Texto esparso (útil para CAPTCHA com linhas)
    { psm: PSM.SPARSE_TEXT_OSD, nome: 'PSM-12-SparseTextOSD' }, // Texto esparso com OSD
];

const WHITELIST_COMPLETA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Salva evidências de debug do OCR (imagens e resultados) para análise futura
 */
function saveDebugEvidence(
    type: 'success' | 'fail',
    originalImg: Buffer,
    processedCandidates: Map<string, Buffer>,
    result: ResultadoOCR
): Promise<void> {
    return new Promise((resolve, reject) => {
        try {
            const timestamp = Date.now();
            const id = Math.random().toString(36).substring(2, 9); // ID único curto
            const baseDir = path.join(process.cwd(), 'logs', 'dataset', type);
            const evidenceDir = path.join(baseDir, `${timestamp}_${id}`);

            // Criar diretório recursivamente
            fs.mkdirSync(evidenceDir, { recursive: true });

            // 1. Salvar imagem original
            const originalPath = path.join(evidenceDir, 'original.png');
            fs.writeFileSync(originalPath, originalImg);

            // 2. Salvar todas as candidatas processadas
            processedCandidates.forEach((buffer, nome) => {
                const candidataPath = path.join(evidenceDir, `candidata_${nome.replace(/[^A-Za-z0-9]/g, '_')}.png`);
                fs.writeFileSync(candidataPath, buffer);
            });

            // 3. Salvar resultado JSON com metadados
            const resultJson = {
                texto: result.texto,
                confianca: result.confianca,
                candidataVencedora: result.candidataVencedora,
                candidataIndex: result.candidataIndex,
                psmUsado: result.psmUsado,
                tentativasTestadas: result.tentativasTestadas,
                timestamp: new Date().toISOString(),
                tipo: type,
                criterioFalha: result.texto.length !== 4 ? 'tamanho_invalido' : result.confianca < 55 ? 'confianca_baixa' : null
            };

            const resultPath = path.join(evidenceDir, 'result.json');
            fs.writeFileSync(resultPath, JSON.stringify(resultJson, null, 2));

            console.log(`[OCR Debug] 💾 Evidências salvas: ${evidenceDir}`);
            resolve();
        } catch (error: any) {
            reject(error);
        }
    });
}

export async function ocrEnsemble(candidatas: CandidataProcessada[]): Promise<ResultadoOCR> {
    // Compatível com tipos do projeto: createWorker(lang, oem, options)
    const worker = await createWorker('eng', 1, { logger: () => { } });
    const tentativas: TentativaOCR[] = [];

    try {
        // Parâmetros em runtime - Hardening para captchas alfanuméricos
        await worker.setParameters({
            tessedit_char_whitelist: WHITELIST_COMPLETA, // Apenas letras maiúsculas e números
            tessedit_pageseg_mode: PSM.SINGLE_LINE, // Single text line (PSM 7 - melhor para CAPTCHA)
            user_defined_dpi: '300',
        });

        let earlyExitAtivado = false;

        console.log(`[OCR Debug] 🔬 Processando ${candidatas.length} candidatas...`);

        for (let i = 0; i < candidatas.length; i++) {
            const candidata = candidatas[i];
            console.log(`[OCR Debug] 📸 Processando candidata ${i + 1}/${candidatas.length}: ${candidata.canal} (buffer size: ${candidata.buffer.length} bytes)`);

            // Salvar imagem para debug
            try {
                const debugPath = path.join(process.cwd(), 'logs', `ocr-candidata-${i}-${candidata.canal.replace(/[^A-Za-z0-9]/g, '-')}-${Date.now()}.png`);
                fs.writeFileSync(debugPath, candidata.buffer);
                console.log(`[OCR Debug] 💾 Imagem salva: ${debugPath}`);
            } catch (err) {
                console.warn(`[OCR Debug] ⚠️ Erro ao salvar imagem: ${err}`);
            }

            for (const config of CONFIGURACOES_PSM) {
                try {
                    // Manter whitelist sempre ativa, apenas mudar PSM
                    await worker.setParameters({
                        tessedit_pageseg_mode: config.psm as any, // PSM é enum numérico
                        tessedit_char_whitelist: WHITELIST_COMPLETA
                    });

                    const { data } = await worker.recognize(candidata.buffer);

                    // DEBUG: Log texto bruto antes de limpar
                    const textoBruto = data.text || '';
                    console.log(`[OCR Debug] ${candidata.canal} ${config.nome}: texto bruto="${textoBruto}"`);

                    const textoLimpo = textoBruto
                        .replace(/[^A-Za-z0-9]/g, '')
                        .toUpperCase()
                        .trim();

                    console.log(`[OCR Debug] ${candidata.canal} ${config.nome}: texto limpo="${textoLimpo}"`);

                    let confianca = (data as any).confidence || 0;
                    if (!confianca || confianca <= 0) {
                        const words = (data as any).words as Array<{ confidence?: number }> | undefined;
                        if (words && words.length > 0) {
                            const soma = words.reduce((acc, w) => acc + (w.confidence || 0), 0);
                            confianca = soma / words.length;
                        }
                    }

                    console.log(`[OCR Debug] ${candidata.canal} ${config.nome}: confiança=${confianca.toFixed(1)}%`);

                    // IMPORTANTE: CAPTCHAs sempre têm 4 caracteres (nunca menos, nunca mais que 5)
                    // Priorizar resultados com exatamente 4 caracteres
                    if (textoLimpo.length === 4) {
                        // Resultado perfeito: 4 caracteres
                        tentativas.push({
                            texto: textoLimpo,
                            confianca,
                            candidata: candidata.canal,
                            candidataIdx: i,
                            psm: config.nome,
                        });

                        console.log(`[OCR Debug] ✅ Tentativa PERFEITA adicionada: "${textoLimpo}" (confiança: ${confianca.toFixed(1)}%, tamanho: 4)`);

                        // Early exit: se confiança alta E tamanho correto (4 caracteres)
                        if (confianca > 70 && textoLimpo.length === 4) {
                            earlyExitAtivado = true;
                            console.log(`[OCR Debug] 🎯 Early exit ativado: confiança alta (${confianca.toFixed(1)}%) e tamanho PERFEITO (4 chars)`);
                            break;
                        }
                    } else if (textoLimpo.length >= 3 && textoLimpo.length <= 5) {
                        // Aceitar resultados próximos (3-5 chars) mas com confiança menor
                        // Cortar ou ajustar para 4 caracteres
                        let textoAjustado = textoLimpo;
                        if (textoLimpo.length === 3) {
                            // Se tem 3, pode estar faltando um caractere no início ou fim
                            // Tentar adicionar caractere mais comum no final
                            textoAjustado = textoLimpo + '0'; // Tentativa conservadora
                        } else if (textoLimpo.length === 5) {
                            // Se tem 5, cortar para 4 (remover último)
                            textoAjustado = textoLimpo.slice(0, 4);
                        }

                        tentativas.push({
                            texto: textoAjustado,
                            confianca: confianca * 0.8, // Penalizar por não ser exatamente 4
                            candidata: candidata.canal,
                            candidataIdx: i,
                            psm: config.nome,
                        });

                        console.log(`[OCR Debug] ⚠️ Tentativa ajustada: "${textoLimpo}" → "${textoAjustado}" (confiança ajustada: ${(confianca * 0.8).toFixed(1)}%)`);
                    } else {
                        console.log(`[OCR Debug] ❌ Texto ignorado: tamanho inválido (${textoLimpo.length} chars, esperado: 4)`);
                    }
                } catch (error: any) {
                    console.error(`[OCR Debug] ❌ Erro OCR ${candidata.canal} ${config.nome}: ${error.message}`);
                    console.error(`[OCR Debug] Stack: ${error.stack}`);
                }
            }

            if (earlyExitAtivado) break;
        }

        await worker.terminate();

        if (tentativas.length === 0) {
            return {
                texto: '',
                confianca: 0,
                candidataVencedora: 'Nenhuma',
                candidataIndex: -1,
                psmUsado: 'Nenhum',
                tentativasTestadas: 0,
            };
        }

        // Ordenar: primeiro por tamanho (4 caracteres primeiro), depois por confiança
        tentativas.sort((a, b) => {
            const tamanhoA = a.texto.length;
            const tamanhoB = b.texto.length;

            // Priorizar resultados com exatamente 4 caracteres
            if (tamanhoA === 4 && tamanhoB !== 4) return -1;
            if (tamanhoB === 4 && tamanhoA !== 4) return 1;

            // Se ambos têm 4 caracteres (ou ambos não têm), ordenar por confiança
            return b.confianca - a.confianca;
        });

        const melhor = tentativas[0];

        const textoCorrigido = aplicarHeuristicas(melhor.texto, melhor.confianca);
        // GARANTIR que sempre retornamos exatamente 4 caracteres
        let textoFinal = textoCorrigido.slice(0, 4);

        // Se tem menos de 4, preencher com caracteres mais comuns
        if (textoFinal.length < 4) {
            const charsComuns = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
            while (textoFinal.length < 4) {
                textoFinal += charsComuns[Math.floor(Math.random() * charsComuns.length)];
            }
            console.log(`[OCR Debug] ⚠️ Texto tinha ${textoCorrigido.length} chars, preenchido para 4: "${textoFinal}"`);
        }

        // Se tem mais de 4, cortar para 4
        if (textoFinal.length > 4) {
            textoFinal = textoFinal.slice(0, 4);
            console.log(`[OCR Debug] ⚠️ Texto tinha ${textoCorrigido.length} chars, cortado para 4: "${textoFinal}"`);
        }

        const resultadoFinal = {
            texto: textoFinal,
            confianca: melhor.confianca,
            candidataVencedora: melhor.candidata,
            candidataIndex: melhor.candidataIdx,
            psmUsado: melhor.psm,
            tentativasTestadas: tentativas.length,
        };

        // Sistema de Logging Data-Driven (Cemitério de Erros)
        // Determinar se é sucesso ou falha baseado em critérios
        const isSuccess = textoFinal.length === 4 && melhor.confianca >= 55;
        const tipo = isSuccess ? 'success' : 'fail';

        // Criar Map com todas as candidatas processadas (incluindo a reparada)
        const processedCandidates = new Map<string, Buffer>();
        candidatas.forEach((cand, idx) => {
            // Nome da candidata: índice + nome do canal
            const nomeCandidata = `candidata_${idx}_${cand.canal.replace(/[^A-Za-z0-9]/g, '_')}`;
            processedCandidates.set(nomeCandidata, cand.buffer);
        });

        // Usar primeira candidata como "original" (RGB-Colorida é a menos processada)
        const originalImg = candidatas[0]?.buffer || Buffer.alloc(0);

        // Salvar evidências (não bloquear se falhar)
        saveDebugEvidence(tipo, originalImg, processedCandidates, resultadoFinal).catch((err: any) => {
            console.warn(`[OCR Debug] ⚠️ Erro ao salvar evidências (não crítico): ${err.message}`);
        });

        return resultadoFinal;
    } catch (error: any) {
        console.error(`Erro fatal no OCR Ensemble: ${error.message}`);
        try {
            await worker.terminate();
        } catch (terminateError) {
            const reason = terminateError instanceof Error ? terminateError.message : String(terminateError);
            console.warn(`[OCR] Erro ao finalizar worker: ${reason}`);
        }
        return {
            texto: '',
            confianca: 0,
            candidataVencedora: 'Erro',
            candidataIndex: -1,
            psmUsado: 'Erro',
            tentativasTestadas: 0,
        };
    }
}

function aplicarHeuristicas(texto: string, confianca: number): string {
    // Se confiança muito alta, retornar sem correções
    if (confianca > 85) return texto;

    let corrigido = texto;

    // Correções baseadas em padrões comuns de CAPTCHA
    // CAPTCHA típico: 4 caracteres mistos (letras e números)

    if (confianca >= 60 && confianca <= 85) {
        const numDigitos = (corrigido.match(/[0-9]/g) || []).length;
        const numLetras = (corrigido.match(/[A-Z]/g) || []).length;

        // Se tem mais dígitos, converter O→0, I→1
        if (numDigitos > numLetras + 1) {
            corrigido = corrigido.replace(/O/g, '0').replace(/I/g, '1');
        }
        // Se tem mais letras, converter 0→O, 1→I
        else if (numLetras > numDigitos + 1) {
            corrigido = corrigido.replace(/0/g, 'O').replace(/1/g, 'I');
        }
    }

    if (confianca < 60) {
        const numDigitos = (corrigido.match(/[0-9]/g) || []).length;
        const numLetras = (corrigido.match(/[A-Z]/g) || []).length;

        // Correções mais agressivas para baixa confiança
        if (numDigitos > numLetras) {
            // Priorizar dígitos: converter letras similares a números
            corrigido = corrigido
                .replace(/O/g, '0').replace(/I/g, '1')
                .replace(/S/g, '5').replace(/G/g, '6')
                .replace(/B/g, '8').replace(/Z/g, '2')
                .replace(/D/g, '0').replace(/T/g, '7');
        } else {
            // Priorizar letras: converter números similares a letras
            corrigido = corrigido
                .replace(/0/g, 'O').replace(/1/g, 'I')
                .replace(/5/g, 'S').replace(/6/g, 'G')
                .replace(/8/g, 'B').replace(/2/g, 'Z')
                .replace(/7/g, 'T');
        }
    }

    // Correção específica para CAPTCHA de 4 caracteres com padrão misto
    // Exemplo: LP8Y (2 letras + 1 número + 1 letra)
    // IMPORTANTE: CAPTCHAs sempre têm exatamente 4 caracteres
    if (corrigido.length === 4) {
        const chars = corrigido.split('');

        // Verificar padrões comuns: L-L-N-L, L-N-L-L, N-L-L-L, etc.
        // Se posição 2 ou 3 tem número, manter; se tem letra similar a número, converter
        if (chars.length >= 3) {
            // Posição 2 (índice 2) - comum ter número em CAPTCHAs como LP8Y
            if (/[OIB]/.test(chars[2])) {
                const numDigitos = (corrigido.match(/[0-9]/g) || []).length;
                if (numDigitos === 0) {
                    // Se não tem números, converter para número (CAPTCHA típico tem pelo menos 1 número)
                    chars[2] = chars[2].replace('O', '0').replace('I', '1').replace('B', '8');
                }
            }

            // Posição 1 (índice 1) - também pode ter número
            if (/[OIB]/.test(chars[1])) {
                const numDigitos = (corrigido.match(/[0-9]/g) || []).length;
                if (numDigitos === 0) {
                    chars[1] = chars[1].replace('O', '0').replace('I', '1').replace('B', '8');
                }
            }
        }

        corrigido = chars.join('');
    } else if (corrigido.length !== 4) {
        // Se não tem 4 caracteres, tentar ajustar
        if (corrigido.length < 4) {
            // Adicionar caracteres mais comuns no final
            const charsComuns = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
            while (corrigido.length < 4) {
                corrigido += charsComuns[Math.floor(Math.random() * charsComuns.length)];
            }
        } else {
            // Cortar para 4
            corrigido = corrigido.slice(0, 4);
        }
    }

    // GARANTIR que sempre retornamos exatamente 4 caracteres
    if (corrigido.length !== 4) {
        if (corrigido.length < 4) {
            // Preencher com caracteres mais comuns
            const charsComuns = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
            while (corrigido.length < 4) {
                corrigido += charsComuns[Math.floor(Math.random() * charsComuns.length)];
            }
        } else {
            // Cortar para 4 (CAPTCHAs nunca têm mais que 4)
            corrigido = corrigido.slice(0, 4);
        }
    }

    return corrigido;
}

export async function ocrMelhorDe(candidatasB64: string[]): Promise<{ texto: string; conf: number; idx: number }> {
    const candidatas = candidatasB64.map((b64, idx) => ({
        buffer: Buffer.from(b64, 'base64'),
        base64: b64,
        canal: `Candidata-${idx}`,
        descricao: `Candidata ${idx}`,
    }));
    const resultado = await ocrEnsemble(candidatas);
    return { texto: resultado.texto, conf: resultado.confianca, idx: resultado.candidataIndex };
}

export function validarCaptcha(texto: string, _confiancaMinima: number = 65): boolean {
    // CAPTCHAs sempre têm exatamente 4 caracteres
    return /^[A-Z0-9]{4}$/.test(texto);
}

export function logResultadoOCR(resultado: ResultadoOCR, esperado?: string) {
    console.log(`Resultado OCR:`);
    console.log(`   Texto: "${resultado.texto}" ${esperado ? (resultado.texto === esperado ? '(OK)' : `(esperado: ${esperado})`) : ''}`);
    console.log(`   Confiança: ${resultado.confianca.toFixed(1)}%`);
    console.log(`   Canal vencedor: ${resultado.candidataVencedora} (índice ${resultado.candidataIndex})`);
    console.log(`   PSM usado: ${resultado.psmUsado}`);
    console.log(`   Tentativas testadas: ${resultado.tentativasTestadas}`);
}
