/**
 * Serviço para upload de arquivos (PDFs de comprovantes) para Backblaze B2
 */

import B2 from 'backblaze-b2';
import logger from '../utils/logger';
import config from '../config';
import * as fs from 'fs';
import * as path from 'path';

class BackblazeService {
    private b2: B2;
    private bucketId: string;
    private bucketName: string;
    private initialized: boolean = false;
    private downloadUrl: string = '';

    constructor() {
        this.b2 = new B2({
            applicationKeyId: config.backblaze.applicationKeyId || '',
            applicationKey: config.backblaze.applicationKey || ''
        });
        this.bucketId = config.backblaze.bucketId || '';
        this.bucketName = config.backblaze.bucketName || '';
    }

    /**
     * Inicializa conexão com Backblaze B2
     */
    async initialize(): Promise<void> {
        if (this.initialized) {
            return;
        }

        try {
            if (!config.backblaze.applicationKeyId || !config.backblaze.applicationKey) {
                logger.warn('[BackblazeService] ⚠️ Credenciais do Backblaze não configuradas');
                return;
            }

            const authResponse = await this.b2.authorize();
            this.downloadUrl = authResponse.data.downloadUrl || '';
            this.initialized = true;
            logger.info(`[BackblazeService] ✅ Conectado ao Backblaze B2 (downloadUrl: ${this.downloadUrl})`);
        } catch (error: any) {
            logger.error(`[BackblazeService] ❌ Erro ao conectar ao Backblaze: ${error.message}`);
            throw error;
        }
    }

    /**
     * Faz upload de um arquivo PDF para o Backblaze B2 a partir de um Buffer
     * @param fileBuffer Buffer do arquivo PDF
     * @param fileName Nome do arquivo no B2 (ex: "comprovante-593664108.pdf")
     * @returns URL pública do arquivo
     */
    async uploadPDF(fileBuffer: Buffer, fileName: string): Promise<string | null> {
        try {
            if (!this.initialized) {
                await this.initialize();
            }

            const fileSize = fileBuffer.length;

            logger.info(`[BackblazeService] 📤 Fazendo upload de ${fileName} (${(fileSize / 1024).toFixed(2)} KB)...`);

            // Obter URL de upload
            const uploadUrlResponse = await this.b2.getUploadUrl({
                bucketId: this.bucketId
            });

            // Fazer upload direto do buffer
            const uploadResponse = await this.b2.uploadFile({
                uploadUrl: uploadUrlResponse.data.uploadUrl,
                uploadAuthToken: uploadUrlResponse.data.authorizationToken,
                fileName: fileName,
                data: fileBuffer,
                contentLength: fileSize,
                contentType: 'application/pdf'
            });

            // Construir URL pública usando downloadUrl obtido no authorize
            // Formato: {downloadUrl}/file/{bucketName}/{fileName}
            const publicUrl = `${this.downloadUrl}/file/${this.bucketName}/${fileName}`;

            logger.info(`[BackblazeService] ✅ Upload concluído: ${publicUrl}`);

            return publicUrl;
        } catch (error: any) {
            logger.error(`[BackblazeService] ❌ Erro ao fazer upload: ${error.message}`);
            return null;
        }
    }

    /**
     * Faz upload de um arquivo PDF para o Backblaze B2 a partir de um caminho de arquivo
     * @param filePath Caminho local do arquivo PDF
     * @param fileName Nome do arquivo no B2 (ex: "comprovante-593664108.pdf")
     * @returns URL pública do arquivo
     */
    async uploadPDFFromFile(filePath: string, fileName: string): Promise<string | null> {
        try {
            if (!fs.existsSync(filePath)) {
                logger.error(`[BackblazeService] Arquivo não encontrado: ${filePath}`);
                return null;
            }

            const fileBuffer = fs.readFileSync(filePath);
            return await this.uploadPDF(fileBuffer, fileName);
        } catch (error: any) {
            logger.error(`[BackblazeService] ❌ Erro ao fazer upload de arquivo: ${error.message}`);
            return null;
        }
    }

