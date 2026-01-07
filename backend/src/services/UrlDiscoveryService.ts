/**
 * Serviço genérico para descoberta de URL via serviços externos
 * Suporta múltiplos serviços: Hastebin, Pastebin, GitHub Gist, etc.
 */

import logger from '../utils/logger';
import config from '../config';

interface DiscoveryResponse {
    success: boolean;
    url?: string;
    error?: string;
}

type ServiceType = 'hastebin' | 'pastebin' | 'gist' | '0x0';

class UrlDiscoveryService {
    private serviceType: ServiceType;
    private apiKey: string | null = null;
    private pasteId: string | null = null;
    private lastUploadedUrl: string | null = null;
    private gistRawUrl: string | null = null; // URL raw completa do Gist

    constructor() {
        // Determinar qual serviço usar (padrão: hastebin)
        const service = (process.env.URL_DISCOVERY_SERVICE || 'hastebin').toLowerCase() as ServiceType;
        this.serviceType = ['hastebin', 'pastebin', 'gist', '0x0'].includes(service) ? service : 'hastebin';

        // Carregar configurações específicas do serviço
        this.apiKey = process.env.PASTEBIN_API_KEY || process.env.GITHUB_TOKEN || null;
        this.pasteId = process.env.PASTEBIN_PASTE_ID || process.env.GIST_ID || null;

        // Avisos apenas se mal configurado
        if (this.serviceType === 'gist' && !this.apiKey) {
            logger.warn('Gist configurado mas GITHUB_TOKEN não encontrado');
        }
        if (this.serviceType === 'pastebin' && !this.apiKey) {
            logger.warn('Pastebin configurado mas PASTEBIN_API_KEY não encontrado');
        }
    }

    /**
     * Obter URL pública do paste/documento
     */
    getPublicUrl(): string | null {
        switch (this.serviceType) {
            case 'hastebin':
                return this.pasteId ? `https://hastebin.com/raw/${this.pasteId}` : null;
            case 'pastebin':
                return this.pasteId ? `https://pastebin.com/raw/${this.pasteId}` : null;
            case 'gist':
                // Usar URL raw salva (mais confiável) ou construir se não tiver
                if (this.gistRawUrl) {
                    return this.gistRawUrl;
                }
                // Fallback: tentar construir (mas pode não funcionar se for gist autenticado)
                return this.pasteId ? `https://gist.githubusercontent.com/anonymous/${this.pasteId}/raw/ngrok-url.json` : null;
            case '0x0':
                return this.pasteId ? `https://0x0.st/${this.pasteId}` : null;
            default:
                return null;
        }
    }

    /**
     * Verificar se está configurado
     */
    isConfigured(): boolean {
        // Hastebin não precisa de API key
        if (this.serviceType === 'hastebin' || this.serviceType === '0x0') {
            return true;
        }
        return !!this.apiKey;
    }

    /**
     * Formatar conteúdo para upload
     */
    private formatContent(ngrokUrl: string, apiUrl: string): string {
        const data = {
            url: ngrokUrl,
            apiUrl: apiUrl,
            updatedAt: new Date().toISOString(),
            version: '1.0.6'
        };
        return JSON.stringify(data, null, 2);
    }

