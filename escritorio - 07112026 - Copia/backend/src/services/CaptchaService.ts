/**

 * ?? CAPTCHA SERVICE

 * 

 * Sistema híbrido para resolver CAPTCHA do INSS:

 * 1. Tenta OCR gratuito (Tesseract.js)

 * 2. Se falhar, solicita input manual via frontend

 * 3. Preenche automaticamente no modal do PAT

 */



import logger from '../utils/logger';

import config from '../config';

import { Page, ElementHandle } from 'puppeteer';

import { gerarCandidatasProducao } from '../utils/color-preprocess-producao';

import { ocrEnsemble, logResultadoOCR } from '../utils/ocr-ensemble';

import path from 'path';

import sharp from 'sharp';

import AIService from './AIService';
import * as fs from 'fs';



// XPaths do modal de CAPTCHA (fluxos antigo e novo)
const CAPTCHA_MODAL_BASE_XPATH = '(/html/body/div[8]/div[2]) | (//*[@id="modal-recaptcha_modal-label"]/ancestor::div[contains(@class,"dtp-modal")])';
const CAPTCHA_MODAL_XPATH = `(${CAPTCHA_MODAL_BASE_XPATH})`; // Modal principal
const CAPTCHA_CONTAINER_XPATH = `${CAPTCHA_MODAL_XPATH}//div[contains(@class,"content-container") or contains(@class,"dtp-modal-content")]`;
const CAPTCHA_INPUT_XPATH = `${CAPTCHA_MODAL_XPATH}//input[@type="text" or @maxlength>=4]`; // Campo de texto
const CAPTCHA_IMAGE_XPATH = `${CAPTCHA_MODAL_XPATH}//img[contains(@src,"data:image")]`; // Imagem do CAPTCHA
const CAPTCHA_BUTTON_XPATH = `${CAPTCHA_MODAL_XPATH}//button[contains(translate(normalize-space(.),'CONFIRMAR','confirmar'),'confirmar')]`; // Botão Confirmar
const CAPTCHA_TEXT_FALLBACK_XPATH = `${CAPTCHA_CONTAINER_XPATH}//p/text()`; // Texto orientativo (fallback)

const CAPTCHA_BACKDROP_SELECTOR = '.dtp-modal-backdrop';



interface CaptchaData {

    imagemBase64: string;

    sessionId: string;

    timestamp: string;

}



interface CaptchaResult {

    sucesso: boolean;

    texto?: string;

    metodo: 'ocr' | 'ocr-ensemble' | 'manual' | 'api';

    confianca?: number;

    detalhes?: Record<string, any>;

}



export class CaptchaService {

    private resolvendoCaptcha: Map<string, CaptchaData> = new Map();

    private resultadosCaptcha: Map<string, string> = new Map();

    private aiService: any; // AIService - usando any para evitar problemas de tipo circular

    constructor() {
        // Importar dinamicamente para evitar problemas de tipo
        // O AIService tem tanto export class AIService quanto export default new AIService()
        // Vamos usar a classe diretamente
        const AIServiceModule = require('./AIService');
        // Usar a classe exportada diretamente
        this.aiService = new AIServiceModule.AIService();
    }



    /**

     * ?? Captura screenshot do CAPTCHA do modal (OTIMIZADO PARA PRODUÇÃO)

     * 

     * Otimizações para site real:

     * - DeviceScaleFactor 2x (alta resolução)

     * - Encoding binary (sem compressão)

     * - Crop automático (remove bordas)

     * - Validação de mudança de pixels (evita capturas em branco)

     * - DPI 300 lógico para Tesseract

     * - Mantém cor original (processamento depois)

     */

