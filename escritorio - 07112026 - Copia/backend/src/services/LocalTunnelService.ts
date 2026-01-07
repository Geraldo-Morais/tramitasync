/**
 * Serviço para capturar e disponibilizar a URL pública via LocalTunnel
 * Substitui ngrok - sem rate limits e URL nova a cada reinício
 */

import localtunnel from 'localtunnel';
import logger from '../utils/logger';
import fs from 'fs';
import path from 'path';

class LocalTunnelService {
    private publicUrl: string | null = null;
    private tunnel: any = null;
    private readonly URL_FILE = path.join(__dirname, '../../.tunnel-url.txt');
    private tunnelStarted: boolean = false;

    /**
     * Carregar URL salva anteriormente
     */
    private loadSavedUrl(): void {
        try {
            if (fs.existsSync(this.URL_FILE)) {
                this.publicUrl = fs.readFileSync(this.URL_FILE, 'utf-8').trim();
            }
        } catch (error) {
            logger.warn('Não foi possível carregar URL salva');
        }
    }

    /**
     * Salvar URL
     */
    private saveUrl(url: string): void {
        try {
            fs.writeFileSync(this.URL_FILE, url, 'utf-8');
            this.publicUrl = url;
        } catch (error) {
            logger.error('Erro ao salvar URL', error);
        }
    }

    /**
     * Iniciar túnel LocalTunnel
     */
    public async startTunnel(localPort: number): Promise<void> {
        if (process.env.DISABLE_TUNNEL === 'true') {
            return;
        }

        if (this.tunnelStarted) {
            return;
        }

        this.loadSavedUrl();

        try {
            this.tunnelStarted = true;

            // Criar túnel com subdomain aleatório (força URL nova)
            const randomSubdomain = `inss-${Math.random().toString(36).substring(2, 10)}`;

            this.tunnel = await localtunnel({
                port: localPort,
                subdomain: randomSubdomain
            });

            const url = this.tunnel.url;
            const previousUrl = this.publicUrl;

            this.saveUrl(url);
            logger.info(`🌐 Túnel público: ${url}`);

            // Se a URL mudou, atualizar no serviço de descoberta
            if (previousUrl !== url) {
                await this.updateDiscoveryService(url);
            }

            // Tratar erros do túnel
            this.tunnel.on('error', (err: Error) => {
                logger.error('Erro no túnel:', err.message);
                this.tunnelStarted = false;
            });

            this.tunnel.on('close', () => {
                logger.warn('Túnel fechado');
                this.tunnelStarted = false;
            });

        } catch (error: any) {
            logger.error('Falha ao iniciar túnel:', error.message);
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
     * Atualizar URL no serviço de descoberta
     */
    private async updateDiscoveryService(tunnelUrl: string): Promise<void> {
        try {
            const discoveryService = (await import('./UrlDiscoveryService')).default;

            if (!discoveryService.isConfigured()) {
                return;
            }

            const apiUrl = `${tunnelUrl}/api/v1`;
            const result = await discoveryService.uploadUrl(tunnelUrl, apiUrl);

            if (result.success && result.url) {
                const serviceType = discoveryService.getServiceType();
                logger.info(`📋 URL atualizada no ${serviceType}: ${result.url}`);
            } else if (result.error) {
                logger.warn(`⚠️ Erro ao atualizar serviço de descoberta: ${result.error}`);
            }
        } catch (error: any) {
            logger.debug(`Erro ao atualizar serviço de descoberta: ${error.message}`);
        }
    }

    /**
     * Parar o túnel
     */
    public stopTunnel(): void {
        if (this.tunnel) {
            this.tunnel.close();
            this.tunnel = null;
            this.tunnelStarted = false;
        }
    }
}

export default new LocalTunnelService();