    /**
     * Upload para Hastebin
     * ⚠️ LIMITAÇÃO: Hastebin não permite atualizar pastes existentes
     * Cada upload cria um NOVO paste. Use apenas se não precisar de URL fixa.
     */
    private async uploadToHastebin(content: string): Promise<DiscoveryResponse> {
        try {
            logger.info('📤 Fazendo upload para Hastebin...');
            const response = await fetch('https://hastebin.com/documents', {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/plain'
                },
                body: content
            });

            if (!response.ok) {
                const errorText = await response.text();
                logger.error(`❌ Hastebin retornou erro: ${response.status} - ${errorText}`);
                throw new Error(`HTTP ${response.status}: ${errorText}`);
            }

            const data = await response.json();
            const pasteId = data.key;

            if (!pasteId) {
                throw new Error('Resposta inválida do Hastebin: ' + JSON.stringify(data));
            }

            // Hastebin cria novo paste a cada vez - URL vai mudar
            this.pasteId = pasteId;
            const publicUrl = `https://hastebin.com/raw/${pasteId}`;

            return {
                success: true,
                url: publicUrl
            };
        } catch (error: any) {
            logger.error(`Erro ao upload para Hastebin: ${error.message}`);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Upload para Pastebin
     */
    private async uploadToPastebin(content: string): Promise<DiscoveryResponse> {
        if (!this.apiKey) {
            return {
                success: false,
                error: 'Pastebin API key não configurada'
            };
        }

        try {
            const formData = new URLSearchParams();
            formData.append('api_dev_key', this.apiKey);
            formData.append('api_option', 'paste');
            formData.append('api_paste_code', content);
            formData.append('api_paste_name', 'ngrok-url');
            formData.append('api_paste_private', '0'); // Público
            formData.append('api_paste_expire_date', 'N'); // Nunca expira
            formData.append('api_paste_format', 'json');

            const response = await fetch('https://pastebin.com/api/api_post.php', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: formData.toString()
            });

            const text = await response.text();

            if (text.startsWith('http://') || text.startsWith('https://')) {
                const pasteUrl = text.trim();
                const pasteId = pasteUrl.split('/').pop() || null;
                this.pasteId = pasteId;

                return {
                    success: true,
                    url: pasteUrl
                };
            } else {
                return {
                    success: false,
                    error: text
                };
            }
        } catch (error: any) {
            logger.error(`Erro ao upload para Pastebin: ${error.message}`);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Upload para GitHub Gist
     * ✅ PERFEITO: Permite atualizar e manter URL FIXA!
     */
    private async uploadToGist(content: string): Promise<DiscoveryResponse> {
        if (!this.apiKey) {
            return {
                success: false,
                error: 'GitHub token não configurado'
            };
        }

        try {
            const gistData = {
                description: 'ngrok-url-discovery',
                public: true,
                files: {
                    'ngrok-url.json': {
                        content: content
                    }
                }
            };

            // Se já existe um gist, atualizar; senão, criar novo
            const url = this.pasteId
                ? `https://api.github.com/gists/${this.pasteId}`
                : 'https://api.github.com/gists';
            const method = this.pasteId ? 'PATCH' : 'POST';

            const response = await fetch(url, {
                method,
                headers: {
                    'Authorization': `token ${this.apiKey}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/vnd.github.v3+json'
                },
                body: JSON.stringify(gistData)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP ${response.status}: ${errorText}`);
            }

            const data = await response.json();
            const gistId = data.id;

            // Se é um novo gist, salvar o ID
            if (!this.pasteId) {
                this.pasteId = gistId;
                logger.info(`Novo Gist criado (ID: ${gistId}). Salve no .env como GIST_ID.`);
            }

            // URL RAW é sempre a mesma
            const rawUrl = data.files['ngrok-url.json'].raw_url;
            this.gistRawUrl = rawUrl;

            return {
                success: true,
                url: rawUrl
            };
        } catch (error: any) {
            logger.error(`Erro ao upload para GitHub Gist: ${error.message}`);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Upload para 0x0.st
     */
    private async uploadTo0x0(content: string): Promise<DiscoveryResponse> {
        try {
            const formData = new FormData();
            formData.append('file', new Blob([content], { type: 'text/plain' }), 'ngrok-url.json');

            const response = await fetch('https://0x0.st', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const url = (await response.text()).trim();
            this.pasteId = url.split('/').pop() || null;

            return {
                success: true,
                url: url
            };
        } catch (error: any) {
            logger.error(`Erro ao upload para 0x0.st: ${error.message}`);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Verificar conteúdo atual
     */
    async getCurrentContent(): Promise<string | null> {
        const publicUrl = this.getPublicUrl();
        if (!publicUrl) {
            return null;
        }

        try {
            const response = await fetch(publicUrl, {
                signal: AbortSignal.timeout(5000),
                cache: 'no-cache'
            });

            if (response.ok) {
                return await response.text();
            }
            return null;
        } catch (error: any) {
            return null;
        }
    }

    /**
     * Upload ou atualizar URL
     */
    async uploadUrl(ngrokUrl: string, apiUrl: string): Promise<DiscoveryResponse> {
        if (!this.isConfigured()) {
            return {
                success: false,
                error: `${this.serviceType} não configurado`
            };
        }

        // Verificar se URL mudou
        if (this.lastUploadedUrl === apiUrl) {
            logger.debug('📌 URL não mudou, pulando upload');
            return {
                success: true,
                url: this.getPublicUrl() || undefined
            };
        }

        // Verificar conteúdo atual (se existir)
        if (this.pasteId) {
            const currentContent = await this.getCurrentContent();
            if (currentContent) {
                try {
                    const currentData = JSON.parse(currentContent);
                    if (currentData.apiUrl === apiUrl) {
                        logger.debug('📌 URL já está atualizada, pulando upload');
                        this.lastUploadedUrl = apiUrl;
                        return {
                            success: true,
                            url: this.getPublicUrl() || undefined
                        };
                    }
                } catch (error) {
                    // Se não for JSON, continuar e atualizar
                }
            }
        }

        // Formatar conteúdo
        const content = this.formatContent(ngrokUrl, apiUrl);

        // Upload baseado no serviço
        let result: DiscoveryResponse;
        switch (this.serviceType) {
            case 'hastebin':
                result = await this.uploadToHastebin(content);
                break;
            case 'pastebin':
                result = await this.uploadToPastebin(content);
                break;
            case 'gist':
                result = await this.uploadToGist(content);
                break;
            case '0x0':
                result = await this.uploadTo0x0(content);
                break;
            default:
                result = {
                    success: false,
                    error: 'Serviço não suportado'
                };
        }

        if (result.success) {
            this.lastUploadedUrl = apiUrl;
        }

        return result;
    }

    /**
     * Obter tipo de serviço atual
     */
    getServiceType(): ServiceType {
        return this.serviceType;
    }
}

export default new UrlDiscoveryService();