    /**
     * Baixa PDF de uma URL (com autenticação) e faz upload para Backblaze
     * @param urlComprovante URL do comprovante no PAT (requer autenticação)
     * @param page Página do Puppeteer autenticada
     * @param fileName Nome do arquivo no B2
     * @returns URL pública do arquivo no Backblaze ou null
     */
    async baixarEUploadComprovante(
        urlComprovante: string,
        page: any,
        fileName: string
    ): Promise<string | null> {
        try {
            if (!this.initialized) {
                await this.initialize();
            }

            logger.info(`[BackblazeService] 📥 Baixando PDF de ${urlComprovante}...`);

            // Navegar para URL do comprovante (com autenticação via Puppeteer)
            // Aguardar carregamento completo antes de fechar
            const response = await page.goto(urlComprovante, {
                waitUntil: 'networkidle2',
                timeout: 60000 // Aumentar timeout para 60s
            });

            // Aguardar mais um pouco para garantir que o PDF foi completamente baixado
            await page.waitForTimeout(3000);

            if (!response || !response.ok()) {
                logger.error(`[BackblazeService] ❌ Erro ao baixar PDF: Status ${response?.status()}`);
                return null;
            }

            // Verificar se é PDF
            const contentType = response.headers()['content-type'];
            if (!contentType?.includes('application/pdf')) {
                logger.error(`[BackblazeService] ❌ Resposta não é PDF: ${contentType}`);
                return null;
            }

            // Baixar PDF como buffer
            const pdfBuffer = await response.buffer();
            const fileSize = pdfBuffer.length;

            // Validar que o buffer não está vazio
            if (fileSize === 0) {
                logger.error(`[BackblazeService] ❌ PDF baixado está vazio`);
                return null;
            }

            logger.info(`[BackblazeService] 📦 PDF baixado (${(fileSize / 1024).toFixed(2)} KB), fazendo upload...`);

            // Fazer upload direto do buffer (sem salvar em disco)
            if (!this.initialized) {
                await this.initialize();
            }

            // Obter URL de upload
            const uploadUrlResponse = await this.b2.getUploadUrl({
                bucketId: this.bucketId
            });

            // Fazer upload direto do buffer
            const uploadResponse = await this.b2.uploadFile({
                uploadUrl: uploadUrlResponse.data.uploadUrl,
                uploadAuthToken: uploadUrlResponse.data.authorizationToken,
                fileName: fileName,
                data: pdfBuffer,
                contentLength: fileSize,
                contentType: 'application/pdf'
            });

            // Construir URL pública
            const publicUrl = `${this.downloadUrl}/file/${this.bucketName}/${fileName}`;

            logger.info(`[BackblazeService] ✅ Upload concluído: ${publicUrl}`);

            return publicUrl;
        } catch (error: any) {
            logger.error(`[BackblazeService] ❌ Erro ao baixar e fazer upload: ${error.message}`);
            return null;
        }
    }

    /**
     * Deleta um arquivo do Backblaze B2
     */
    async deletarArquivo(fileName: string): Promise<boolean> {
        try {
            if (!this.initialized) {
                await this.initialize();
            }

            // Obter fileId primeiro
            const listResponse = await this.b2.listFileNames({
                bucketId: this.bucketId,
                startFileName: fileName,
                maxFileCount: 1
            });

            const file = listResponse.data.files.find((f: any) => f.fileName === fileName);
            if (!file) {
                logger.warn(`[BackblazeService] Arquivo não encontrado: ${fileName}`);
                return false;
            }

            await this.b2.deleteFileVersion({
                fileId: file.fileId,
                fileName: fileName
            });

            logger.info(`[BackblazeService] ✅ Arquivo deletado: ${fileName}`);
            return true;
        } catch (error: any) {
            logger.error(`[BackblazeService] ❌ Erro ao deletar arquivo: ${error.message}`);
            return false;
        }
    }
}

export default new BackblazeService();