    async capturarImagemCaptcha(page: Page, sessionId: string): Promise<string | null> {

        const MAX_RETRIES = 3;

        const RETRY_DELAY_MS = 1000;

        let ultimoBase64 = '';
        let captchaElement: ElementHandle<Element> | null = null;
        let metodoUsado: string = '';

        // CRÍTICO: Verificar se o CAPTCHA está visível ANTES de tentar capturar
        const modalVisivel = await this.isCaptchaModalVisivel(page);
        if (!modalVisivel) {
            logger.warn('[CaptchaService] ?? CAPTCHA não está visível segundo isCaptchaModalVisivel!');
            logger.warn('[CaptchaService] ?? Verificando novamente com waitForXPath...');

            // Tentar aguardar o modal aparecer
            try {
                await page.waitForXPath(CAPTCHA_MODAL_XPATH, { timeout: 3000, visible: true });
                logger.info('[CaptchaService] ? Modal apareceu após espera!');
            } catch {
                logger.warn('[CaptchaService] ?? Modal não apareceu mesmo após espera. Não tentando capturar.');
                await this.salvarSnapshotCaptcha(page, 'captcha-modal-nao-visivel');
                return null;
            }
        } else {
            logger.info('[CaptchaService] ? CAPTCHA está visível, iniciando captura...');
        }

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {

            try {

                logger.info(`[CaptchaService] ?? Capturando CAPTCHA real (tentativa ${attempt}/${MAX_RETRIES})...`);

                // Aguardar modal estar visível antes de tentar capturar
                try {
                    await page.waitForXPath(CAPTCHA_MODAL_XPATH, { timeout: 2000, visible: true });
                    logger.info(`[CaptchaService] ? Modal confirmado visível na tentativa ${attempt}`);
                } catch {
                    logger.warn(`[CaptchaService] ?? Modal não apareceu no timeout da tentativa ${attempt}`);
                    await this.salvarSnapshotCaptcha(page, `captcha-modal-timeout-${attempt}`);
                    if (attempt < MAX_RETRIES) {
                        await page.waitForTimeout(RETRY_DELAY_MS * attempt);
                        continue;
                    } else {
                        logger.error('[CaptchaService] ? Modal não apareceu após todas as tentativas.');
                        return null;
                    }
                }

                // GARANTIR HIGH DPI (apenas quando não estamos usando o Chrome do usuário)

                const usarChromeExistente = config?.inss?.useExistingChrome;

                if (!usarChromeExistente) {

                    try {

                        await page.setViewport({

                            width: 1920,

                            height: 1080,

                            deviceScaleFactor: 2 // 2x resolução física

                        });

                        logger.debug('[CaptchaService] ? DeviceScaleFactor = 2 (high-DPI)');

                    } catch (err) {

                        logger.warn('[CaptchaService] ?? Não foi possível ajustar viewport');

                    }

                } else {

                    logger.debug('[CaptchaService] ?? Mantendo viewport original do Chrome para não deslocar o modal');

                }



                // Aguardar modal de CAPTCHA estar visível usando XPath absoluto
                try {
                    await page.waitForXPath(CAPTCHA_MODAL_XPATH, { timeout: 5000, visible: true });
                    logger.info('[CaptchaService] ? Modal detectado via XPath absoluto');
                } catch {
                    logger.warn('[CaptchaService] ?? Modal não apareceu no timeout - CAPTCHA pode não estar visível!');
                    // Se não conseguiu encontrar o modal, não tentar capturar
                    if (attempt === MAX_RETRIES) {
                        logger.error('[CaptchaService] ? Não foi possível encontrar modal do CAPTCHA após todas as tentativas.');
                        return null;
                    }
                    await page.waitForTimeout(RETRY_DELAY_MS * attempt);
                    continue;
                }



                // PRIORIDADE 1: Extrair base64 DIRETAMENTE do src da imagem (já vem pronto, sem crop)
                logger.info('[CaptchaService] ?? Tentando extrair base64 diretamente do src da imagem...');
                const base64DiretoDaImagem = await this.extrairBase64DiretoDaImagem(page);
                if (base64DiretoDaImagem) {
                    logger.info('[CaptchaService] ? Base64 extraído diretamente do HTML (sem crop)!');
                    return base64DiretoDaImagem;
                }

                // PRIORIDADE 2: Buscar imagem usando XPath absoluto para screenshot
                // Resetar variáveis para esta tentativa
                captchaElement = null;
                metodoUsado = '';

                try {
                    const imageHandles = await page.$x(CAPTCHA_IMAGE_XPATH);
                    if (imageHandles.length > 0) {
                        captchaElement = imageHandles[0] as ElementHandle<Element>;
                        metodoUsado = 'XPath absoluto';
                        logger.info('[CaptchaService] ? Imagem encontrada via XPath absoluto');
                    }
                } catch (error) {
                    logger.warn('[CaptchaService] ?? Erro ao buscar imagem via XPath, tentando seletores CSS...');
                }

                // FALLBACK: Seletores CSS
                if (!captchaElement) {
                    const seletores = [
                        '#modal-recaptcha canvas',
                        '#modal-recaptcha img.captcha-image',
                        '#modal-recaptcha img[src*="captcha"]',
                        '#modal-recaptcha img[src^="data:image/png;base64"]',
                        '#modal-recaptcha img[alt*="captcha" i]',
                        '.dtp-modal-content canvas',
                        '.dtp-modal-content img'
                    ];

                    for (const seletor of seletores) {
                        captchaElement = await page.$(seletor);
                        if (captchaElement) {
                            metodoUsado = `CSS: ${seletor}`;
                            logger.debug(`[CaptchaService] ? Elemento encontrado: ${seletor}`);
                            break;
                        }
                    }
                }

                if (!captchaElement) {
                    logger.warn('[CaptchaService] ?? Elemento específico não encontrado, tentando screenshot do modal...');



                    // MÉTODO 2 (FALLBACK): Screenshot do modal inteiro

                    logger.warn('[CaptchaService] ?? Tentando screenshot do modal como fallback...');

                    const captchaViaModal = await this.capturarViaScreenshotModal(page, sessionId);

                    if (captchaViaModal) {

                        return captchaViaModal;

                    }



                    if (attempt < MAX_RETRIES) {

                        await page.waitForTimeout(RETRY_DELAY_MS * attempt);

                        continue;

                    }

                    return null;

                }



                // AGUARDAR REDESENHO (validar que dataURL mudou)
                // Se encontrou via XPath, usar XPath também para verificar mudança
                let imagemMudou = false;

                if (metodoUsado === 'XPath absoluto') {
                    // Usar XPath para verificar se imagem mudou
                    imagemMudou = await page.evaluate((imageXPath: string, ultimaImg: string) => {
                        try {
                            const result = document.evaluate(imageXPath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                            const elem = result.singleNodeValue as HTMLImageElement | null;

                            if (!elem) return false;

                            if (elem.tagName === 'CANVAS') {
                                const canvas = elem as unknown as HTMLCanvasElement;
                                const novaImg = canvas.toDataURL();
                                return novaImg !== ultimaImg && novaImg.length > 100;
                            }

                            const img = elem as unknown as HTMLImageElement;
                            return img.src !== ultimaImg && img.complete;
                        } catch (error) {
                            return false;
                        }
                    }, CAPTCHA_IMAGE_XPATH, ultimoBase64);
                } else {
                    // Usar seletor CSS
                    imagemMudou = await page.evaluate((sel: string, ultimaImg: string) => {
                        const elem = document.querySelector(sel);
                        if (!elem) return false;

                        if (elem.tagName === 'CANVAS') {
                            const canvas = elem as HTMLCanvasElement;
                            const novaImg = canvas.toDataURL();
                            return novaImg !== ultimaImg && novaImg.length > 100;
                        }

                        const img = elem as HTMLImageElement;
                        return img.src !== ultimaImg && img.complete;
                    }, metodoUsado, ultimoBase64);
                }



                if (!imagemMudou && attempt > 1) {

                    logger.warn('[CaptchaService] ?? CAPTCHA não mudou desde última captura');

                    await page.waitForTimeout(1000);

                    continue;

                }



                // VALIDAR RENDER COMPLETO (verificar mudança de pixels)
                // Se encontrou via XPath, usar XPath também para validar render
                let renderCompleto = false;

                if (metodoUsado === 'XPath absoluto') {
                    renderCompleto = await page.evaluate((imageXPath: string) => {
                        try {
                            const result = document.evaluate(imageXPath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                            const element = result.singleNodeValue as HTMLImageElement | HTMLCanvasElement | null;

                            if (!element) return false;

                            if (element.tagName === 'CANVAS') {
                                const canvas = element as HTMLCanvasElement;
                                const ctx = canvas.getContext('2d');
                                if (!ctx || canvas.width < 10 || canvas.height < 10) return false;

                                const pontos = [
                                    ctx.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data,
                                    ctx.getImageData(canvas.width / 4, canvas.height / 2, 1, 1).data,
                                    ctx.getImageData(canvas.width * 3 / 4, canvas.height / 2, 1, 1).data
                                ];

                                return pontos.some(p => p[0] < 240 || p[1] < 240 || p[2] < 240);
                            }

                            const img = element as HTMLImageElement;
                            return img.complete && img.naturalWidth > 50 && img.naturalHeight > 20;
                        } catch (error) {
                            return false;
                        }
                    }, CAPTCHA_IMAGE_XPATH);
                } else {
                    renderCompleto = await page.evaluate((selector: string) => {
                        const element = document.querySelector(selector);
                        if (!element) return false;

                        // Canvas: verificar pixels centrais não-brancos
                        if (element.tagName === 'CANVAS') {
                            const canvas = element as HTMLCanvasElement;
                            const ctx = canvas.getContext('2d');
                            if (!ctx || canvas.width < 10 || canvas.height < 10) return false;

                            // Testar 3 pontos (centro, 1/4, 3/4)
                            const pontos = [
                                ctx.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data,
                                ctx.getImageData(canvas.width / 4, canvas.height / 2, 1, 1).data,
                                ctx.getImageData(canvas.width * 3 / 4, canvas.height / 2, 1, 1).data
                            ];

                            // Pelo menos 1 ponto deve ser não-branco
                            return pontos.some(p => p[0] < 240 || p[1] < 240 || p[2] < 240);
                        }

                        // Img: verificar que carregou e tem tamanho razoável
                        const img = element as HTMLImageElement;
                        return img.complete && img.naturalWidth > 50 && img.naturalHeight > 20;
                    }, metodoUsado);
                }

                if (!renderCompleto) {
                    logger.warn('[CaptchaService] ?? CAPTCHA não renderizado completamente');
                    await page.waitForTimeout(800); // Aguardar mais tempo
                }

                // CAPTURA COM ENCODING BINARY (sem compressão)
                const screenshotBuffer = await captchaElement.screenshot({

                    type: 'png',

                    encoding: 'binary'

                }) as Buffer;

                // DEBUG: Salvar imagem ANTES do processamento
                try {
                    const sharpDebug = (await import('sharp')).default;
                    const debugPathAntes = path.join(process.cwd(), 'logs', `captcha-antes-processamento-${Date.now()}.png`);
                    await sharpDebug(screenshotBuffer).toFile(debugPathAntes);
                    const metadataAntes = await sharpDebug(screenshotBuffer).metadata();
                    logger.info(`[CaptchaService] ?? Imagem ANTES processamento salva: ${debugPathAntes} (${metadataAntes.width}x${metadataAntes.height}px, ${(screenshotBuffer.length / 1024).toFixed(1)}KB)`);
                } catch (err) {
                    logger.warn(`[CaptchaService] ?? Erro ao salvar imagem antes processamento: ${err}`);
                }

                if (!screenshotBuffer || screenshotBuffer.length < 500) {

                    logger.warn('[CaptchaService] ?? Screenshot muito pequeno');

                    if (attempt < MAX_RETRIES) {

                        await page.waitForTimeout(RETRY_DELAY_MS * attempt);

                        continue;

                    }

                    return null;

                }



                // PROCESSAR: Validar Contraste + Crop + Upscale + DPI 300

                const sharp = (await import('sharp')).default;



                // VALIDAR CONTRASTE (evitar imagens "lavadas")

                const stats = await sharp(screenshotBuffer).stats();

                const desvioPadrao = (stats.channels[0].stdev + stats.channels[1].stdev + stats.channels[2].stdev) / 3;



                if (desvioPadrao < 25) {

                    logger.warn(`[CaptchaService] ?? Contraste baixo (s=${desvioPadrao.toFixed(1)}) - tentando novamente`);

                    if (attempt < MAX_RETRIES) {

                        await page.waitForTimeout(1000);

                        continue;

                    }

                }



                logger.debug(`[CaptchaService] ?? Contraste: s=${desvioPadrao.toFixed(1)}`);



                const metadata = await sharp(screenshotBuffer).metadata();

                logger.debug(`[CaptchaService] ?? Tamanho original: ${metadata.width}x${metadata.height}px`);



                // NÃO fazer crop automático - usar imagem completa para evitar cortar o CAPTCHA
                // O crop estava cortando demais e perdendo partes do CAPTCHA
                let processado = sharp(screenshotBuffer);



                // Upscale se necessário (mínimo 280px largura)

                const larguraMinima = 280;

                if (metadata.width && metadata.width < larguraMinima) {

                    const fator = larguraMinima / metadata.width;

                    processado = processado.resize({

                        width: larguraMinima,

                        kernel: 'lanczos3', // Melhor qualidade

                        withoutEnlargement: false

                    });

                    logger.debug(`[CaptchaService] ?? Upscale ${fator.toFixed(1)}x (${metadata.width}px ? ${larguraMinima}px)`);

                }



                // Definir DPI 300 (importante para Tesseract)

                processado = processado.withMetadata({

                    density: 300 // DPI lógico

                });



                const imagemFinal = await processado.png().toBuffer();

                // DEBUG: Salvar imagem DEPOIS do processamento
                try {
                    const debugPathDepois = path.join(process.cwd(), 'logs', `captcha-depois-processamento-${Date.now()}.png`);
                    await sharp(imagemFinal).toFile(debugPathDepois);
                    const metadataDepois = await sharp(imagemFinal).metadata();
                    logger.info(`[CaptchaService] ?? Imagem DEPOIS processamento salva: ${debugPathDepois} (${metadataDepois.width}x${metadataDepois.height}px, ${(imagemFinal.length / 1024).toFixed(1)}KB)`);
                } catch (err) {
                    logger.warn(`[CaptchaService] ?? Erro ao salvar imagem depois processamento: ${err}`);
                }

                const base64Final = imagemFinal.toString('base64');



                // VALIDAR MUDANÇA (evitar OCR repetido se imagem não mudou)

                if (base64Final === ultimoBase64) {

                    logger.warn('[CaptchaService] ?? Imagem não mudou desde última captura');

                    await page.waitForTimeout(1000);

                    continue;

                }



                ultimoBase64 = base64Final;



                // Armazenar para solicitação manual se OCR falhar

                this.resolvendoCaptcha.set(sessionId, {

                    imagemBase64: base64Final,

                    sessionId,

                    timestamp: new Date().toISOString()

                });



                logger.info('[CaptchaService] ? Captura otimizada para produção');

                logger.debug(`[CaptchaService] ?? Tamanho final: ${(imagemFinal.length / 1024).toFixed(1)}KB | Base64: ${base64Final.length} chars`);



                return base64Final;



            } catch (error: any) {
                logger.error(`[CaptchaService] ? Erro na tentativa ${attempt}:`);
                logger.error(`[CaptchaService] Mensagem: ${error.message}`);
                logger.error(`[CaptchaService] Stack: ${error.stack}`);
                // Variáveis podem não estar definidas se erro ocorreu antes da captura
                try {
                    logger.error(`[CaptchaService] Método usado: ${metodoUsado || 'N/A'}`);
                    logger.error(`[CaptchaService] Elemento encontrado: ${captchaElement ? 'Sim' : 'Não'}`);
                } catch {
                    // Ignorar se variáveis não existem
                }



                if (attempt < MAX_RETRIES) {

                    const delayMs = RETRY_DELAY_MS * attempt;

                    logger.info(`[CaptchaService] ? Aguardando ${delayMs}ms antes de retentar...`);

                    await page.waitForTimeout(delayMs);

                } else {

                    return null;

                }

            }

        }

        return null;
    }



    /**

     * ?? MÉTODO PRIORITÁRIO: Extrai base64 diretamente do atributo src da imagem

     * Baseado no HTML real: <img src="data:image/png;base64,iVBORw0K...">

     */

    private async extrairBase64DiretoDaImagem(page: Page): Promise<string | null> {

        try {

            logger.info('[CaptchaService] ?? Extraindo base64 diretamente do HTML...');



            const base64 = await page.evaluate((imageXPath) => {
                // PRIORIDADE 1: Usar XPath absoluto fornecido pelo usuário
                try {
                    const result = document.evaluate(imageXPath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                    const img = result.singleNodeValue as HTMLImageElement | null;

                    if (img && img.src && img.src.startsWith('data:image/png;base64,')) {
                        console.log('[CaptchaService] ? Imagem encontrada via XPath absoluto!');
                        const match = img.src.match(/^data:image\/png;base64,(.+)$/);
                        if (match && match[1]) {
                            return match[1];
                        }
                    }
                } catch (error) {
                    console.log('[CaptchaService] ?? Erro ao usar XPath, tentando seletores CSS...');
                }

                // FALLBACK: Buscar imagem usando seletores CSS
                const modal = document.querySelector('#modal-recaptcha');
                let img: HTMLImageElement | null = null;

                if (modal) {
                    img = modal.querySelector('img[src^="data:image/png;base64"]') as HTMLImageElement;
                }

                // Se não encontrou no modal, procurar em toda a página
                if (!img) {
                    img = document.querySelector('img[src^="data:image/png;base64"]') as HTMLImageElement;
                }

                if (img && img.src) {
                    console.log('[CaptchaService] ? Imagem encontrada via CSS!');
                    const match = img.src.match(/^data:image\/png;base64,(.+)$/);
                    if (match && match[1]) {
                        return match[1];
                    }
                }

                console.log('[CaptchaService] ?? Imagem com base64 não encontrada');
                return null;
            }, CAPTCHA_IMAGE_XPATH);



            if (base64 && base64.length > 100) {

                logger.info(`[CaptchaService] ? Base64 extraído com sucesso! Tamanho: ${(base64.length / 1024).toFixed(1)}KB`);



                // Salvar debug

                const debugPath = path.join(process.cwd(), 'logs', `captcha-extraido-${Date.now()}.png`);

                const buffer = Buffer.from(base64, 'base64');

                await sharp(buffer).toFile(debugPath);

                logger.info(`[CaptchaService] ?? Debug salvo: ${debugPath}`);



                return base64;

            }



            logger.warn('[CaptchaService] ?? Base64 não encontrado ou inválido');

            return null;



        } catch (error: any) {

            logger.error('[CaptchaService] ? Erro ao extrair base64 diretamente:', error.message);

            return null;

        }

    }



    /**

     * ?? MÉTODO ALTERNATIVO: Captura CAPTCHA via screenshot do modal

     * Usado quando não consegue encontrar o elemento img/canvas específico

     */

    private async capturarViaScreenshotModal(page: Page, _sessionId: string): Promise<string | null> {

        try {

            logger.info('[CaptchaService] ?? Tentando capturar via screenshot do modal...');



            // Tirar screenshot da página inteira

            const screenshotBuffer = await page.screenshot({

                type: 'png',

                encoding: 'binary',

                fullPage: false // Apenas viewport visível

            }) as Buffer;



            // Localizar bounds da imagem do CAPTCHA

            const captchaBounds = await page.evaluate(() => {

                const modal = document.querySelector('#modal-recaptcha') as HTMLElement;

                if (!modal) return null;



                // Procurar pela imagem base64 dentro do modal

                const img = modal.querySelector('img[src^="data:image/png;base64"]') as HTMLImageElement;

                if (img) {

                    const rect = img.getBoundingClientRect();

                    return {

                        x: Math.round(rect.x),

                        y: Math.round(rect.y),

                        width: Math.round(rect.width),

                        height: Math.round(rect.height)

                    };

                }



                return null;

            });



            if (!captchaBounds) {

                logger.warn('[CaptchaService] ?? Não encontrou bounds da imagem CAPTCHA');

                return null;

            }



            logger.info(`[CaptchaService] ?? Recortando CAPTCHA: x=${captchaBounds.x}, y=${captchaBounds.y}, w=${captchaBounds.width}, h=${captchaBounds.height}`);



            // Recortar região do CAPTCHA usando Sharp

            const sharp = (await import('sharp')).default;



            const imagemRecortada = await sharp(screenshotBuffer)

                .extract({

                    left: captchaBounds.x,

                    top: captchaBounds.y,

                    width: captchaBounds.width,

                    height: captchaBounds.height

                })

                .png()

                .toBuffer();



            // Processar imagem (APENAS upscale + sharpen, SEM threshold agressivo)

            const imagemProcessada = await sharp(imagemRecortada)

                .resize({

                    width: captchaBounds.width * 3, // Upscale 3x

                    kernel: 'lanczos3'

                })

                .sharpen() // Aumentar nitidez

                .png()

                .toBuffer();



            // Converter para base64

            const base64 = imagemProcessada.toString('base64');



            // Salvar debug

            const debugPath = path.join(__dirname, '../../logs', `captcha-modal-${Date.now()}.png`);

            await sharp(imagemProcessada).toFile(debugPath);

            logger.info(`[CaptchaService] ?? Debug salvo: ${debugPath}`);



            logger.info('[CaptchaService] ? Captura via modal concluída!');

            return base64;



        } catch (error: any) {

            logger.error(`[CaptchaService] ? Erro ao capturar via modal: ${error.message}`);

            return null;

        }

    }



    /**

     * ?? Tenta resolver CAPTCHA usando OCR OTIMIZADO

     * - Color-aware preprocessing (múltiplos canais)

     * - Ensemble com múltiplos PSM

     * - Heurísticas anti-confusão (O/0, I/1, S/5, G/6)

     * - Validação inteligente

     */

    async tentarOCR(imagemBase64: string): Promise<CaptchaResult> {

        try {

            logger.info('[CaptchaService] ?? Iniciando OCR otimizado (color-aware + ensemble)...');



            // ETAPA 1: Gerar candidatas com pré-processamento OTIMIZADO PARA PRODUÇÃO

            logger.info('[CaptchaService] ?? Gerando candidatas otimizadas (detecção automática de cor)...');

            const candidatas = await gerarCandidatasProducao(imagemBase64);

            logger.info(`[CaptchaService] ? ${candidatas.length} candidatas geradas | Cor: ${candidatas[0]?.corDominante || 'N/A'}`);



            // ETAPA 2: Rodar OCR Ensemble (múltiplos PSM + múltiplas candidatas)

            logger.info('[CaptchaService] ?? Executando OCR Ensemble...');

            const resultado = await ocrEnsemble(candidatas);



            // Log detalhado do resultado

            logResultadoOCR(resultado);



            // ETAPA 3: Validar resultado

            const textoValido = /^[A-Z0-9]{4,6}$/.test(resultado.texto);

            const confiancaOk = resultado.confianca >= 55; // Threshold ajustado (era 60)

            let textoFinal = resultado.texto;
            let metodoFinal: 'ocr' | 'ocr-ensemble' | 'manual' | 'api' = 'ocr-ensemble';
            let confiancaFinal = resultado.confianca;

            // ETAPA 4: FALLBACK GEMINI (se OCR não confiável)
            // Critérios para chamar o Gemini:
            // 1. Confiança do OCR menor que 85%
            // 2. OU Texto não tem exatamente 4 caracteres
            const isConfident = confiancaOk && resultado.confianca >= 85;
            const isValidLength = textoValido && resultado.texto.length === 4;

            if (!isConfident || !isValidLength) {
                logger.warn(`[CaptchaService] ?? OCR Local duvidoso (Conf: ${resultado.confianca.toFixed(1)}%, Len: ${resultado.texto.length}, Válido: ${textoValido})... Acionando Gemini Flash ?`);

                try {
                    // Enviar a MELHOR candidata processada ao Gemini (não a original)
                    // A candidata vencedora já foi processada e otimizada pelo OCR
                    let imagemBufferParaGemini: Buffer;

                    if (resultado.candidataVencedora && resultado.candidataIndex !== undefined) {
                        // Usar a candidata vencedora do OCR (já processada)
                        const candidataVencedora = candidatas[resultado.candidataIndex];
                        if (candidataVencedora && candidataVencedora.buffer) {
                            logger.info(`[CaptchaService] ?? Enviando candidata processada "${candidataVencedora.canal}" (índice ${resultado.candidataIndex}) para Gemini`);
                            imagemBufferParaGemini = candidataVencedora.buffer;
                } else {
                            // Fallback: usar imagem original
                            logger.warn(`[CaptchaService] ?? Candidata vencedora não encontrada, usando imagem original`);
                            imagemBufferParaGemini = Buffer.from(imagemBase64, 'base64');
                        }
                    } else {
                        // Fallback: usar imagem original
                        logger.warn(`[CaptchaService] ?? Índice da candidata não disponível, usando imagem original`);
                        imagemBufferParaGemini = Buffer.from(imagemBase64, 'base64');
                    }

                    // Chama o Gemini passando o Buffer da melhor candidata processada
                    const aiText = await this.aiService.solveCaptcha(imagemBufferParaGemini);

                    if (aiText && aiText.length === 4 && /^[A-Z0-9]{4}$/.test(aiText)) {
                        logger.info(`[CaptchaService] ?? Gemini salvou o dia! Resposta: "${aiText}"`);
                        textoFinal = aiText; // Substitui o texto local pelo da IA
                        metodoFinal = 'api'; // Marcar como resolvido via API (Gemini)
                        confiancaFinal = 90; // Alta confiança para Gemini
                    } else {
                        logger.warn(`[CaptchaService] ?? Gemini retornou resultado inválido: "${aiText}"`);
                        // Se o Gemini falhar, mantemos o OCR local como "melhor chute"
                    }
                } catch (aiError: any) {
                    logger.error(`[CaptchaService] ? Erro ao chamar Gemini: ${aiError.message}`);
                    // Continuar com resultado do OCR local
                }
            } else {
                logger.info(`[CaptchaService] ? OCR Local confiável. Usando resultado: "${resultado.texto}"`);
            }

            // ETAPA 5: Retornar resultado final
            if (textoValido && textoFinal.length > 0) {
                return {
                    sucesso: true,
                    texto: textoFinal,
                    metodo: metodoFinal,
                    confianca: confiancaFinal,
                    detalhes: {
                        canal: resultado.candidataVencedora,
                        psm: resultado.psmUsado,
                        tentativas: resultado.tentativasTestadas,
                        tentativaComBaixaConfianca: !confiancaOk,
                        usadoGeminiFallback: metodoFinal === 'api'
                    }
                };
            } else {
                logger.warn(`[CaptchaService] OCR falhou: texto="${textoFinal}" | confiança=${confiancaFinal.toFixed(1)}% | valido=${textoValido}`);

                return {
                    sucesso: false,
                    metodo: metodoFinal,
                    confianca: confiancaFinal,
                    detalhes: {
                        canal: resultado.candidataVencedora,
                        psm: resultado.psmUsado,
                        tentativas: resultado.tentativasTestadas,
                        motivoFalha: !textoValido ? 'formato_invalido' : 'confianca_baixa'
                    }
                };
            }



        } catch (error: any) {

            logger.error('[CaptchaService] ? Erro no OCR otimizado:', error.message);

            logger.error('[CaptchaService] Stack:', error.stack);



            return {

                sucesso: false,

                metodo: 'ocr-ensemble',

                confianca: 0,

                detalhes: {

                    erro: error.message

                }

            };

        }

    }



    /**

     * ?? Armazena resultado do CAPTCHA resolvido manualmente (via frontend)

     */

    armazenarResultadoManual(sessionId: string, texto: string): void {

        logger.info(`[CaptchaService] ?? CAPTCHA resolvido manualmente: ${texto}`);

        this.resultadosCaptcha.set(sessionId, texto.toUpperCase().trim());

    }



    /**

     * ?? Aguarda resolução do CAPTCHA (OCR ou manual)

     */

    async aguardarResolucao(page: Page | null, sessionId: string, imagemBase64: string, timeout: number = 180000): Promise<string | null> {

        logger.info('[CaptchaService] ?? Iniciando processo de resolução...');



        // PASSO 1: Tentar OCR automaticamente

        const resultadoOCR = await this.tentarOCR(imagemBase64);



        if (resultadoOCR.sucesso && resultadoOCR.texto) {

            logger.info('[CaptchaService] ? CAPTCHA resolvido por OCR!');

            return resultadoOCR.texto;

        }



        // PASSO 2: Solicitar input manual via TERMINAL

        logger.warn('[CaptchaService] ?? OCR falhou, aguardando input manual...');

        logger.info('[CaptchaService] ?? OPÇÃO 1: Digite no frontend');

        logger.info('[CaptchaService] ?? OPÇÃO 2: Digite aqui no terminal');



        // Salvar imagem para o usuário ver

        const debugPath = path.join(process.cwd(), 'logs', `captcha-para-digitar-${Date.now()}.png`);

        const imagemBuffer = Buffer.from(imagemBase64, 'base64');

        await sharp(imagemBuffer).toFile(debugPath);

        console.log('\n+----------------------------------------------------------------+');

        console.log('¦  ?? CAPTCHA DETECTADO - DIGITE MANUALMENTE                    ¦');

        console.log('¦----------------------------------------------------------------¦');

        console.log(`¦  ?? Imagem salva em: logs/captcha-para-digitar-*.png         ¦`);

        console.log('¦  ??  Digite o texto do CAPTCHA abaixo e pressione ENTER       ¦');

        console.log('+----------------------------------------------------------------+\n');



        // Criar promise para input do terminal

        const inputTerminalPromise = new Promise<string>((resolve) => {

            const readline = require('readline');

            const rl = readline.createInterface({

                input: process.stdin,

                output: process.stdout

            });



            rl.question('CAPTCHA (4-6 caracteres): ', (resposta: string) => {

                rl.close();

                const texto = resposta.toUpperCase().trim();

                if (texto.length >= 4 && texto.length <= 6) {

                    resolve(texto);

                } else {

                    logger.warn('[CaptchaService] ?? Texto inválido digitado, aguardando novamente...');

                    resolve(''); // Retorna vazio para continuar loop

                }

            });

        });



        const inicio = Date.now();



        while (Date.now() - inicio < timeout) {

            if (page) {

                const modalVisivel = await this.isCaptchaModalVisivel(page);

                if (!modalVisivel) {

                    logger.info('[CaptchaService] ? Modal do CAPTCHA desapareceu durante a espera manual (usuário confirmou).');

                    return null;

                }

            }



            // OPÇÃO 1: Verificar se usuário digitou no FRONTEND

            const textoManualFrontend = this.resultadosCaptcha.get(sessionId);



            if (textoManualFrontend) {

                logger.info('[CaptchaService] ? CAPTCHA resolvido via FRONTEND!');

                this.resultadosCaptcha.delete(sessionId);

                return textoManualFrontend;

            }



            // OPÇÃO 2: Aguardar input do TERMINAL (se estiver rodando)

            const textoTerminal = await Promise.race([

                inputTerminalPromise,

                new Promise<string>((resolve) => setTimeout(() => resolve(''), 1000))

            ]);



            if (textoTerminal && textoTerminal.length >= 4) {

                logger.info('[CaptchaService] ? CAPTCHA resolvido via TERMINAL!');

                return textoTerminal;

            }



            // Aguardar 1 segundo antes de verificar novamente

            await new Promise(resolve => setTimeout(resolve, 1000));

        }



        throw new Error('Timeout aguardando resolução do CAPTCHA');

    }



    /**

     * ?? Preenche o CAPTCHA no modal do PAT e confirma

     */

    async preencherEConfirmar(page: Page, texto: string, imagemAntesPreencher: string | null = null, sessionId: string = ''): Promise<boolean> {

        try {

            logger.info(`[CaptchaService] ?? Preenchendo CAPTCHA com: ${texto}`);

            // SEMPRE tentar preencher, mesmo se modal não estiver visível no momento
            // O modal pode aparecer/desaparecer durante o processo
            logger.info('[CaptchaService] ?? Aguardando modal aparecer para preencher...');

            // Aguardar modal aparecer (pode já estar visível ou aparecer em breve)
            try {
                await page.waitForXPath(CAPTCHA_MODAL_XPATH, { visible: true, timeout: 5000 });
                logger.info('[CaptchaService] ? Modal detectado via XPath absoluto');
            } catch {
                logger.warn('[CaptchaService] ?? Modal não apareceu no timeout, tentando mesmo assim...');
                // Continuar mesmo assim - pode estar visível mas não detectado pelo XPath
            }



            // REMOVER/DESABILITAR BACKDROP ANTES DE PREENCHER
            // O backdrop pode estar bloqueando a interação com o campo
            logger.info('[CaptchaService] ?? Removendo backdrop que pode estar bloqueando interação...');

            // REMOVER BACKDROP usando múltiplos métodos (igual ao backup funcional)
            await page.evaluate(() => {
                // Método 1: Tentar múltiplos seletores para encontrar o backdrop
                const seletoresBackdrop = [
                    '#modal-recaptcha > div.dtp-modal-backdrop',
                    '.dtp-modal-backdrop',
                    'div.dtp-modal-backdrop',
                    '/html/body/div[8]/div[1]', // XPath absoluto do backdrop
                    '[class*="backdrop"]',
                    '[class*="overlay"]'
                ];

                let backdropEncontrado = false;
                for (const seletor of seletoresBackdrop) {
                    let backdrop: HTMLElement | null = null;

                    try {
                        if (seletor.startsWith('/')) {
                            // XPath
                            const result = document.evaluate(seletor, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                            backdrop = result.singleNodeValue as HTMLElement | null;
                        } else {
                            // CSS Selector
                            backdrop = document.querySelector(seletor) as HTMLElement | null;
                        }

                        if (backdrop) {
                            // Remover completamente ou desabilitar
                            backdrop.style.pointerEvents = 'none';
                            backdrop.style.display = 'none';
                            backdrop.style.visibility = 'hidden';
                            backdrop.style.opacity = '0';
                            backdrop.style.zIndex = '-1';

                            // Tentar remover do DOM também
                            try {
                                backdrop.remove();
                            } catch (e) {
                                // Se não conseguir remover, pelo menos desabilitou
                            }

                            console.log(`[CaptchaService] ? Backdrop removido via: ${seletor}`);
                            backdropEncontrado = true;
                            break;
                        }
                    } catch (e) {
                        // Continuar tentando outros seletores
                    }
                }

                // Método 2: Remover todos os elementos com classe backdrop
                if (!backdropEncontrado) {
                    const todosBackdrops = document.querySelectorAll('[class*="backdrop"], [class*="overlay"]');
                    todosBackdrops.forEach((el: any) => {
                        if (el.style) {
                            el.style.pointerEvents = 'none';
                            el.style.display = 'none';
                            el.style.visibility = 'hidden';
                            el.style.opacity = '0';
                        }
                    });
                    if (todosBackdrops.length > 0) {
                        console.log(`[CaptchaService] ? ${todosBackdrops.length} backdrop(s) removido(s) via busca genérica`);
                        backdropEncontrado = true;
                    }
                }

                if (!backdropEncontrado) {
                    console.log('[CaptchaService] ?? Nenhum backdrop encontrado (pode não existir ou já estar removido)');
                }
            });

            await page.waitForTimeout(200);



            const preencherCampo = async (handle: ElementHandle<Element>) => {
                logger.info(`[CaptchaService] ?? Preenchendo campo com texto: "${texto}"`);

                try {
                    // Verificar estado do campo ANTES de tentar preencher
                    const estadoInicial = await handle.evaluate((el: any) => {
                        return {
                            disabled: el.disabled,
                            readOnly: el.readOnly,
                            value: el.value || '',
                            type: el.type,
                            maxLength: el.maxLength,
                            visible: el.offsetParent !== null,
                            display: window.getComputedStyle(el).display
                        };
                    });

                    logger.info(`[CaptchaService] ?? Estado inicial do campo:`, estadoInicial);

                    // Remover atributos que podem bloquear
                    await handle.evaluate((el: any) => {
                        if (el.disabled) el.disabled = false;
                        if (el.readOnly) el.readOnly = false;
                        el.removeAttribute('readonly');
                        el.removeAttribute('disabled');
                    });

                    // Scroll para garantir que o campo está visível
                    await handle.evaluate((el: any) => {
                        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    });
                    await page.waitForTimeout(200);

                    // Clicar no campo PRIMEIRO para garantir foco
                    await handle.click({ clickCount: 1 });
                    await page.waitForTimeout(200);

                    // Focar no campo
                    await handle.focus();
                    await page.waitForTimeout(200);

                    // Verificar se o campo está realmente focado
                    const estaFocado = await handle.evaluate((el: any) => {
                        return document.activeElement === el;
                    });

                    if (!estaFocado) {
                        logger.warn('[CaptchaService] ?? Campo não está focado, tentando novamente...');
                        await handle.click({ clickCount: 3 }); // Triplo clique para selecionar tudo
                        await page.waitForTimeout(200);
                    }

                    // Limpar campo usando JavaScript direto PRIMEIRO
                    await handle.evaluate((el: any) => {
                        el.value = '';
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                    });
                    await page.waitForTimeout(100);

                    // Selecionar tudo (Ctrl+A) e limpar via teclado também
                    await page.keyboard.down('Control');
                    await page.keyboard.press('KeyA');
                    await page.keyboard.up('Control');
                    await page.waitForTimeout(50);

                    // Limpar campo via Backspace
                    await page.keyboard.press('Backspace');
                    await page.waitForTimeout(100);

                    // Verificar se campo está vazio
                    const valorAposLimpar = await handle.evaluate((el: any) => el.value || '');
                    logger.info(`[CaptchaService] ?? Campo após limpar: "${valorAposLimpar}"`);

                    // Digitar o texto do CAPTCHA caractere por caractere (simulando digitação humana)
                    logger.info(`[CaptchaService] ?? Digitando caractere por caractere: "${texto}"`);

                    for (let i = 0; i < texto.length; i++) {
                        const char = texto[i];
                        await page.keyboard.type(char, { delay: 100 });
                        await page.waitForTimeout(50);

                        // Verificar após cada caractere
                        const valorParcial = await handle.evaluate((el: any) => el.value || '');
                        logger.debug(`[CaptchaService] ?? Após "${char}": "${valorParcial}"`);
                    }

                    await page.waitForTimeout(300);

                    // Disparar TODOS os eventos possíveis para garantir que React detecte
                    await page.evaluate((el: any, value: string) => {
                        const input = el as HTMLInputElement;

                        // Definir valor
                        input.value = value;

                        // Disparar eventos em sequência
                        input.dispatchEvent(new Event('focus', { bubbles: true }));
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.dispatchEvent(new Event('keydown', { bubbles: true }));
                        input.dispatchEvent(new Event('keypress', { bubbles: true }));
                        input.dispatchEvent(new Event('keyup', { bubbles: true }));
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                        input.dispatchEvent(new Event('blur', { bubbles: true }));

                        // Tentar também eventos do React
                        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                        if (nativeInputValueSetter) {
                            nativeInputValueSetter.call(input, value);
                            input.dispatchEvent(new Event('input', { bubbles: true }));
                        }
                    }, handle, texto);

                    await page.waitForTimeout(200);

                    // Verificar valor FINAL
                    const valorFinal = await handle.evaluate((el: any) => el.value || '');
                    logger.info(`[CaptchaService] ? Valor final no campo: "${valorFinal}"`);

                    if (valorFinal === texto || valorFinal.length === texto.length) {
                        logger.info(`[CaptchaService] ? Campo preenchido com sucesso!`);
                        return true;
                    } else {
                        logger.warn(`[CaptchaService] ?? Campo não preenchido corretamente. Esperado: "${texto}", Obtido: "${valorFinal}"`);

                        // Última tentativa: forçar via JavaScript
                        await page.evaluate((el: any, value: string) => {
                            el.value = value;
                            el.setAttribute('value', value);
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                        }, handle, texto);

                        await page.waitForTimeout(200);
                        const valorForcado = await handle.evaluate((el: any) => el.value || '');

                        if (valorForcado === texto) {
                            logger.info(`[CaptchaService] ? Campo preenchido via JavaScript forçado!`);
                            return true;
                        }

                        return false;
                    }
                } catch (error: any) {
                    logger.error(`[CaptchaService] ? Erro ao preencher campo: ${error.message}`);
                    logger.error(`[CaptchaService] Stack: ${error.stack}`);
                    return false;
                }
            };



            // PRIORIDADE 1: XPath absoluto fornecido pelo usuário
            const inputXPaths = [
                CAPTCHA_INPUT_XPATH, // XPath absoluto fornecido: /html/body/div[8]/div[2]/div[2]/div/input
                `${CAPTCHA_MODAL_XPATH}//input[@type="text" and @maxlength="4"]`, // Fallback relativo
                '//input[@type="text" and @maxlength="4"]' // Fallback genérico
            ];

            // FALLBACK: Seletores CSS (priorizando maxlength="4" que é específico do CAPTCHA)
            const seletoresInput = [
                '#modal-recaptcha input[type="text"][maxlength="4"]', // PRIORIDADE: maxlength="4"
                '#modal-recaptcha > div.dtp-modal.md > div.content-container > div > input[type=text][maxlength="4"]',
                '#modal-recaptcha .content-container input[type="text"][maxlength="4"]',
                '#modal-recaptcha input[type="text"]',
                '#modal-recaptcha input.captcha-input',
                '#modal-recaptcha input[name="captcha"]',
                '#modal-recaptcha input[placeholder*="captcha" i]',
                '#modal-recaptcha .dtp-modal-content input[type="text"]',
                '.dtp-modal input[type="text"][maxlength="4"]'
            ];



            let inputPreenchido = false;



            for (const xpath of inputXPaths) {

                const handles = await page.$x(xpath);

                if (handles.length) {

                    const inputHandle = handles[0] as ElementHandle<Element>;

                    await preencherCampo(inputHandle);

                    logger.info(`[CaptchaService] ? Input preenchido via XPath: ${xpath}`);

                    inputPreenchido = true;

                    break;

                }

            }



            if (!inputPreenchido) {

                for (const seletor of seletoresInput) {

                    const input = await page.$(seletor);

                    if (input) {

                        await preencherCampo(input);

                        logger.info(`[CaptchaService] ? Input preenchido com seletor: ${seletor}`);

                        inputPreenchido = true;

                        break;

                    }

                }

            }



            if (!inputPreenchido) {

                logger.error('[CaptchaService] ? Campo de input do CAPTCHA não encontrado');

                return false;

            }



            await page.waitForTimeout(400);



            // PRIORIDADE 1: XPath absoluto fornecido pelo usuário
            const botoesXPath = [
                CAPTCHA_BUTTON_XPATH, // XPath absoluto fornecido
                `${CAPTCHA_MODAL_XPATH}//button[@id="btn-modal-remarcar-agendamento-confirmar"]`, // Fallback relativo
                `${CAPTCHA_MODAL_XPATH}//button[contains(@class, "dtp-primary")]` // Fallback por classe
            ];

            // FALLBACK: Seletores CSS
            const seletoresBotao = [
                '#modal-recaptcha #btn-modal-remarcar-agendamento-confirmar',
                '#btn-modal-remarcar-agendamento-confirmar',
                '#modal-recaptcha button[id*="confirmar" i]',
                '#modal-recaptcha button[type="submit"]',
                '#modal-recaptcha .dtp-btn.dtp-primary',
                '#modal-recaptcha .dtp-button-primary',
                '#modal-recaptcha button.btn-primary'
            ];



            let botaoClicado = false;



            for (const xpath of botoesXPath) {

                const handles = await page.$x(xpath);

                if (handles.length) {

                    const buttonHandle = handles[0] as ElementHandle<Element>;

                    // Verificar se botão está visível e habilitado
                    const estadoBotao = await buttonHandle.evaluate((btn: any) => {
                        return {
                            disabled: btn.disabled,
                            visible: btn.offsetParent !== null,
                            display: window.getComputedStyle(btn).display,
                            pointerEvents: window.getComputedStyle(btn).pointerEvents
                        };
                    });

                    logger.info(`[CaptchaService] ?? Estado do botão:`, estadoBotao);

                    // Remover atributos que podem bloquear
                    await buttonHandle.evaluate((btn: any) => {
                        if (btn.disabled) btn.disabled = false;
                        btn.removeAttribute('disabled');
                        btn.style.pointerEvents = 'auto';
                        btn.style.cursor = 'pointer';
                    });

                    // Aguardar botão estar habilitado antes de clicar
                    await page.waitForFunction((btn) => {
                        const element = btn as HTMLButtonElement;
                        return !element.disabled && element.offsetParent !== null;
                    }, { timeout: 5000 }, buttonHandle).catch(() => {
                        logger.warn('[CaptchaService] ?? Botão pode estar desabilitado, tentando clicar mesmo assim...');
                    });

                    // Scroll para garantir que botão está visível
                    await buttonHandle.evaluate((btn: any) => {
                        btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    });
                    await page.waitForTimeout(200);

                    // Clicar no botão
                    await buttonHandle.click();
                    logger.info(`[CaptchaService] ? Botão "Confirmar" clicado via XPath: ${xpath}`);

                    botaoClicado = true;
                    break;

                }

            }



            if (!botaoClicado) {

                for (const seletor of seletoresBotao) {

                    const botao = await page.$(seletor);

                    if (botao) {

                        await botao.click();

                        logger.info(`[CaptchaService] ? Botão "Confirmar" clicado com seletor: ${seletor}`);

                        botaoClicado = true;

                        break;

                    }

                }

            }



            if (!botaoClicado) {

                logger.error('[CaptchaService] ? Botão "Confirmar" não encontrado');

                return false;

            }



            // Aguardar 3-4 segundos após confirmar para verificar se CAPTCHA foi rejeitado
            // Se o CAPTCHA estiver errado, o site abre quase instantaneamente uma nova imagem
            await page.waitForTimeout(3500); // 3.5 segundos

            // Verificar se uma nova imagem de CAPTCHA apareceu (indica que o anterior foi rejeitado)
            let novaImagemApareceu = false;
            if (imagemAntesPreencher && sessionId) {
                // Capturar imagem atual para comparar
                const imagemAposPreencher = await this.capturarImagemCaptcha(page, sessionId);

                if (imagemAposPreencher && imagemAposPreencher !== imagemAntesPreencher) {
                    logger.info('[CaptchaService] ?? Nova imagem detectada - CAPTCHA foi rejeitado!');
                    novaImagemApareceu = true;
                } else {
                    logger.info('[CaptchaService] ? Imagem não mudou - CAPTCHA pode ter sido aceito');
                }
            } else {
                // Fallback: verificar via DOM se imagem existe e mudou
                const imagemExiste = await page.evaluate((imageXPath) => {
                    try {
                        const result = document.evaluate(imageXPath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                        const img = result.singleNodeValue as HTMLImageElement | null;
                        if (!img) return false;

                        // Verificar se a imagem existe e tem base64
                        return !!(img.src && img.src.includes('data:image/png;base64'));
                    } catch {
                    return false;
                }
                }, CAPTCHA_IMAGE_XPATH);

                // Se imagem existe e não tínhamos imagem antes, pode ser nova
                novaImagemApareceu = imagemExiste && !imagemAntesPreencher;
            }

            // Verificar se backdrop reapareceu (indica CAPTCHA incorreto)
            const backdropReapareceu = await page.evaluate(() => {
                const backdrop = document.querySelector('.dtp-modal-backdrop') as HTMLElement | null;
                if (!backdrop) return false;

                const estaVisivel = (el: HTMLElement | null): boolean => {
                    if (!el) return false;
                    const style = window.getComputedStyle(el);
                    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
                };

                return estaVisivel(backdrop);
            });

            // Verificar se modal ainda está visível
            const modalAindaVisivel = await this.isCaptchaModalVisivel(page);

            // Se backdrop reapareceu OU nova imagem apareceu OU modal ainda visível = CAPTCHA foi rejeitado
            if (backdropReapareceu || novaImagemApareceu || modalAindaVisivel) {
                if (backdropReapareceu) {
                    logger.warn('[CaptchaService] ? CAPTCHA INCORRETO detectado - backdrop reapareceu após 3.5s');
                }
                if (novaImagemApareceu) {
                    logger.warn('[CaptchaService] ? CAPTCHA INCORRETO detectado - nova imagem de CAPTCHA apareceu (rejeitado)');
                }
                if (modalAindaVisivel) {
                    logger.warn('[CaptchaService] ? CAPTCHA INCORRETO detectado - modal ainda visível após 3.5s');
                }
                return false; // Retornar false para tentar novamente com novo CAPTCHA
            }

            // Se chegou aqui, o modal desapareceu e não há nova imagem = CAPTCHA foi aceito!
            logger.info('[CaptchaService] ? CAPTCHA aceito pelo site - modal desapareceu e nenhuma nova imagem apareceu');

            logger.info('[CaptchaService] ? CAPTCHA confirmado com sucesso!');
            return true;



        } catch (error: any) {
            logger.error('[CaptchaService] ? Erro ao preencher CAPTCHA:', error.message);
            logger.error('[CaptchaService] Stack completo:', error.stack);
            logger.error('[CaptchaService] Tipo do erro:', error.constructor.name);
            return false;
        }

    }



    private async aguardarFechamentoCaptcha(page: Page): Promise<boolean> {

        try {

            await page.waitForFunction(() => {

                const modal = document.querySelector('#modal-recaptcha, .dtp-modal.md') as HTMLElement | null;

                const backdrop = document.querySelector('.dtp-modal-backdrop') as HTMLElement | null;

                const loading = document.querySelector('.dtp-loading, .loading, .spinner') as HTMLElement | null;



                const modalHidden = !modal || modal.classList.contains('hide') || modal.getAttribute('aria-hidden') === 'true' || modal.offsetParent === null;

                const backdropHidden = !backdrop || backdrop.classList.contains('hide') || backdrop.style.display === 'none' || backdrop.offsetParent === null;

                const loadingHidden = !loading || loading.classList.contains('hide') || loading.style.display === 'none' || loading.offsetParent === null;



                return modalHidden && backdropHidden && loadingHidden;

            }, { timeout: 10000 });

            return true;

        } catch {

            return false;

        }

    }



    private async isCaptchaModalVisivel(page: Page): Promise<boolean> {

        try {
            // PRIORIDADE 1: Verificar usando XPath absoluto fornecido pelo usuário
            const modalViaXPath = await page.evaluate((modalXPath) => {
                try {
                    const result = document.evaluate(modalXPath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                    const modal = result.singleNodeValue as HTMLElement | null;
                    if (modal) {
                        const style = window.getComputedStyle(modal);
                        if (style.display !== 'none' && modal.offsetParent !== null) {
                            // Verificar se tem o texto do CAPTCHA ou a imagem (mesma lógica do detectarCaptcha)
                            const texto = modal.textContent || '';
                            const temImagem = modal.querySelector('img[src^="data:image/png;base64"]') !== null;
                            if (texto.includes('Desafio Recaptcha') || texto.includes('validar sua requisição') || temImagem) {
                                return true;
                            }
                        }
                    }
                } catch (error) {
                    // Ignorar erro e tentar fallback
                }
                return false;
            }, CAPTCHA_MODAL_XPATH);

            if (modalViaXPath) {
                return true;
            }

            // FALLBACK: Verificar usando seletores CSS (mesma lógica do detectarCaptcha)
            return await page.evaluate(() => {

                const label = document.querySelector('#modal-recaptcha_modal-label');

                const modalViaLabel = label ? (label.closest('.dtp-modal') as HTMLElement | null) : null;

                const modal = modalViaLabel ||

                    (document.querySelector('#modal-recaptcha') as HTMLElement | null) ||

                    (document.querySelector('[role="dialog"]#modal-recaptcha') as HTMLElement | null) ||

                    (Array.from(document.querySelectorAll('.dtp-modal, .modal, [role="dialog"]')).find(m => {

                        const texto = m.textContent || '';

                        return texto.includes('Desafio Recaptcha') ||

                            texto.includes('validar sua requisi??o') ||

                            texto.includes('Recaptcha') ||

                            m.querySelector('img[src^="data:image/png;base64"]') !== null;

                    }) as HTMLElement | null) || null;



                if (!modal) return false;



                const backdrop = document.querySelector('.dtp-modal-backdrop') as HTMLElement | null;



                const spinner = document.querySelector('.dtp-loading, .loading, .spinner') as HTMLElement | null;



                const estaVisivel = (elemento: HTMLElement | null) => {

                    if (!elemento) return false;

                    const style = window.getComputedStyle(elemento);

                    return style.display !== 'none' &&

                        style.visibility !== 'hidden' &&

                        elemento.offsetParent !== null;

                };

                // Verificar se modal está visível
                if (modal) {
                    const style = window.getComputedStyle(modal as HTMLElement);
                    if (style.display !== 'none' && style.visibility !== 'hidden' && (modal as HTMLElement).offsetParent !== null) {
                        return true;
                    }
                }

                return estaVisivel(backdrop) || estaVisivel(spinner);

            });

        } catch {

            return false;

        }

    }



    /****

     * ?? Obter dados do CAPTCHA pendente para exibir no frontend

     */

    obterCaptchaPendente(sessionId: string): CaptchaData | null {

        return this.resolvendoCaptcha.get(sessionId) || null;

    }



    /**

     * ?? Limpar dados da sessão

     */

    limparSessao(sessionId: string): void {

        this.resolvendoCaptcha.delete(sessionId);

        this.resultadosCaptcha.delete(sessionId);

    }



    /**

     * ?? Clica no botão "Gerar novo CAPTCHA" (se existir)

     */

    /**
     * ?? Remove o backdrop do modal que bloqueia interações
     * CRÍTICO: Deve ser chamado ANTES de tentar preencher qualquer campo
     */
    /**
     * Salva snapshot (HTML + screenshot) para depuracao do CAPTCHA
     */
    private async salvarSnapshotCaptcha(page: Page, prefixo: string): Promise<void> {
        try {
            const timestamp = Date.now();
            const dir = path.join(process.cwd(), 'logs');
            const screenshotPath = path.join(dir, `${prefixo}-${timestamp}.png`);
            const htmlPath = path.join(dir, `${prefixo}-${timestamp}.html`);
            await page.screenshot({ path: screenshotPath, fullPage: true });
            fs.writeFileSync(htmlPath, await page.content());
            logger.info(`[CaptchaService] Snapshot '${prefixo}' salvo para depuracao`);
        } catch (error) {
            logger.warn(`[CaptchaService] Nao foi possivel salvar snapshot '${prefixo}':`, error);
        }
    }

    private async removerBackdrop(page: Page): Promise<void> {
        try {
            logger.info('[CaptchaService] ?? Removendo backdrop que bloqueia interação...');

            const backdropRemovido = await page.evaluate(() => {
                // Método 1: Tentar múltiplos seletores para encontrar o backdrop
                const seletoresBackdrop = [
                    '.dtp-modal-backdrop', // Seletor principal (mais comum)
                    'div.dtp-modal-backdrop',
                    '#modal-recaptcha > div.dtp-modal-backdrop',
                    '/html/body/div[8]/div[1]', // XPath absoluto do backdrop
                    '[class*="backdrop"]',
                    '[class*="overlay"]'
                ];

                let backdropEncontrado = false;
                let backdropRemovido = false;

                // Tentar cada seletor
                for (const seletor of seletoresBackdrop) {
                    let backdrop: HTMLElement | null = null;

                    try {
                        if (seletor.startsWith('/')) {
                            // XPath
                            const result = document.evaluate(seletor, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                            backdrop = result.singleNodeValue as HTMLElement | null;
                        } else {
                            // CSS Selector
                            backdrop = document.querySelector(seletor) as HTMLElement | null;
                        }

                        if (backdrop) {
                            // CRÍTICO: Remover completamente do DOM
                            try {
                                backdrop.remove();
                                backdropRemovido = true;
                                console.log(`[CaptchaService] ? Backdrop REMOVIDO do DOM via: ${seletor}`);
                            } catch (e) {
                                // Se não conseguir remover, desabilitar completamente
                                backdrop.style.pointerEvents = 'none';
                                backdrop.style.display = 'none';
                                backdrop.style.visibility = 'hidden';
                                backdrop.style.opacity = '0';
                                backdrop.style.zIndex = '-9999';
                                backdrop.style.position = 'fixed';
                                backdrop.style.top = '-9999px';
                                backdrop.style.left = '-9999px';
                                backdropRemovido = true;
                                console.log(`[CaptchaService] ? Backdrop DESABILITADO via: ${seletor}`);
                            }

                            backdropEncontrado = true;
                            break;
                        }
                    } catch (e) {
                        // Continuar tentando outros seletores
                    }
                }

                // Método 2: Remover TODOS os elementos com classe backdrop (busca genérica)
                if (!backdropEncontrado || !backdropRemovido) {
                    const todosBackdrops = document.querySelectorAll('.dtp-modal-backdrop, [class*="backdrop"], [class*="overlay"]');
                    todosBackdrops.forEach((el: any) => {
                        try {
                            el.remove();
                            backdropRemovido = true;
                        } catch (e) {
                            // Se não conseguir remover, desabilitar
                            if (el.style) {
                                el.style.pointerEvents = 'none';
                                el.style.display = 'none';
                                el.style.visibility = 'hidden';
                                el.style.opacity = '0';
                                el.style.zIndex = '-9999';
                            }
                            backdropRemovido = true;
                        }
                    });
                    if (todosBackdrops.length > 0) {
                        console.log(`[CaptchaService] ? ${todosBackdrops.length} backdrop(s) removido(s) via busca genérica`);
                    }
                }

                // Método 3: Verificar se ainda existe algum backdrop visível
                const backdropAindaExiste = document.querySelector('.dtp-modal-backdrop');
                if (backdropAindaExiste) {
                    const style = window.getComputedStyle(backdropAindaExiste as HTMLElement);
                    const estaVisivel = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
                    if (estaVisivel) {
                        console.log('[CaptchaService] ?? Backdrop ainda visível após tentativas, forçando remoção...');
                        try {
                            (backdropAindaExiste as HTMLElement).remove();
                            backdropRemovido = true;
                        } catch (e) {
                            // Última tentativa: mover para fora da viewport
                            (backdropAindaExiste as HTMLElement).style.cssText = 'display: none !important; visibility: hidden !important; opacity: 0 !important; pointer-events: none !important; z-index: -9999 !important;';
                        }
                    }
                }

                return backdropRemovido;
            });

            if (backdropRemovido) {
                logger.info('[CaptchaService] ? Backdrop removido com sucesso!');
            } else {
                logger.warn('[CaptchaService] ?? Nenhum backdrop encontrado ou já estava removido');
            }

            // Aguardar um pouco para garantir que o DOM foi atualizado
            await page.waitForTimeout(300);

        } catch (error: any) {
            logger.error(`[CaptchaService] ? Erro ao remover backdrop: ${error.message}`);
            // Não lançar erro - continuar mesmo se falhar
        }
    }

    private async clicarGerarNovoCaptcha(page: Page): Promise<boolean> {

        try {

            const seletoresBotao = [

                '#modal-recaptcha button[title*="gerar" i]',

                '#modal-recaptcha button[title*="novo" i]',

                '#modal-recaptcha .btn-refresh',

                '#modal-recaptcha .refresh-captcha',

                '#modal-recaptcha button[onclick*="refresh" i]'

            ];



            for (const seletor of seletoresBotao) {

                const botao = await page.$(seletor);

                if (botao) {

                    await botao.click();

                    logger.info('[CaptchaService] ?? Clicou em "Gerar novo CAPTCHA"');

                    return true;

                }

            }



            return false;

        } catch (error) {

            return false;

        }

    }



    /**

     * ?? Resolver CAPTCHA com retry INTELIGENTE

     * - Tenta OCR até 2 vezes (com validação de mudança)

     * - Se falhar, aguarda resolução manual

     * - Valida resultado com o site

     * - Registra motivo da falha para análise

     */

    async resolverComRetry(page: Page, sessionId: string, maxTentativasOCR: number = 10): Promise<CaptchaResult> {
        let tentativaOCR = 0;
        let ultimoTextoRejeitado = '';
        let ultimaImagemBase64 = '';
        const MAX_TENTATIVAS_TOTAL = 20; // Limite de segurança para evitar loop infinito
        const TIMEOUT_TOTAL_MS = 300000; // 5 minutos máximo
        const inicioTempo = Date.now();

        logger.info('[CaptchaService] ?? Iniciando resolução automática do CAPTCHA...');
        logger.info('[CaptchaService] ?? Fluxo: Captura ? OCR ? Preencher ? Confirmar ? Verificar ? Tentar novamente se erro');

        while (tentativaOCR < MAX_TENTATIVAS_TOTAL) {
            // Verificar timeout total
            if (Date.now() - inicioTempo > TIMEOUT_TOTAL_MS) {
                logger.error('[CaptchaService] ? Timeout total atingido (5 minutos)');
                break;
            }

            tentativaOCR++;
            logger.info(`[CaptchaService] ?? Tentativa ${tentativaOCR}/${MAX_TENTATIVAS_TOTAL}...`);

            // PASSO 1: Verificar se modal ainda está visível
            // IMPORTANTE: Não retornar sucesso aqui - sempre tentar capturar e resolver primeiro
            const modalAtivo = await this.isCaptchaModalVisivel(page);
            if (!modalAtivo && tentativaOCR > 1) {
                // Se não é a primeira tentativa e modal desapareceu, pode ter sido resolvido
                logger.info('[CaptchaService] ? Modal desapareceu após tentativas - CAPTCHA pode ter sido resolvido!');
                // Verificar novamente após 1s para confirmar
                await page.waitForTimeout(1000);
                const modalAindaVisivel = await this.isCaptchaModalVisivel(page);
                if (!modalAindaVisivel) {
                    return {
                        sucesso: true,
                        metodo: 'ocr-ensemble',
                        detalhes: { resolvidoAutomaticamente: false, tentativas: tentativaOCR - 1 }
                    };
                }
            }

            // Se modal não está visível na primeira tentativa, aguardar um pouco
            if (!modalAtivo && tentativaOCR === 1) {
                logger.info('[CaptchaService] ? Modal não visível na primeira tentativa, aguardando aparecer...');
                await page.waitForTimeout(2000);
                // Verificar novamente
                const modalAposEspera = await this.isCaptchaModalVisivel(page);
                if (!modalAposEspera) {
                    logger.warn('[CaptchaService] ?? Modal não apareceu após espera. Continuando mesmo assim...');
                }
            }

            // PASSO 2: Capturar a imagem do CAPTCHA
            logger.info('[CaptchaService] ?? Capturando imagem do CAPTCHA...');
            const imagemBase64 = await this.capturarImagemCaptcha(page, sessionId);

            if (!imagemBase64) {
                logger.warn('[CaptchaService] ?? Falha na captura, tentando novamente em 1s...');
                await page.waitForTimeout(1000);
                continue;
            }

            // PASSO 3: Verificar se é um novo CAPTCHA (imagem mudou)
            if (ultimaImagemBase64 && imagemBase64 === ultimaImagemBase64) {
                logger.warn('[CaptchaService] ?? Mesma imagem do CAPTCHA anterior - aguardando novo CAPTCHA...');
                await page.waitForTimeout(1500);

                // Tentar clicar em "Gerar novo" se disponível
                await this.clicarGerarNovoCaptcha(page);
                await page.waitForTimeout(1500);
                continue;
            }

            ultimaImagemBase64 = imagemBase64;
            logger.info('[CaptchaService] ? Imagem capturada (nova ou diferente)!');
            logger.info('[CaptchaService] ?? Iniciando OCR...');

            // PASSO 4: Tentar OCR
            logger.info('[CaptchaService] ?? Executando OCR na imagem capturada...');
            const resultadoOCR = await this.tentarOCR(imagemBase64);

            if (!resultadoOCR.sucesso || !resultadoOCR.texto) {
                logger.warn(`[CaptchaService] ?? OCR falhou (confianca: ${resultadoOCR.confianca?.toFixed(1)}%)`);

                // Tentar gerar novo CAPTCHA se confiança muito baixa
                if (resultadoOCR.confianca && resultadoOCR.confianca < 30) {
                    logger.info('[CaptchaService] ?? Tentando gerar novo CAPTCHA (confiança muito baixa)...');
                    await this.clicarGerarNovoCaptcha(page);
                    await page.waitForTimeout(1500);
                }
                continue;
            }

            logger.info(`[CaptchaService] ? OCR concluído! Texto detectado: "${resultadoOCR.texto}" (confiança: ${resultadoOCR.confianca?.toFixed(1)}%)`);

            // Evitar tentar mesmo texto que já foi rejeitado
            if (resultadoOCR.texto === ultimoTextoRejeitado) {
                logger.warn(`[CaptchaService] ?? OCR retornou mesmo texto rejeitado: ${resultadoOCR.texto}`);
                logger.info('[CaptchaService] ?? Gerando novo CAPTCHA...');
                await this.clicarGerarNovoCaptcha(page);
                await page.waitForTimeout(1500);
                continue;
            }

            // PASSO 5: Capturar imagem ANTES de preencher para comparar depois
            logger.info(`[CaptchaService] ?? Capturando imagem atual do CAPTCHA antes de preencher...`);
            const imagemAntesPreencher = await this.capturarImagemCaptcha(page, sessionId);

            // PASSO 6: Preencher e confirmar (o método preencherEConfirmar já remove o backdrop internamente)
            logger.info(`[CaptchaService] ?? Iniciando preenchimento do campo com texto: "${resultadoOCR.texto}"`);

            const preenchido = await this.preencherEConfirmar(page, resultadoOCR.texto, imagemAntesPreencher, sessionId);

            if (!preenchido) {
                // Verificar se foi porque CAPTCHA foi rejeitado (modal ainda visível)
                const modalAindaVisivelAposPreencher = await this.isCaptchaModalVisivel(page);

                if (modalAindaVisivelAposPreencher) {
                    // CAPTCHA foi rejeitado - novo CAPTCHA deve aparecer
                    logger.warn(`[CaptchaService] ? CAPTCHA REJEITADO após preencher! Texto tentado: ${resultadoOCR.texto}`);
                    logger.info('[CaptchaService] ?? Aguardando novo CAPTCHA aparecer...');
                    ultimoTextoRejeitado = resultadoOCR.texto;

                    // Aguardar novo CAPTCHA aparecer (imagem mudar)
                    let novoCaptchaApareceu = false;
                    for (let espera = 0; espera < 20; espera++) {
                        await page.waitForTimeout(500);
                        const novaImagem = await this.capturarImagemCaptcha(page, sessionId);
                        if (novaImagem && novaImagem !== ultimaImagemBase64) {
                            logger.info('[CaptchaService] ? Novo CAPTCHA detectado após rejeição!');
                            novoCaptchaApareceu = true;
                            ultimaImagemBase64 = ''; // Resetar para forçar nova captura
                            break;
                        }
                    }

                    if (!novoCaptchaApareceu) {
                        logger.warn('[CaptchaService] ?? Novo CAPTCHA não apareceu, tentando gerar manualmente...');
                        await this.clicarGerarNovoCaptcha(page);
                        await page.waitForTimeout(2000);
                    }

                    // Continuar loop para tentar novamente com novo CAPTCHA
                    logger.info('[CaptchaService] ?? Continuando para próxima tentativa com novo CAPTCHA...');
                    continue;
                } else {
                    // Falha técnica (campo não encontrado, etc)
                    logger.error('[CaptchaService] ? FALHA ao preencher campo!');
                    logger.error('[CaptchaService] ? Verificando se campo existe e está acessível...');

                    // Debug: verificar se campo existe
                    const campoExiste = await page.evaluate((xpath) => {
                        try {
                            const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                            return result.singleNodeValue !== null;
                        } catch {
                            return false;
                        }
                    }, CAPTCHA_INPUT_XPATH);

                    logger.error(`[CaptchaService] Campo existe via XPath: ${campoExiste}`);

                    await page.waitForTimeout(2000);
                    continue;
                }
            }

            logger.info('[CaptchaService] ? Campo preenchido com sucesso!');

            logger.info('[CaptchaService] ? CAPTCHA preenchido e confirmado!');
            logger.info('[CaptchaService] ? Aguardando processamento (spinner)...');

            // PASSO 6: Aguardar processamento e verificar se foi aceito
            try {
                await page.waitForTimeout(1500); // Aguardar spinner aparecer

                // Aguardar spinner desaparecer
                await page.waitForFunction(() => {
                    const spinner = document.querySelector('.dtp-loading, .loading, .spinner, [class*="loading"], [class*="spinner"]');
                    if (!spinner) return true;
                    const style = window.getComputedStyle(spinner as HTMLElement);
                    return style.display === 'none' || (spinner as HTMLElement).offsetParent === null;
                }, { timeout: 5000 }).catch(() => {
                    logger.warn('[CaptchaService] ?? Timeout ao aguardar spinner, mas continuando...');
                });

                await page.waitForTimeout(2000); // Aguardar mais um pouco
            } catch (error) {
                logger.warn('[CaptchaService] ?? Erro ao aguardar spinner, mas continuando...');
                await page.waitForTimeout(3000);
            }

            // PASSO 7: Verificar se CAPTCHA foi aceito (modal desapareceu)
            const modalAindaVisivel = await this.isCaptchaModalVisivel(page);
            if (!modalAindaVisivel) {
                // SUCESSO! CAPTCHA foi aceito
                logger.info(`[CaptchaService] ??? CAPTCHA ACEITO! Texto correto: ${resultadoOCR.texto}`);
                logger.info(`[CaptchaService] ?? Resolvido em ${tentativaOCR} tentativa(s)`);

                this.registrarEstatistica({
                    ...resultadoOCR,
                    sucesso: true,
                    metodo: 'ocr-ensemble'
                }, 0);

                return {
                    ...resultadoOCR,
                    sucesso: true,
                    detalhes: { ...resultadoOCR.detalhes, tentativas: tentativaOCR }
                };
            }

            // CAPTCHA foi rejeitado - novo CAPTCHA deve aparecer
            logger.warn(`[CaptchaService] ? CAPTCHA REJEITADO! Texto tentado: ${resultadoOCR.texto}`);
            logger.info('[CaptchaService] ?? Aguardando novo CAPTCHA aparecer (imagem mudar)...');
            ultimoTextoRejeitado = resultadoOCR.texto;

            // IMPORTANTE: Quando CAPTCHA é rejeitado, um novo aparece automaticamente
            // Precisamos aguardar a nova imagem aparecer e então continuar o loop
            // para capturar, fazer OCR, remover backdrop novamente, preencher e confirmar

            // Aguardar novo CAPTCHA aparecer (imagem mudar)
            let novoCaptchaApareceu = false;
            let tentativasEsperaNovo = 0;
            const MAX_TENTATIVAS_ESPERA_NOVO = 20; // 20 x 500ms = 10s máximo

            while (tentativasEsperaNovo < MAX_TENTATIVAS_ESPERA_NOVO && !novoCaptchaApareceu) {
                await page.waitForTimeout(500);
                tentativasEsperaNovo++;

                // Verificar se modal ainda está visível (deve estar, pois CAPTCHA foi rejeitado)
                const modalAindaVisivel = await this.isCaptchaModalVisivel(page);
                if (!modalAindaVisivel) {
                    // Modal desapareceu - pode ter sido aceito de alguma forma?
                    logger.info('[CaptchaService] ? Modal desapareceu após rejeição (pode ter sido aceito?)');
                    break;
                }

                // Tentar capturar nova imagem
                const novaImagem = await this.capturarImagemCaptcha(page, sessionId);
                if (novaImagem && novaImagem !== ultimaImagemBase64) {
                    logger.info(`[CaptchaService] ? Novo CAPTCHA detectado após ${tentativasEsperaNovo * 500}ms!`);
                    logger.info('[CaptchaService] ?? Continuando loop para resolver novo CAPTCHA...');
                    novoCaptchaApareceu = true;
                    ultimaImagemBase64 = ''; // Resetar para forçar nova captura no próximo loop
                    break;
                }

                // A cada 2 segundos, logar progresso
                if (tentativasEsperaNovo % 4 === 0) {
                    logger.info(`[CaptchaService] ? Aguardando novo CAPTCHA... (${tentativasEsperaNovo * 500}ms)`);
                }
            }

            if (!novoCaptchaApareceu) {
                logger.warn('[CaptchaService] ?? Novo CAPTCHA não apareceu automaticamente, tentando gerar manualmente...');
                await this.clicarGerarNovoCaptcha(page);
                await page.waitForTimeout(2000);

                // Tentar capturar novamente após clicar em "Gerar novo"
                const novaImagemAposGerar = await this.capturarImagemCaptcha(page, sessionId);
                if (novaImagemAposGerar && novaImagemAposGerar !== ultimaImagemBase64) {
                    logger.info('[CaptchaService] ? Novo CAPTCHA detectado após gerar manualmente!');
                    ultimaImagemBase64 = ''; // Resetar para forçar nova captura
                }
            }

            // Continuar o loop - na próxima iteração vai capturar novo CAPTCHA, fazer OCR, remover backdrop, preencher e confirmar
            logger.info('[CaptchaService] ?? Continuando para próxima tentativa...');
            continue;
        }

        // Se chegou aqui, excedeu o limite de tentativas
        const modalAindaVisivel = await this.isCaptchaModalVisivel(page);
        if (!modalAindaVisivel) {
            // Modal desapareceu - sucesso!
            logger.info('[CaptchaService] ? Modal desapareceu após todas as tentativas!');
            return {
                sucesso: true,
                metodo: 'ocr-ensemble',
                detalhes: { resolvidoAutomaticamente: false, tentativas: tentativaOCR }
            };
        }

        // Se ainda está visível após todas as tentativas, retornar falha
        logger.error(`[CaptchaService] ? CAPTCHA ainda visível após ${tentativaOCR} tentativas.`);
        logger.error('[CaptchaService] ? Limite de tentativas atingido. Verifique manualmente.');
        return {
            sucesso: false,
            metodo: 'ocr-ensemble',
            detalhes: { motivo: `Limite de ${tentativaOCR} tentativas atingido`, tentativas: tentativaOCR }
        };
    }


    /**

     * ?? Obter estatísticas de performance

     */

    private estatisticas = {

        totalTentativas: 0,

        sucessosOCR: 0,

        falhasOCR: 0,

        sucessosManuais: 0,

        tempoMedioOCR: 0,

        confianciaMedia: 0,

        canaisVencedores: {} as Record<string, number>

    };



    registrarEstatistica(resultado: CaptchaResult, tempoMs: number): void {

        this.estatisticas.totalTentativas++;



        // LOG JSON para análise (compatível com ferramentas de monitoramento)

        const logEntry = {

            timestamp: new Date().toISOString(),

            ocr_confidence: resultado.confianca || 0,

            candidate_used: resultado.detalhes?.canal || 'N/A',

            accepted_by_site: resultado.sucesso || false,

            attempts: resultado.detalhes?.tentativas || 1,

            captcha_color_dominant: resultado.detalhes?.corDominante || 'unknown',

            metodo: resultado.metodo,

            tempo_ms: tempoMs

        };



        logger.info('[CaptchaService] ?? Métricas:', JSON.stringify(logEntry));



        if (resultado.metodo === 'ocr-ensemble') {

            if (resultado.sucesso) {

                this.estatisticas.sucessosOCR++;



                // Registrar canal vencedor

                if (resultado.detalhes?.canal) {

                    const canal = resultado.detalhes.canal;

                    this.estatisticas.canaisVencedores[canal] = (this.estatisticas.canaisVencedores[canal] || 0) + 1;

                }

            } else {

                this.estatisticas.falhasOCR++;

            }



            // Atualizar tempo médio

            const n = this.estatisticas.sucessosOCR + this.estatisticas.falhasOCR;

            this.estatisticas.tempoMedioOCR = (this.estatisticas.tempoMedioOCR * (n - 1) + tempoMs) / n;



            // Atualizar confiança média

            if (resultado.confianca) {

                this.estatisticas.confianciaMedia = (this.estatisticas.confianciaMedia * (n - 1) + resultado.confianca) / n;

            }

        } else if (resultado.metodo === 'manual') {

            this.estatisticas.sucessosManuais++;

        }

    }



    obterEstatisticas() {

        const taxaAcertoOCR = this.estatisticas.sucessosOCR /

            (this.estatisticas.sucessosOCR + this.estatisticas.falhasOCR) * 100;



        return {

            ...this.estatisticas,

            taxaAcertoOCR: isNaN(taxaAcertoOCR) ? 0 : taxaAcertoOCR.toFixed(1) + '%',

            tempoMedioOCR: this.estatisticas.tempoMedioOCR.toFixed(0) + 'ms',

            confianciaMedia: this.estatisticas.confianciaMedia.toFixed(1) + '%'

        };

    }

}



export default new CaptchaService();
