/**
 * Serviço para capturar e disponibilizar a URL pública do ngrok
 * Alternativa ao Cloudflare Tunnel quando há rate limit
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger';

const execAsync = promisify(exec);

class NgrokTunnelService {
    private publicUrl: string | null = null;
    private ngrokProcess: any = null;
    private readonly URL_FILE = path.join(__dirname, '../../.ngrok-url.txt');
    private tunnelStarted: boolean = false;
    private readonly NGROK_API = 'http://localhost:4040/api/tunnels';

    /**
     * Verificar se ngrok está instalado
     */
    private async isNgrokInstalled(): Promise<boolean> {
        try {
            // Verificar se existe ngrok.exe na pasta backend
            const ngrokPath = path.join(__dirname, '../../ngrok.exe');
            if (fs.existsSync(ngrokPath)) {
                return true;
            }

            // Verificar se está no PATH
            await execAsync('ngrok version');
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Obter caminho do ngrok
     */
    private getNgrokPath(): string {
        const ngrokPath = path.join(__dirname, '../../ngrok.exe');
        if (fs.existsSync(ngrokPath)) {
            return ngrokPath;
        }
        return 'ngrok'; // Assume que está no PATH
    }

    /**
     * Carregar URL salva anteriormente
     */
    private loadSavedUrl(): void {
        try {
            if (fs.existsSync(this.URL_FILE)) {
                this.publicUrl = fs.readFileSync(this.URL_FILE, 'utf-8').trim();
                // Silencioso - URL carregada
            }
        } catch (error) {
            logger.warn('Não foi possível carregar URL do ngrok salva');
        }
    }

    /**
     * Salvar URL
     */
    private saveUrl(url: string): void {
        try {
            fs.writeFileSync(this.URL_FILE, url, 'utf-8');
            this.publicUrl = url;
            // Silencioso - URL salva
        } catch (error) {
            logger.error('Erro ao salvar URL do ngrok', error);
        }
    }

    /**
     * Obter URL do ngrok via API
     */
    private async fetchNgrokUrl(): Promise<string | null> {
        try {
            const response = await fetch(this.NGROK_API);
            if (!response.ok) {
                return null;
            }

            const data = await response.json();
            if (data.tunnels && data.tunnels.length > 0) {
                const tunnel = data.tunnels[0];
                return tunnel.public_url || null;
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    /**
     * Iniciar túnel ngrok
     */
    public async startTunnel(localPort: number): Promise<void> {
        if (process.env.DISABLE_NGROK_TUNNEL === 'true') {
            return;
        }

        if (this.tunnelStarted) {
            return;
        }

        const isInstalled = await this.isNgrokInstalled();
        if (!isInstalled) {
            // Silencioso - ngrok não encontrado
            return;
        }

        // Carregar URL salva
        this.loadSavedUrl();

        try {
            this.tunnelStarted = true;

            // Matar processos ngrok existentes para forçar nova URL
            try {
                await execAsync('taskkill /F /IM ngrok.exe 2>nul');
                await new Promise(resolve => setTimeout(resolve, 1000)); // Aguardar 1s
            } catch (e) {
                // Ignorar erro se não houver processo
            }

            // Log será feito quando URL for obtida

            const ngrokPath = this.getNgrokPath();
            const { spawn } = require('child_process');

            // Forçar nova URL a cada reinício (alternando região)
            const regions = ['us', 'eu', 'ap', 'au', 'sa', 'jp', 'in'];
            const randomRegion = regions[Math.floor(Math.random() * regions.length)];

            this.ngrokProcess = spawn(ngrokPath, [
                'http',
                localPort.toString(),
                '--log=stdout',
                `--region=${randomRegion}`  // Força nova URL
            ]);

            // Aguardar ngrok iniciar e obter URL
            let attempts = 0;
            const maxAttempts = 15; // 30 segundos total

            const checkUrl = setInterval(async () => {
                attempts++;
                const url = await this.fetchNgrokUrl();

                if (url) {
                    clearInterval(checkUrl);
                    const previousUrl = this.publicUrl;
                    this.saveUrl(url);
                    logger.info(`Túnel ngrok: ${url}`);

                    // Atualizar serviço de descoberta
                    await this.updateDiscoveryService(url);
                } else if (attempts >= maxAttempts) {
                    clearInterval(checkUrl);
                    logger.warn('Não foi possível obter URL do ngrok');
                }
            }, 2000); // Verificar a cada 2 segundos

            this.ngrokProcess.stdout.on('data', (data: Buffer) => {
                const output = data.toString();
                // Log apenas erros importantes
                if (output.includes('error') || output.includes('Error')) {
                    logger.warn(`[ngrok] ${output.trim()}`);
                }
            });

            this.ngrokProcess.stderr.on('data', (data: Buffer) => {
                const output = data.toString();
                if (output.includes('error') || output.includes('Error')) {
                    logger.warn(`[ngrok] ${output.trim()}`);
                }
            });

            this.ngrokProcess.on('error', (error: Error) => {
                logger.error('Erro ao iniciar ngrok:', error.message);
                this.tunnelStarted = false;
            });

            this.ngrokProcess.on('exit', (code: number) => {
                this.tunnelStarted = false;
                clearInterval(checkUrl);
            });

        } catch (error: any) {
            logger.error('Falha ao iniciar ngrok:', error.message);
            this.tunnelStarted = false;
        }
    }

    /**
     * Obter URL pública atual
     */
    public getPublicUrl(): string | null {
        return this.publicUrl;
    }

    /**
     * Atualizar URL no serviço de descoberta (quando mudar)
     */
    private async updateDiscoveryService(ngrokUrl: string): Promise<void> {
        try {
            const discoveryService = (await import('./UrlDiscoveryService')).default;

            if (!discoveryService.isConfigured()) {
                // Silencioso - Serviço não configurado
                return;
            }

            // Construir API URL
            const apiUrl = `${ngrokUrl}/api/v1`;

            // Upload para serviço de descoberta (só atualiza se URL mudou)
            const result = await discoveryService.uploadUrl(ngrokUrl, apiUrl);

            // Silencioso - não logar a cada atualização
        } catch (error: any) {
            // Silencioso - erro não crítico
            logger.debug(`Erro ao atualizar serviço de descoberta: ${error.message}`);
        }
    }

    /**
     * Parar o túnel
     */
    public stopTunnel(): void {
        if (this.ngrokProcess) {
            this.ngrokProcess.kill();
            this.ngrokProcess = null;
            this.tunnelStarted = false;
        }
    }
}

export default new NgrokTunnelService();

