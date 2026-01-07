function runContent(apiBaseUrl) {
    'use strict';
    let API_BASE_URL = apiBaseUrl;
    'use strict';
    // Versão da extensão - ATUALIZAR quando fizer mudanças!
    const EXTENSAO_VERSION = '1.0.6';
    console.log(`[Extensão] Inicializando v${EXTENSAO_VERSION} - Tramitação Inteligente`);
    console.log('[Extensão] URL atual:', window.location.href);
    console.log('[Extensão] Estado do documento:', document.readyState);

    // ===== CONFIGURAÇÃO E STORAGE =====

    // URL padrão do backend (localhost - Cloudflare Tunnel será detectado automaticamente)
    const DEFAULT_API_URL = 'http://localhost:3000/api/v1';
    // let API_BASE_URL = null; // Injected by loader

    // Chaves de armazenamento
    // ⚠️ SEGURANÇA: NUNCA armazenar dados sensíveis no client-side
    const STORAGE_KEYS = {
        API_URL: 'extensao_api_url',
        AUTH_TOKEN: 'extensao_auth_token',
        USER_DATA: 'extensao_user_data'
        // Removido: PAT_TOKEN, TRAMITACAO_EMAIL, TRAMITACAO_SENHA
        // Esses dados são gerenciados APENAS no backend
    };

    const TOKEN_VALIDADE_HORAS = 2;

    // Funções de storage (substituem GM_getValue/GM_setValue)
    async function getStorage(key) {
        const result = await chrome.storage.local.get([key]);
        return result[key] || null;
    }

    async function setStorage(key, value) {
        await chrome.storage.local.set({ [key]: value });
    }

    // Verificar se uma URL está acessível
    async function verificarUrlAcessivel(url, timeoutMs = 5000) {
        if (!url || !url.startsWith('http')) {
            return false;
        }

        try {
            // Normalizar URL - remover barra final e garantir /api/v1
            let normalizedUrl = url.trim();
            if (normalizedUrl.endsWith('/')) {
                normalizedUrl = normalizedUrl.slice(0, -1);
            }

            // Se não termina com /api/v1, adicionar
            if (!normalizedUrl.endsWith('/api/v1')) {
                if (normalizedUrl.endsWith('/api')) {
                    normalizedUrl += '/v1';
                } else {
                    normalizedUrl += '/api/v1';
                }
            }

            // Tentar endpoint health check
            const healthUrl = normalizedUrl + '/health';
            const response = await fetch(healthUrl, {
                method: 'GET',
                signal: AbortSignal.timeout(timeoutMs),
                cache: 'no-cache',
                headers: {
                    'Accept': 'application/json'
                }
            });

            // Se retornou OK, URL está acessível
            if (response.ok) {
                return true;
            }

            // Se retornou erro mas não é erro de conexão, URL existe mas pode ter problema
            // Considerar como acessível se não for erro de rede
            return response.status !== 0;
        } catch (error) {
            // Tratamento específico para diferentes tipos de erro
            const errorMsg = error.message || String(error);

            // ERR_NAME_NOT_RESOLVED = DNS não resolve (túnel não existe ou expirou)
            if (errorMsg.includes('ERR_NAME_NOT_RESOLVED') || errorMsg.includes('Failed to fetch')) {
                console.log(`[Extensão] URL não acessível: ${url} - Domínio não encontrado (túnel pode ter expirado ou não estar rodando)`);
            } else {
                console.log(`[Extensão] URL não acessível: ${url} - ${errorMsg}`);
            }
            return false;
        }
    }

    // Inicializar URL da API (detectar backend automaticamente)
    async function inicializarUrlApi() {
        // Se já está inicializado, retornar
        if (API_BASE_URL) {
            return API_BASE_URL;
        }

        // Sempre tentar detectar URL do backend automaticamente
        try {
            const response = await new Promise((resolve, reject) => {
                chrome.runtime.sendMessage({ action: 'detectarUrlBackend' }, (response) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                    } else {
                        resolve(response);
                    }
                });
            });

            if (response && response.url) {
                // Verificar se a URL detectada está acessível
                const acessivel = await verificarUrlAcessivel(response.url);
                if (acessivel) {
                    API_BASE_URL = response.url;
                    await setStorage(STORAGE_KEYS.API_URL, response.url);
                    console.log('[Extensão] URL do backend detectada e validada:', response.url);
                    return response.url;
                } else {
                    console.warn('[Extensão] URL detectada não está acessível, limpando...');
                    await setStorage(STORAGE_KEYS.API_URL, null);
                }
            }
        } catch (error) {
            console.warn('[Extensão] Erro ao detectar URL do backend via background:', error);
        }

        // Se não detectou, tentar obter do storage e VALIDAR
        let url = await getStorage(STORAGE_KEYS.API_URL);
        if (url) {
            // VALIDAÇÃO AUTOMÁTICA: Verificar se URL salva ainda está acessível
            console.log('[Extensão] Validando URL salva:', url);

            // Se for URL do Cloudflare, usar timeout maior
            const timeout = url.includes('trycloudflare.com') ? 10000 : 5000;
            const acessivel = await verificarUrlAcessivel(url, timeout);

            if (acessivel) {
                API_BASE_URL = url;
                console.log('[Extensão] URL do storage validada e acessível:', url);
                return url;
            } else {
                // ⚠️ LIMPEZA AUTOMÁTICA: URL salva não está mais acessível
                // Se for Cloudflare, pode ter expirado - tentar obter nova URL do backend
                if (url.includes('trycloudflare.com')) {
                    console.warn('[Extensão] URL do Cloudflare expirada ou não acessível. Tentando obter nova URL do backend...');
                    try {
                        // Tentar obter nova URL do backend (que pode reiniciar o túnel)
                        const novaUrlResponse = await fetch(`${DEFAULT_API_URL}/system/public-url`, {
                            signal: AbortSignal.timeout(5000),
                            cache: 'no-cache'
                        });
                        if (novaUrlResponse.ok) {
                            const novaUrlData = await novaUrlResponse.json();
                            if (novaUrlData.success && novaUrlData.apiUrl) {
                                const novaUrl = novaUrlData.apiUrl;
                                const novaAcessivel = await verificarUrlAcessivel(novaUrl, 10000);
                                if (novaAcessivel) {
                                    API_BASE_URL = novaUrl;
                                    await setStorage(STORAGE_KEYS.API_URL, novaUrl);
                                    console.log('[Extensão] Nova URL do Cloudflare obtida e validada:', novaUrl);
                                    return novaUrl;
                                }
                            }
                        }
                    } catch (error) {
                        console.warn('[Extensão] Não foi possível obter nova URL do backend:', error);
                    }
                }

                console.warn('[Extensão] URL salva não está mais acessível, limpando automaticamente...');
                await setStorage(STORAGE_KEYS.API_URL, null);
                url = null; // Forçar detecção de nova URL
            }
        }

        // Fallback: usar URL padrão (localhost) e validar
        const localhostUrl = DEFAULT_API_URL;
        console.log('[Extensão] Tentando validar localhost:', localhostUrl);
        const localhostAcessivel = await verificarUrlAcessivel(localhostUrl);

        if (localhostAcessivel) {
            API_BASE_URL = localhostUrl;
            await setStorage(STORAGE_KEYS.API_URL, localhostUrl);
            console.log('[Extensão] Localhost está acessível, usando:', localhostUrl);
            return localhostUrl;
        } else {
            // Mesmo que localhost não esteja acessível, usar como padrão
            // O usuário verá erro claro se tentar usar
            API_BASE_URL = localhostUrl;
            console.warn('[Extensão] Localhost não está acessível, mas usando como padrão:', localhostUrl);
            return localhostUrl;
        }
    }

    // Funções de autenticação
    async function obterTokenAuth() {
        return await getStorage(STORAGE_KEYS.AUTH_TOKEN);
    }

    async function salvarTokenAuth(token) {
        await setStorage(STORAGE_KEYS.AUTH_TOKEN, token);
    }

    async function removerTokenAuth() {
        await setStorage(STORAGE_KEYS.AUTH_TOKEN, null);
        await setStorage(STORAGE_KEYS.USER_DATA, null);
    }

    async function obterUsuarioCacheado() {
        const cached = await getStorage(STORAGE_KEYS.USER_DATA);
        if (!cached) return null;
        try {
            return JSON.parse(cached);
        } catch {
            return null;
        }
    }

    async function salvarUsuarioCacheado(user) {
        await setStorage(STORAGE_KEYS.USER_DATA, JSON.stringify(user));
    }

    // ⚠️ SEGURANÇA: Token PAT não é mais armazenado no client-side
    // Funções removidas - token é capturado e enviado diretamente para o backend
    // O backend gerencia o token no banco de dados de forma segura

    // Buscar token PAT do histórico via background (apenas captura, não armazena)
    async function buscarTokenPatNoHistorico() {
        try {
            const response = await chrome.runtime.sendMessage({ action: 'buscarTokenPat' });
            if (response && response.token) {
                // ⚠️ SEGURANÇA: Enviar diretamente para o backend, não armazenar localmente
                await atualizarPatToken(response.token);
                return response.token;
            }
        } catch (error) {
            console.error('[Extensão] Erro ao buscar token PAT:', error);
        }
        return null;
    }

    // ===== REQUISIÇÕES HTTP (via Background Script para bypass CORS) =====

    async function fazerRequisicao(url, options = {}) {
        // Garantir que API_BASE_URL está inicializado
        if (!API_BASE_URL) {
            console.log('[Extensão] API_BASE_URL não inicializado em fazerRequisicao, inicializando...');
            await inicializarUrlApi();
        }

        if (!API_BASE_URL) {
            throw new Error('API_BASE_URL não está disponível. Verifique se o backend está rodando e acessível.');
        }

        // Guardar URL original para retry
        const urlOriginalRelativa = url.startsWith('http') ? url.replace(API_BASE_URL, '') : url;

        // Se URL relativa, adicionar base
        if (url.startsWith('/')) {
            url = API_BASE_URL + url;
        } else if (!url.startsWith('http')) {
            url = API_BASE_URL + '/' + url;
        }

        const method = options.method || 'GET';
        const headers = {
            'Content-Type': 'application/json',
            'ngrok-skip-browser-warning': 'true',
            ...(options.headers || {})
        };

        let body = null;
        if (options.body) {
            body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
        }

        try {
            console.log(`[Extensão] Fetching via Background Proxy: ${method} ${url}`);

            // Usar o proxy do background script para bypass CORS
            const result = await window.__callExtension('runtime.sendMessage', [{
                action: 'fetchResource',
                url: url,
                method: method,
                headers: headers,
                body: body
            }]);

            // Verificar resultado do proxy
            if (!result) {
                throw new Error('Sem resposta do background script');
            }

            if (!result.success) {
                // Verificar se é erro de conexão para retry
                const errorMsg = result.error || 'Erro desconhecido';
                if (!options._isRetry && (errorMsg.includes('Failed to fetch') || errorMsg.includes('NetworkError') || errorMsg.includes('net::ERR'))) {
                    console.log('[Extensão] Erro de conexão via proxy. Tentando recuperar com nova URL...');
                    await setStorage(STORAGE_KEYS.API_URL, null);
                    const novaUrl = await inicializarUrlApi();
                    console.log(`[Extensão] ♻️ Nova URL detectada: ${novaUrl}. Tentando novamente...`);
                    return fazerRequisicao(urlOriginalRelativa, { ...options, _isRetry: true });
                }
                throw new Error(errorMsg);
            }

            const responseBody = result.body || '';
            const status = result.status || 200;
            const isOk = status >= 200 && status < 300;

            // Verificar se é HTML (erro do servidor)
            if (responseBody.trim().startsWith('<') || responseBody.includes('<!DOCTYPE')) {
                // Verificar se é página intersticial do ngrok
                if (responseBody.includes('ngrok') && (responseBody.includes('ERR_NGROK_6024') || responseBody.includes('Visit Site'))) {
                    const baseUrl = url.split('/api/v1')[0];
                    throw new Error(
                        `⚠️ Página de aviso do ngrok detectada!\n\n` +
                        `O plano free do ngrok mostra uma página de aviso antes de permitir acesso.\n\n` +
                        `SOLUÇÃO RÁPIDA:\n` +
                        `1. Abra uma nova aba no navegador\n` +
                        `2. Acesse: ${baseUrl}\n` +
                        `3. Clique no botão "Visit Site" ou "Continuar"\n` +
                        `4. Aguarde 5 segundos\n` +
                        `5. Tente fazer login novamente\n\n` +
                        `💡 Isso precisa ser feito apenas UMA VEZ por sessão do ngrok.`
                    );
                }

                throw new Error(
                    `Erro: O servidor retornou uma página HTML ao invés de JSON.\n\n` +
                    `Isso geralmente indica:\n` +
                    `1. URL da API está incorreta (retornou 404)\n` +
                    `2. Servidor está com erro (retornou página de erro)\n` +
                    `3. Rota não existe no backend\n\n` +
                    `Status: ${status}\n` +
                    `URL: ${url}`
                );
            }

            // Cache do body para evitar consumir múltiplas vezes
            let bodyConsumed = false;
            let cachedBody = responseBody;

            // Criar mock response similar ao fetch
            const mockResponse = {
                ok: isOk,
                status: status,
                statusText: isOk ? 'OK' : 'Error',
                json: async () => {
                    if (!cachedBody || cachedBody.trim() === '') {
                        throw new Error('Resposta vazia do servidor');
                    }
                    try {
                        return JSON.parse(cachedBody);
                    } catch (e) {
                        throw new Error(`Erro ao parsear JSON: ${e.message}. Body: ${cachedBody.substring(0, 100)}`);
                    }
                },
                text: async () => cachedBody,
                headers: result.headers || {}
            };

            return mockResponse;
        } catch (error) {
            console.error(`[Extensão] Erro no fetch para ${url}:`, error);

            // TENTATIVA DE RECUPERAÇÃO AUTOMÁTICA (Retry com nova URL)
            if (!options._isRetry && (error.message.includes('Failed to fetch') || error.message.includes('NetworkError') || error.message.includes('ERR_NAME_NOT_RESOLVED') || error.message.includes('net::ERR'))) {
                console.log('[Extensão] Erro de conexão. Tentando recuperar com nova URL...');
                await setStorage(STORAGE_KEYS.API_URL, null);
                const novaUrl = await inicializarUrlApi();
                console.log(`[Extensão] ♻️ Nova URL detectada: ${novaUrl}. Tentando novamente...`);
                return fazerRequisicao(urlOriginalRelativa, { ...options, _isRetry: true });
            }

            if (error.message) {
                throw error;
            }
            throw new Error(
                `Não foi possível conectar ao servidor.\n\n` +
                `VERIFIQUE:\n` +
                `1. Backend está rodando?\n` +
                `2. URL da API está correta? (atualmente: ${API_BASE_URL})\n` +
                `3. Para acesso remoto, use ngrok ou IP público\n` +
                `4. Firewall não está bloqueando?\n\n` +
                `Erro: ${error.message || error}`
            );
        }
    }


    // ===== UI COMPONENTS (mesmos do Tampermonkey) =====

    /**
     * Fecha todos os modais abertos para evitar sobreposição
     */
    function fecharTodosModais() {
        const modaisIds = [
            'extensao-api-url-modal',
            'extensao-login-modal',
            'extensao-config-modal',
            'extensao-whatsapp-modal',
            'extensao-opcoes-modal',
            'extensao-confirm-modal',
            'extensao-input-modal',
            'extensao-feedback-modal'
        ];

        modaisIds.forEach(id => {
            const modal = document.getElementById(id);
            if (modal) {
                modal.remove();
            }
        });

        // Também fechar qualquer modal com classe extensao-modal
        document.querySelectorAll('.extensao-modal').forEach(modal => {
            modal.remove();
        });
    }

    function mostrarToast(mensagem, tipo = 'info', duracao = 5000) {
        const toast = document.createElement('div');
        const toastId = 'extensao-toast-' + Date.now();
        toast.id = toastId;

        const cores = {
            success: { bg: '#10B981', border: '#059669' },
            error: { bg: '#df1b41', border: '#b73333' },
            warning: { bg: '#ce8012', border: '#ce8012' },
            info: { bg: '#428bca', border: '#428bca' }
        };

        const cor = cores[tipo] || cores.info;

        toast.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: ${cor.bg};
            color: #333;
            padding: 16px 20px;
            border-radius: 4px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.15);
            z-index: 10002;
            max-width: 400px;
            display: flex;
            align-items: center;
            gap: 12px;
            font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
            font-size: 14px;
            line-height: 1.5;
            animation: slideInRight 0.3s ease-out;
        `;

        toast.innerHTML = `
            <span style="flex: 1;">${mensagem}</span>
            <button onclick="document.getElementById('${toastId}').remove()" style="
                background: transparent;
                border: none;
                color: #333;
                cursor: pointer;
                padding: 4px 8px;
                font-size: 18px;
                line-height: 1;
                opacity: 0.8;
            ">×</button>
        `;

        if (!document.getElementById('extensao-toast-styles')) {
            const style = document.createElement('style');
            style.id = 'extensao-toast-styles';
            style.textContent = `
                @keyframes slideInRight {
                    from { transform: translateX(100%); opacity: 0; }
                    to { transform: translateX(0); opacity: 1; }
                }
                @keyframes slideOutRight {
                    from { transform: translateX(0); opacity: 1; }
                    to { transform: translateX(100%); opacity: 0; }
                }
            `;
            document.head.appendChild(style);
        }

        document.body.appendChild(toast);

        setTimeout(() => {
            toast.style.animation = 'slideOutRight 0.3s ease-out';
            setTimeout(() => {
                if (document.body.contains(toast)) {
                    document.body.removeChild(toast);
                }
            }, 300);
        }, duracao);

        return toast;
    }

    function mostrarConfirmacao(titulo, mensagem, opcoes = {}) {
        return new Promise((resolve) => {
            const { textoConfirmar = 'Confirmar', textoCancelar = 'Cancelar', tipo = 'info' } = opcoes;

            // Fechar todos os modais antes de abrir este
            fecharTodosModais();

            const modal = document.createElement('div');
            modal.id = 'extensao-confirm-modal';
            modal.className = 'extensao-modal';

            const content = document.createElement('div');
            content.className = 'extensao-modal-content';

            const coresBtn = {
                info: 'var(--primary-yellow)',
                warning: '#F59E0B',
                danger: '#EF4444',
                success: 'var(--success-green)'
            };

            const coresTexto = {
                info: 'var(--primary-text)',
                warning: '#92400E',
                danger: 'white',
                success: 'white'
            };

            content.innerHTML = `
                <h2 class="extensao-title">${titulo}</h2>
                <p style="margin: 0 0 20px 0; color: var(--text-main); font-size: 14px; line-height: 1.5; white-space: pre-line;">${mensagem}</p>
                <div class="extensao-flex-row">
                    <button id="extensao-confirm-cancel" class="extensao-btn-secondary">${textoCancelar}</button>
                    <button id="extensao-confirm-ok" class="extensao-btn-primary" style="background: ${coresBtn[tipo] || coresBtn.info}; color: ${coresTexto[tipo] || coresTexto.info};">
                        ${textoConfirmar}
                    </button>
                </div>
            `;

            const btnOk = content.querySelector('#extensao-confirm-ok');
            const btnCancel = content.querySelector('#extensao-confirm-cancel');

            btnOk.addEventListener('click', () => {
                if (document.body.contains(modal)) {
                    document.body.removeChild(modal);
                }
                resolve(true);
            });

            btnCancel.addEventListener('click', () => {
                if (document.body.contains(modal)) {
                    document.body.removeChild(modal);
                }
                resolve(false);
            });

            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    if (document.body.contains(modal)) {
                        document.body.removeChild(modal);
                    }
                    resolve(false);
                }
            });

            modal.appendChild(content);
            document.body.appendChild(modal);
        });
    }

    function mostrarInput(titulo, mensagem, valorPadrao = '', opcoes = {}) {
        return new Promise((resolve) => {
            const { placeholder = '', tipo = 'text', textoConfirmar = 'OK', textoCancelar = 'Cancelar', validacao } = opcoes;

            // Fechar todos os modais antes de abrir este
            fecharTodosModais();

            const modal = document.createElement('div');
            modal.id = 'extensao-input-modal';
            modal.className = 'extensao-modal';

            const content = document.createElement('div');
            content.className = 'extensao-modal-content';

            content.innerHTML = `
                <h2 class="extensao-title">${titulo}</h2>
                <p style="margin: 0 0 16px 0; color: var(--text-main); font-size: 14px; line-height: 1.5; white-space: pre-line;">${mensagem}</p>
                <input 
                    type="${tipo}" 
                    id="extensao-input-field" 
                    value="${valorPadrao}"
                    placeholder="${placeholder}"
                    class="extensao-input-modern"
                    style="margin-bottom: 12px;"
                    autocomplete="off"
                >
                <div id="extensao-input-error" style="color: #991B1B; font-size: 12px; margin-bottom: 12px; padding: 8px; background: #FEE2E2; border-radius: 4px; display: none;"></div>
                <div class="extensao-flex-row">
                    <button id="extensao-input-cancel" class="extensao-btn-secondary">${textoCancelar}</button>
                    <button id="extensao-input-ok" class="extensao-btn-primary">${textoConfirmar}</button>
                </div>
            `;

            const input = content.querySelector('#extensao-input-field');
            const btnOk = content.querySelector('#extensao-input-ok');
            const btnCancel = content.querySelector('#extensao-input-cancel');
            const errorDiv = content.querySelector('#extensao-input-error');

            setTimeout(() => input.focus(), 100);

            input.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    btnOk.click();
                }
            });

            btnOk.addEventListener('click', () => {
                const valor = input.value.trim();

                if (validacao) {
                    const erro = validacao(valor);
                    if (erro) {
                        errorDiv.textContent = erro;
                        errorDiv.style.display = 'block';
                        return;
                    }
                }

                if (document.body.contains(modal)) {
                    document.body.removeChild(modal);
                }
                resolve(valor);
            });

            btnCancel.addEventListener('click', () => {
                if (document.body.contains(modal)) {
                    document.body.removeChild(modal);
                }
                resolve(null);
            });

            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    if (document.body.contains(modal)) {
                        document.body.removeChild(modal);
                    }
                    resolve(null);
                }
            });

            modal.appendChild(content);
            document.body.appendChild(modal);
        });
    }

    // ===== FUNÇÕES DE AUTENTICAÇÃO E CONFIGURAÇÃO =====

    const PAT_URL = 'https://atendimento.inss.gov.br';

    /**
     * Verifica se a URL da API está configurada e acessível
     * Se não estiver, exibe modal para configurar antes de continuar
     */
    async function verificarEConfigurarApiUrl() {
        // Garantir que API_BASE_URL está inicializado
        if (!API_BASE_URL) {
            await inicializarUrlApi();
        }

        // Se ainda não tem URL ou não está acessível, pedir para configurar
        if (!API_BASE_URL) {
            console.log('[Extensão] URL da API não configurada, exibindo modal de configuração...');
            const configurado = await exibirModalConfigurarApiUrl();
            if (!configurado) {
                throw new Error('URL da API não foi configurada. Não é possível continuar.');
            }
            return;
        }

        // Verificar se a URL atual está acessível
        const acessivel = await verificarUrlAcessivel(API_BASE_URL);
        if (!acessivel) {
            console.log('[Extensão] URL da API não está acessível, exibindo modal de configuração...');
            const configurado = await exibirModalConfigurarApiUrl();
            if (!configurado) {
                throw new Error('URL da API não está acessível. Não é possível continuar.');
            }
        }
    }

    async function verificarAutenticacao() {
        const token = await obterTokenAuth();
        if (!token) {
            console.log('[Extensão] Nenhum token de autenticação encontrado');
            return false;
        }

        // Garantir que API_BASE_URL está inicializado
        if (!API_BASE_URL) {
            console.log('[Extensão] API_BASE_URL não inicializado, tentando inicializar...');
            await inicializarUrlApi();
        }

        if (!API_BASE_URL) {
            console.error('[Extensão] API_BASE_URL ainda não está disponível');
            return false;
        }

        try {
            const response = await fazerRequisicao(`${API_BASE_URL}/extensao/config`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            if (response.ok) {
                console.log('[Extensão] Autenticação verificada com sucesso');
                return true;
            } else {
                console.log('[Extensão] Token inválido ou expirado');
                await removerTokenAuth();
                return false;
            }
        } catch (error) {
            console.warn('[Extensão] Erro ao verificar autenticação:', error);
            return false;
        }
    }

    async function obterConfiguracoes() {
        const token = await obterTokenAuth();
        if (!token) return null;

        try {
            const response = await fazerRequisicao(`${API_BASE_URL}/extensao/config`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            if (response.ok) {
                const data = await response.json();
                return data.config;
            }
        } catch (error) {
            console.error('[Extensão] Erro ao obter configurações:', error);
        }

        return null;
    }

    async function atualizarPatToken(tokenPat) {
        const token = await obterTokenAuth();
        if (!token) return false;

        try {
            const response = await fazerRequisicao(`${API_BASE_URL}/extensao/config`, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ patToken: tokenPat })
            });

            return response.ok;
        } catch (error) {
            console.error('[Extensão] Erro ao atualizar token PAT:', error);
            return false;
        }
    }

    // Função removida: configurarUrlApi() - URL sempre detectada automaticamente via ngrok

    // ===== FUNÇÕES COMPLETAS ADAPTADAS =====

    async function obterTokenPat() {
        // ⚠️ SEGURANÇA: Token PAT não é mais armazenado no client-side
        // Apenas captura do histórico/URL atual e envia diretamente para o backend
        console.log('[Extensão] Tentando capturar token PAT do histórico (últimos 30 min)...');
        let tokenDoHistorico = null;

        try {
            if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
                try {
                    const response = await new Promise((resolve, reject) => {
                        chrome.runtime.sendMessage({ action: 'buscarTokenPat' }, (response) => {
                            if (chrome.runtime.lastError) {
                                reject(chrome.runtime.lastError);
                            } else {
                                resolve(response);
                            }
                        });
                    });

                    if (response && response.token) {
                        tokenDoHistorico = response.token;
                        console.log('[Extensão] Token encontrado no histórico via background.js!');
                    }
                } catch (chromeError) {
                    console.warn('[Extensão] Erro ao buscar token via background.js:', chromeError);
                }
            }

            if (!tokenDoHistorico && typeof chrome !== 'undefined' && chrome.tabs) {
                try {
                    const tabs = await new Promise((resolve, reject) => {
                        chrome.tabs.query({}, (tabs) => {
                            if (chrome.runtime.lastError) {
                                reject(chrome.runtime.lastError);
                            } else {
                                resolve(tabs);
                            }
                        });
                    });

                    for (const tab of tabs || []) {
                        if (tab.url && tab.url.includes('atendimento.inss.gov.br') && tab.url.includes('access_token=')) {
                            const urlObj = new URL(tab.url);
                            const hash = urlObj.hash || '';
                            const searchParams = new URLSearchParams(hash.substring(1) + urlObj.search.substring(1));

                            const accessToken = searchParams.get('access_token');
                            if (accessToken && accessToken.startsWith('AT-')) {
                                const tokenType = searchParams.get('token_type') || 'bearer';
                                const expiresIn = searchParams.get('expires_in') || '1800';
                                const refreshToken = searchParams.get('refresh_token');

                                let tokenCompleto = accessToken;
                                if (tokenType) tokenCompleto += `&token_type=${tokenType}`;
                                if (expiresIn) tokenCompleto += `&expires_in=${expiresIn}`;
                                if (refreshToken) tokenCompleto += `&refresh_token=${refreshToken}`;

                                tokenDoHistorico = tokenCompleto;
                                console.log('[Extensão] Token encontrado em aba aberta!');
                                break;
                            }
                        }
                    }
                } catch (tabsError) {
                    console.warn('[Extensão] chrome.tabs não disponível:', tabsError);
                }
            }
        } catch (error) {
            console.warn('[Extensão] Erro geral ao tentar capturar token:', error);
        }

        if (tokenDoHistorico) {
            // ⚠️ SEGURANÇA: Não armazenar token no client-side
            // Apenas enviar para o backend que salvará no banco
            await atualizarPatToken(tokenDoHistorico);
            mostrarToast('Token PAT encontrado no histórico do navegador (últimos 30 min)!', 'success', 3000);
            return tokenDoHistorico;
        }

        try {
            if (window.location.href.includes('atendimento.inss.gov.br')) {
                const urlAtual = window.location.href;
                if (urlAtual.includes('access_token=')) {
                    const urlObj = new URL(urlAtual);
                    const hash = urlObj.hash || '';
                    const searchParams = new URLSearchParams(hash.substring(1) + urlObj.search.substring(1));

                    const accessToken = searchParams.get('access_token');
                    if (accessToken && accessToken.startsWith('AT-')) {
                        const tokenType = searchParams.get('token_type') || 'bearer';
                        const expiresIn = searchParams.get('expires_in') || '1800';
                        const refreshToken = searchParams.get('refresh_token');

                        let tokenCompleto = accessToken;
                        if (tokenType) tokenCompleto += `&token_type=${tokenType}`;
                        if (expiresIn) tokenCompleto += `&expires_in=${expiresIn}`;
                        if (refreshToken) tokenCompleto += `&refresh_token=${refreshToken}`;

                        // ⚠️ SEGURANÇA: Não armazenar token no client-side
                        // Apenas enviar para o backend que salvará no banco
                        await atualizarPatToken(tokenCompleto);
                        mostrarToast('Token PAT capturado da sessão atual!', 'success', 3000);
                        return tokenCompleto;
                    }
                }
            }
        } catch (error) {
            console.warn('[Extensão] Erro ao verificar sessão atual:', error);
        }

        console.log('[Extensão] Token PAT não encontrado automaticamente, usando fallback manual...');

        const usuarioConfirmou = await mostrarConfirmacao(
            'Token PAT não encontrado automaticamente',
            'O sistema tentou capturar o token PAT automaticamente do histórico do navegador, mas não encontrou.\n\n' +
            'FALLBACK MANUAL:\n' +
            'Se você já está logado no PAT em outra aba, copie a URL dessa aba.\n' +
            'Ou abra uma nova aba e faça login no PAT.\n\n' +
            'INSTRUÇÕES:\n' +
            '1. Na aba do PAT (já logado ou após login)\n' +
            '2. Pressione Ctrl+L (ou clique na barra de endereço)\n' +
            '3. Pressione Ctrl+C para copiar a URL completa\n' +
            '4. Cole a URL quando solicitado\n\n' +
            'O token será extraído e salvo por 2 horas.',
            { textoConfirmar: 'Abrir/Colar URL', textoCancelar: 'Cancelar', tipo: 'warning' }
        );

        if (!usuarioConfirmou) {
            throw new Error('Login cancelado pelo usuário');
        }

        const jaLogado = await mostrarConfirmacao(
            'Você já está logado?',
            'Você já está logado no PAT em outra aba?\n\n' +
            '• SIM: Cole a URL da aba onde você já está logado\n' +
            '• NÃO: Abra uma nova aba e faça login',
            { textoConfirmar: 'Já estou logado', textoCancelar: 'Abrir nova aba', tipo: 'info' }
        );

        let patWindow = null;
        if (jaLogado) {
            mostrarToast('Cole a URL da aba onde você já está logado no PAT.', 'info', 5000);
        } else {
            patWindow = window.open(PAT_URL, '_blank', 'width=1200,height=800');
            if (!patWindow) {
                mostrarToast('Não foi possível abrir a janela do PAT. Verifique se os pop-ups estão bloqueados.', 'error');
                throw new Error('Não foi possível abrir a janela do PAT. Verifique se os pop-ups estão bloqueados.');
            }

            // Criar modal de monitoramento com botão manual
            const modalMonitoramento = document.createElement('div');
            modalMonitoramento.id = 'extensao-pat-monitor-modal';
            modalMonitoramento.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.7);
                z-index: 10005;
                display: flex;
                align-items: center;
                justify-content: center;
            `;

            const content = document.createElement('div');
            content.style.cssText = `
                background: white;
                padding: 32px;
                border-radius: 8px;
                max-width: 500px;
                width: 90%;
                box-shadow: 0 4px 16px rgba(0,0,0,0.2);
                font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
            `;

            content.innerHTML = `
                <h3 style="margin: 0 0 16px 0; color: #333; font-size: 18px; font-weight: 600; text-align: center;">
                    Aguardando Login no PAT
                </h3>
                <p style="margin: 0 0 20px 0; color: #666; font-size: 14px; text-align: center; line-height: 1.5;">
                    Faça login na aba que foi aberta.<br>
                    O token será capturado <strong>automaticamente</strong>!
                </p>
                <div style="margin-bottom: 20px;">
                    <div style="background: #f3f4f6; border-radius: 8px; height: 8px; overflow: hidden;">
                        <div id="extensao-progress-bar" style="background: linear-gradient(90deg, #428bca, #3071a9); height: 100%; width: 0%; transition: width 0.3s;"></div>
                    </div>
                    <p id="extensao-progress-text" style="margin: 8px 0 0 0; color: #666; font-size: 13px; text-align: center;">
                        Tentativa 0/40 - 120s restantes
                    </p>
                </div>
                <div style="display: flex; gap: 12px; justify-content: center;">
                    <button id="extensao-btn-manual" style="
                        padding: 10px 20px;
                        background: #428bca;
                        color: #333;
                        border: none;
                        border-radius: 6px;
                        cursor: pointer;
                        font-size: 14px;
                        font-weight: 500;
                        font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
                        transition: background 0.2s;
                    " onmouseover="this.style.background='#3071a9'" onmouseout="this.style.background='#428bca'">
                        📝 Informar Manualmente
                    </button>
                    <button id="extensao-btn-cancelar" style="
                        padding: 10px 20px;
                        background: #fff;
                        color: #666;
                        border: 1px solid #ddd;
                        border-radius: 6px;
                        cursor: pointer;
                        font-size: 14px;
                        font-weight: 500;
                        font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
                        transition: all 0.2s;
                    " onmouseover="this.style.borderColor='#999'; this.style.color='#333'" onmouseout="this.style.borderColor='#ddd'; this.style.color='#666'">
                        Cancelar
                    </button>
                </div>
            `;

            modalMonitoramento.appendChild(content);
            document.body.appendChild(modalMonitoramento);

            const progressBar = document.getElementById('extensao-progress-bar');
            const progressText = document.getElementById('extensao-progress-text');
            const btnManual = document.getElementById('extensao-btn-manual');
            const btnCancelar = document.getElementById('extensao-btn-cancelar');

            // Aguardar até 120 segundos monitorando o histórico a cada 3 segundos
            let tokenCapturado = null;
            let tentativas = 0;
            const maxTentativas = 40; // 40 x 3s = 120s
            let cancelado = false;
            let informarManual = false;

            // Handlers dos botões
            btnManual.addEventListener('click', () => {
                informarManual = true;
            });

            btnCancelar.addEventListener('click', () => {
                cancelado = true;
            });

            while (tentativas < maxTentativas && !tokenCapturado && !cancelado && !informarManual) {
                await new Promise(resolve => setTimeout(resolve, 3000));

                // Tentar capturar token do histórico
                try {
                    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
                        const response = await new Promise((resolve, reject) => {
                            chrome.runtime.sendMessage({ action: 'buscarTokenPat' }, (response) => {
                                if (chrome.runtime.lastError) {
                                    reject(chrome.runtime.lastError);
                                } else {
                                    resolve(response);
                                }
                            });
                        });

                        if (response && response.token) {
                            tokenCapturado = response.token;
                            break;
                        }
                    }
                } catch (error) {
                    console.warn('[Extensão] Tentativa de captura falhou, tentando novamente...');
                }

                tentativas++;

                // Atualizar UI
                const progresso = (tentativas / maxTentativas) * 100;
                const segundosRestantes = (maxTentativas - tentativas) * 3;
                if (progressBar) progressBar.style.width = `${progresso}%`;
                if (progressText) progressText.textContent = `Tentativa ${tentativas}/${maxTentativas} - ${segundosRestantes}s restantes`;
            }

            // Remover modal
            if (document.body.contains(modalMonitoramento)) {
                document.body.removeChild(modalMonitoramento);
            }

            if (cancelado) {
                if (patWindow && !patWindow.closed) {
                    patWindow.close();
                }
                throw new Error('Login cancelado pelo usuário');
            }

            if (tokenCapturado) {
                if (patWindow && !patWindow.closed) {
                    patWindow.close();
                }
                // ⚠️ SEGURANÇA: Não armazenar token no client-side
                // Apenas enviar para o backend que salvará no banco
                await atualizarPatToken(tokenCapturado);
                mostrarToast('Token PAT capturado automaticamente!', 'success', 5000);
                return tokenCapturado;
            }

            // Se não capturou ou usuário pediu manual, continuar para entrada manual
            if (!informarManual) {
                mostrarToast('Token não detectado automaticamente. Use a opção manual.', 'warning', 5000);
            }
        }

        const urlColada = await mostrarInput(
            'Cole a URL do PAT',
            '1. Na aba do PAT (já logado ou após login)\n' +
            '2. Pressione Ctrl+L (ou clique na barra de endereço)\n' +
            '3. Pressione Ctrl+C para copiar\n' +
            '4. Cole a URL abaixo\n\n' +
            'A URL deve conter "access_token=AT-..." na barra de endereço.',
            '',
            {
                placeholder: 'https://atendimento.inss.gov.br/...?access_token=AT-...',
                tipo: 'text',
                validacao: (valor) => {
                    if (!valor || valor.trim() === '') {
                        return 'URL é obrigatória';
                    }
                    if (!valor.includes('atendimento.inss.gov.br')) {
                        return 'URL deve ser do PAT (atendimento.inss.gov.br)';
                    }
                    return null;
                }
            }
        );

        if (patWindow && !patWindow.closed) {
            patWindow.close();
        }

        if (!urlColada || urlColada.trim() === '') {
            throw new Error('URL não fornecida. Por favor, copie a URL completa do PAT após fazer login.');
        }

        let match = urlColada.match(/[#&?]access_token=([^&]+)/);
        if (!match) {
            match = urlColada.match(/access_token[=:]([A-Z0-9-]+)/i);
        }
        if (!match) {
            match = urlColada.match(/token[=:]([A-Z0-9-]+)/i);
        }
        if (!match) {
            const tokens = urlColada.match(/AT-[A-Z0-9-]+/gi);
            if (tokens && tokens.length > 0) {
                match = [null, tokens[0]];
            }
        }

        if (match && match[1]) {
            let token = match[1].trim();
            if (!token.startsWith('AT-')) {
                const tokenCompleto = urlColada.match(/AT-[A-Z0-9-]+/i);
                if (tokenCompleto) {
                    token = tokenCompleto[0];
                } else {
                    throw new Error('Token PAT inválido. A URL deve conter um token que comece com "AT-".');
                }
            }

            const urlObj = new URL(urlColada);
            const hash = urlObj.hash || '';
            const searchParams = new URLSearchParams(hash.substring(1) + urlObj.search.substring(1));

            const accessToken = searchParams.get('access_token') || token;
            const tokenType = searchParams.get('token_type') || 'bearer';
            const expiresIn = searchParams.get('expires_in') || '1800';
            const refreshToken = searchParams.get('refresh_token');

            let tokenCompleto = accessToken;
            if (tokenType) tokenCompleto += `&token_type=${tokenType}`;
            if (expiresIn) tokenCompleto += `&expires_in=${expiresIn}`;
            if (refreshToken) tokenCompleto += `&refresh_token=${refreshToken}`;

            // ⚠️ SEGURANÇA: Não armazenar token no client-side
            // Apenas enviar para o backend que salvará no banco
            await atualizarPatToken(tokenCompleto);
            mostrarToast('Token PAT capturado com sucesso! Válido por 2 horas.', 'success', 6000);
            return tokenCompleto;
        } else {
            mostrarToast('Token não encontrado na URL. Verifique se fez login e copiou a URL completa.', 'error', 8000);
            throw new Error('Token não encontrado na URL fornecida. Certifique-se de que fez login no PAT completamente e copiou a URL COMPLETA da barra de endereço.');
        }
    }

    /**
     * Exibe modal para configurar URL da API antes do login
     * Aparece quando não há URL configurada ou quando a URL não está acessível
     */
    async function exibirModalConfigurarApiUrl() {
        return new Promise((resolve) => {
            // Fechar todos os modais antes de abrir este
            fecharTodosModais();

            const modal = document.createElement('div');
            modal.id = 'extensao-api-url-modal';
            modal.className = 'extensao-modal';

            const content = document.createElement('div');
            content.id = 'extensao-api-url-content';
            content.className = 'extensao-modal-content';

            // Obter URL atual (se houver)
            getStorage(STORAGE_KEYS.API_URL).then(urlAtual => {
                const url = urlAtual || API_BASE_URL || DEFAULT_API_URL;

                content.innerHTML = `
                    <h2 class="extensao-title">⚙️ Configurar URL da API</h2>
                    <p style="margin: 0 0 20px 0; color: var(--text-muted); font-size: 14px; line-height: 1.5;">
                        Antes de fazer login, é necessário configurar a URL do backend. 
                        Esta URL será usada para todas as comunicações com o servidor.
                    </p>
                    <form id="extensao-api-url-form" style="display: flex; flex-direction: column; gap: 20px;">
                        <div class="extensao-field-group">
                            <label for="extensao-api-url-input" class="extensao-label-text">
                                URL da API do Backend
                            </label>
                            <input 
                                type="text" 
                                id="extensao-api-url-input" 
                                placeholder="http://localhost:3000/api/v1 ou https://seu-dominio.com/api/v1"
                                value="${url}"
                                autocomplete="off"
                                required
                                class="extensao-input-modern"
                                style="font-family: monospace;"
                            >
                            <small style="color: var(--text-muted); font-size: 12px; display: block; margin-top: 6px;">
                                Exemplo: <code style="background: #f3f4f6; padding: 2px 4px; border-radius: 3px;">https://api.seudominio.com/api/v1</code> ou <code style="background: #f3f4f6; padding: 2px 4px; border-radius: 3px;">http://localhost:3000/api/v1</code>
                            </small>
                        </div>
                            <button 
                                type="submit" 
                            class="extensao-btn-primary"
                            >
                                Salvar e Continuar
                            </button>
                    </form>
                    <div id="extensao-api-url-error" style="
                        color: #991B1B;
                        margin-top: 16px;
                        padding: 12px;
                        background: #FEE2E2;
                        border-radius: 6px;
                        font-size: 13px;
                        display: none;
                    "></div>
                    <div id="extensao-api-url-success" style="
                        color: #166534;
                        margin-top: 16px;
                        padding: 12px;
                        background: #DCFCE7;
                        border-radius: 6px;
                        font-size: 13px;
                        display: none;
                    "></div>
                `;

                setTimeout(() => {
                    const form = document.getElementById('extensao-api-url-form');
                    const errorDiv = document.getElementById('extensao-api-url-error');
                    const successDiv = document.getElementById('extensao-api-url-success');

                    if (!form) {
                        console.error('[Extensão] Formulário de URL da API não encontrado');
                        return;
                    }

                    form.addEventListener('submit', async (e) => {
                        e.preventDefault();
                        if (errorDiv) errorDiv.style.display = 'none';
                        if (successDiv) successDiv.style.display = 'none';

                        const input = document.getElementById('extensao-api-url-input');
                        if (!input) {
                            if (errorDiv) {
                                errorDiv.textContent = 'Erro: Campo não encontrado';
                                errorDiv.style.display = 'block';
                            }
                            return;
                        }

                        let novaUrl = input.value.trim();

                        // Validar formato básico
                        if (!novaUrl.startsWith('http://') && !novaUrl.startsWith('https://')) {
                            if (errorDiv) {
                                errorDiv.textContent = 'URL inválida. Deve começar com http:// ou https://';
                                errorDiv.style.display = 'block';
                            }
                            return;
                        }

                        // Normalizar URL - remover barra final
                        if (novaUrl.endsWith('/')) {
                            novaUrl = novaUrl.slice(0, -1);
                        }

                        // Se não termina com /api/v1, adicionar
                        if (!novaUrl.endsWith('/api/v1')) {
                            if (novaUrl.endsWith('/api')) {
                                novaUrl += '/v1';
                            } else {
                                novaUrl += '/api/v1';
                            }
                        }

                        // Verificar se está acessível
                        if (errorDiv) {
                            errorDiv.textContent = 'Verificando se a URL está acessível...';
                            errorDiv.style.display = 'block';
                            errorDiv.style.color = '#6b7280';
                            errorDiv.style.background = '#f9fafb';
                        }

                        try {
                            // Aumentar timeout para URLs do Cloudflare (podem ser mais lentas)
                            const timeout = novaUrl.includes('trycloudflare.com') ? 10000 : 5000;
                            const acessivel = await verificarUrlAcessivel(novaUrl, timeout);

                            if (acessivel) {
                                // Salvar URL
                                await setStorage(STORAGE_KEYS.API_URL, novaUrl);
                                API_BASE_URL = novaUrl; // Atualizar variável global

                                if (successDiv) {
                                    successDiv.textContent = 'URL configurada com sucesso!';
                                    successDiv.style.display = 'block';
                                }
                                if (errorDiv) errorDiv.style.display = 'none';

                                // Fechar modal e continuar
                                setTimeout(() => {
                                    if (document.body.contains(modal)) {
                                        document.body.removeChild(modal);
                                    }
                                    resolve(true);
                                }, 1000);
                            } else {
                                // Se não está acessível, perguntar se quer salvar mesmo assim
                                if (errorDiv) {
                                    errorDiv.innerHTML = `
                                        <div style="margin-bottom: 12px;">
                                            URL não está acessível no momento (timeout ou erro de conexão).
                                        </div>
                                        <div style="margin-bottom: 12px; font-size: 12px; color: #6b7280;">
                                            Isso pode acontecer se o servidor estiver lento ou temporariamente indisponível.
                                            Você pode salvar mesmo assim e tentar usar depois.
                                        </div>
                                        <div class="extensao-flex-row">
                                            <button 
                                                type="button" 
                                                id="extensao-api-url-salvar-mesmo-assim"
                                                class="extensao-btn-primary"
                                                style="background: #F59E0B; color: white;"
                                            >
                                                Salvar Mesmo Assim
                                            </button>
                                            <button 
                                                type="button" 
                                                id="extensao-api-url-tentar-novamente"
                                                class="extensao-btn-secondary"
                                            >
                                                Tentar Novamente
                                            </button>
                                        </div>
                                    `;
                                    errorDiv.style.display = 'block';
                                    errorDiv.style.color = '#92400e';
                                    errorDiv.style.background = '#fef3c7';

                                    // Botão "Salvar Mesmo Assim"
                                    const salvarBtn = document.getElementById('extensao-api-url-salvar-mesmo-assim');
                                    if (salvarBtn) {
                                        salvarBtn.addEventListener('click', async () => {
                                            await setStorage(STORAGE_KEYS.API_URL, novaUrl);
                                            API_BASE_URL = novaUrl;

                                            if (successDiv) {
                                                successDiv.textContent = 'URL salva (não verificada). Você pode testar depois.';
                                                successDiv.style.display = 'block';
                                            }
                                            if (errorDiv) errorDiv.style.display = 'none';

                                            setTimeout(() => {
                                                if (document.body.contains(modal)) {
                                                    document.body.removeChild(modal);
                                                }
                                                resolve(true);
                                            }, 1500);
                                        });
                                    }

                                    // Botão "Tentar Novamente"
                                    const tentarBtn = document.getElementById('extensao-api-url-tentar-novamente');
                                    if (tentarBtn) {
                                        tentarBtn.addEventListener('click', async () => {
                                            if (errorDiv) {
                                                errorDiv.textContent = 'Verificando novamente...';
                                                errorDiv.style.color = '#6b7280';
                                                errorDiv.style.background = '#f9fafb';
                                                errorDiv.innerHTML = '';
                                            }

                                            // Tentar novamente com timeout maior
                                            const acessivelNovamente = await verificarUrlAcessivel(novaUrl, 10000);
                                            if (acessivelNovamente) {
                                                await setStorage(STORAGE_KEYS.API_URL, novaUrl);
                                                API_BASE_URL = novaUrl;

                                                if (successDiv) {
                                                    successDiv.textContent = 'URL configurada com sucesso!';
                                                    successDiv.style.display = 'block';
                                                }
                                                if (errorDiv) errorDiv.style.display = 'none';

                                                setTimeout(() => {
                                                    if (document.body.contains(modal)) {
                                                        document.body.removeChild(modal);
                                                    }
                                                    resolve(true);
                                                }, 1000);
                                            } else {
                                                // Mostrar opção de salvar mesmo assim novamente
                                                if (errorDiv) {
                                                    errorDiv.innerHTML = `
                                                        <div style="margin-bottom: 12px;">
                                                            Ainda não está acessível após nova tentativa.
                                                        </div>
                                                        <button 
                                                            type="button" 
                                                            id="extensao-api-url-salvar-final"
                                                            class="extensao-btn-primary"
                                                            style="background: #F59E0B; color: white;"
                                                        >
                                                            Salvar Mesmo Assim
                                                        </button>
                                                    `;
                                                    errorDiv.style.color = '#92400e';
                                                    errorDiv.style.background = '#fef3c7';

                                                    const salvarFinalBtn = document.getElementById('extensao-api-url-salvar-final');
                                                    if (salvarFinalBtn) {
                                                        salvarFinalBtn.addEventListener('click', async () => {
                                                            await setStorage(STORAGE_KEYS.API_URL, novaUrl);
                                                            API_BASE_URL = novaUrl;

                                                            if (successDiv) {
                                                                successDiv.textContent = 'URL salva. Você pode testar depois.';
                                                                successDiv.style.display = 'block';
                                                            }
                                                            if (errorDiv) errorDiv.style.display = 'none';

                                                            setTimeout(() => {
                                                                if (document.body.contains(modal)) {
                                                                    document.body.removeChild(modal);
                                                                }
                                                                resolve(true);
                                                            }, 1500);
                                                        });
                                                    }
                                                }
                                            }
                                        });
                                    }
                                }
                            }
                        } catch (error) {
                            console.error('[Extensão] Erro ao verificar URL:', error);
                            if (errorDiv) {
                                errorDiv.textContent = `Erro ao verificar URL: ${error.message || 'Erro desconhecido'}`;
                                errorDiv.style.display = 'block';
                                errorDiv.style.color = '#df1b41';
                                errorDiv.style.background = '#ffe3e3';
                            }
                        }
                    });

                    modal.addEventListener('click', (e) => {
                        if (e.target === modal) {
                            // Não permitir fechar clicando fora - é obrigatório configurar
                            mostrarToast('É necessário configurar a URL da API antes de continuar.', 'error', 3000);
                        }
                    });
                }, 10);
            });

            modal.appendChild(content);
            document.body.appendChild(modal);
        });
    }

    function exibirModalLogin() {
        return new Promise((resolve) => {
            // Fechar todos os modais antes de abrir este
            fecharTodosModais();

            const modal = document.createElement('div');
            modal.id = 'extensao-login-modal';
            modal.className = 'extensao-modal';

            const content = document.createElement('div');
            content.id = 'extensao-login-content';
            content.className = 'extensao-modal-content';

            let isLogin = true;

            function atualizarFormulario() {
                content.innerHTML = `
                    <h2 class="extensao-title">${isLogin ? 'Login' : 'Registro'}</h2>
                    <form id="extensao-auth-form" style="display: flex; flex-direction: column; gap: 16px;">
                        ${!isLogin ? `
                            <div class="extensao-field-group">
                                <label class="extensao-label-text">Nome completo</label>
                                <input 
                                    type="text" 
                                    id="extensao-nome" 
                                    placeholder="Digite seu nome completo" 
                                    required 
                                    autocomplete="name"
                                    class="extensao-input-modern"
                                >
                            </div>
                        ` : ''}
                        <div class="extensao-field-group">
                            <label class="extensao-label-text">Email</label>
                            <input 
                                type="email" 
                                id="extensao-email" 
                                placeholder="seu@email.com" 
                                required 
                                autocomplete="email"
                                class="extensao-input-modern"
                            >
                        </div>
                        <div class="extensao-field-group">
                            <label class="extensao-label-text">Senha</label>
                            <input 
                                type="password" 
                                id="extensao-password" 
                                placeholder="Digite sua senha" 
                                required 
                                autocomplete="${isLogin ? 'current-password' : 'new-password'}"
                                class="extensao-input-modern"
                            >
                        </div>
                        <button 
                            type="submit" 
                            class="extensao-btn-primary"
                        >
                            ${isLogin ? 'Entrar' : 'Registrar'}
                        </button>
                        <button 
                            type="button" 
                            id="extensao-toggle-form" 
                            style="
                                padding: 8px;
                                background: transparent;
                                border: none;
                                color: var(--text-muted);
                                cursor: pointer;
                                text-decoration: underline;
                                font-size: 14px;
                            "
                        >
                            ${isLogin ? 'Não tem conta? Registrar' : 'Já tem conta? Fazer login'}
                        </button>
                    </form>
                    <div id="extensao-auth-error" class="extensao-feedback-error" style="margin-top: 12px; display: none;"></div>
                `;

                setTimeout(() => {
                    const form = document.getElementById('extensao-auth-form');
                    const toggleBtn = document.getElementById('extensao-toggle-form');
                    const errorDiv = document.getElementById('extensao-auth-error');

                    if (!form || !toggleBtn || !errorDiv) {
                        console.error('[Extensão] Elementos do formulário não encontrados');
                        return;
                    }

                    form.addEventListener('submit', async (e) => {
                        e.preventDefault();
                        if (errorDiv) errorDiv.style.display = 'none';

                        // Verificar se URL da API está configurada antes de fazer login
                        try {
                            await verificarEConfigurarApiUrl();
                        } catch (error) {
                            if (errorDiv) {
                                errorDiv.textContent = 'Erro: ' + error.message;
                                errorDiv.style.display = 'block';
                            }
                            return;
                        }

                        const emailEl = document.getElementById('extensao-email');
                        const passwordEl = document.getElementById('extensao-password');
                        const nomeEl = document.getElementById('extensao-nome');

                        if (!emailEl || !passwordEl) {
                            if (errorDiv) {
                                errorDiv.textContent = 'Erro: Campos não encontrados';
                                errorDiv.style.display = 'block';
                            }
                            return;
                        }

                        const email = emailEl.value;
                        const password = passwordEl.value;
                        const nome = !isLogin && nomeEl ? nomeEl.value : null;

                        try {
                            if (isLogin) {
                                const response = await fazerRequisicao(`${API_BASE_URL}/extensao/login`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ email, password })
                                });

                                const data = await response.json();

                                if (data.success) {
                                    await salvarTokenAuth(data.token);
                                    await salvarUsuarioCacheado(data.user);
                                    if (document.body.contains(modal)) {
                                        document.body.removeChild(modal);
                                    }
                                    resolve(true);
                                } else {
                                    if (errorDiv) {
                                        errorDiv.textContent = data.message || 'Erro ao fazer login';
                                        errorDiv.style.display = 'block';
                                    }
                                }
                            } else {
                                if (!nome) {
                                    if (errorDiv) {
                                        errorDiv.textContent = 'Nome é obrigatório';
                                        errorDiv.style.display = 'block';
                                    }
                                    return;
                                }

                                const response = await fazerRequisicao(`${API_BASE_URL}/extensao/register`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ email, password, nome })
                                });

                                const data = await response.json();

                                if (data.success) {
                                    mostrarToast('Registro realizado com sucesso! Faça login agora.', 'success');
                                    isLogin = true;
                                    atualizarFormulario();
                                } else {
                                    if (errorDiv) {
                                        errorDiv.textContent = data.message || 'Erro ao registrar';
                                        errorDiv.style.display = 'block';
                                    }
                                }
                            }
                        } catch (error) {
                            console.error('[Extensão] Erro no formulário:', error);
                            if (errorDiv) {
                                let errorMessage = error.message || 'Erro desconhecido';
                                if (errorMessage.includes('parsear JSON') || errorMessage.includes('HTML ao invés de JSON') || errorMessage.includes('retornou HTML')) {
                                    // Já tem mensagem detalhada
                                } else if (errorMessage.includes('CONNECTION_REFUSED') || errorMessage.includes('refused') || errorMessage.includes('não foi possível conectar') || errorMessage.includes('408') || errorMessage.includes('timeout')) {
                                    errorMessage = 'Não foi possível conectar ao servidor.\n\n' +
                                        'VERIFIQUE:\n' +
                                        '1. Backend está rodando? Execute: cd backend && npm run dev\n' +
                                        '2. URL da API está correta? (atualmente: ' + API_BASE_URL + ')\n' +
                                        '3. Para acesso remoto, configure URL pública (ngrok ou IP)\n' +
                                        '4. Firewall não está bloqueando?\n\n' +
                                        'DICA: Se estiver em outro computador, use ngrok ou configure IP público.';
                                } else if (errorMessage.includes('CORS')) {
                                    errorMessage = 'Erro de CORS. Verifique as configurações do servidor.';
                                } else if (errorMessage.includes('Failed to fetch')) {
                                    errorMessage = 'Falha ao conectar. Verifique se o backend está rodando.';
                                }

                                errorDiv.textContent = `Erro: ${errorMessage}`;
                                errorDiv.style.display = 'block';
                            }
                        }
                    });

                    toggleBtn.addEventListener('click', () => {
                        isLogin = !isLogin;
                        atualizarFormulario();
                    });
                }, 10);
            }

            modal.appendChild(content);
            document.body.appendChild(modal);
            atualizarFormulario();
        });
    }

    // ===== UI HELPERS (SVG ICONS) =====
    const ICONS = {
        check: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
        close: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
        info: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`,
        checkCircle: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>`,
        xCircle: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`,
        loader: `<svg class="extensao-spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`
    };

    // ===== FUNÇÃO: CRIAR CAMPO EDITÁVEL (MODERN UI) =====
    // Substitui a função criarCampoEditavel antiga
    function criarCampoEditavel(config) {
        const { id, label, tipo = 'text', placeholder = '', valorAtual = '', estaConfigurado = false, obrigatorio = false, ajuda = '' } = config;

        // Estado inicial: Configurado (Verde) ou Pendente (Cinza)
        const badgeClass = estaConfigurado ? 'extensao-badge-green' : 'extensao-badge-gray';
        const badgeText = estaConfigurado ? 'Configurado' : 'Não configurado';
        const checkIcon = estaConfigurado ? ' ✓' : '';

        // Tooltip
        const tooltipHtml = ajuda ? `
            <div class="extensao-tooltip-container" style="position: relative; display: inline-flex; cursor: help;" title="${ajuda}">
                <span style="color: #3B82F6;">${ICONS.info}</span>
            </div>
        ` : '';

        // HTML do campo
        return `
            <div class="extensao-field-group" id="group-${id}" data-id="${id}" data-tipo="${tipo}" data-placeholder="${placeholder}">
                <div class="extensao-label-row">
                    <label class="extensao-label-text">
                        ${label}
                        ${obrigatorio ? '<span class="extensao-required-mark">*</span>' : ''}
                    </label>
                    ${tooltipHtml}
                    <span class="extensao-badge ${badgeClass}" id="badge-${id}">
                        ${badgeText}${checkIcon}
                    </span>
                </div>

                <div id="view-${id}" class="extensao-view-mode">
                    <button type="button" class="extensao-btn-action" onclick="window.ativarEdicao('${id}', '${valorAtual}')">
                        Alterar
                    </button>
                </div>

                <div id="edit-${id}" class="extensao-edit-wrapper" style="display: none;">
                    <input 
                        type="${tipo}" 
                        id="input-${id}" 
                        class="extensao-input-modern" 
                        placeholder="${placeholder}"
                        value=""
                    >
                    <div class="extensao-edit-actions">
                        <button type="button" class="extensao-icon-btn extensao-bg-green-soft" onclick="window.salvarEdicaoCampo('${id}')" title="Confirmar">
                            ${ICONS.check}
                        </button>
                        <button type="button" class="extensao-icon-btn extensao-bg-red-soft" onclick="window.cancelarEdicaoCampo('${id}')" title="Cancelar">
                            ${ICONS.close}
                        </button>
                    </div>
                </div>
                <input type="hidden" id="extensao-${id}" value="${estaConfigurado ? '********' : ''}">
            </div>
        `;
    }

    // Funções globais para manipular o estado de edição (necessário pois o HTML é injetado como string)
    window.ativarEdicao = function (id, valorAtual) {
        document.getElementById(`view-${id}`).style.display = 'none';
        const editDiv = document.getElementById(`edit-${id}`);
        editDiv.style.display = 'block';

        const input = document.getElementById(`input-${id}`);
        input.value = ''; // Limpar para segurança ou colocar valorAtual se desejar
        input.focus();

        const badge = document.getElementById(`badge-${id}`);
        badge.className = 'extensao-badge extensao-badge-yellow';
        badge.textContent = 'Editando...';
    };

    window.cancelarEdicaoCampo = function (id) {
        document.getElementById(`view-${id}`).style.display = 'block';
        document.getElementById(`edit-${id}`).style.display = 'none';

        // Restaurar badge original (lógica simplificada, idealmente checaria o estado real)
        const hiddenInput = document.getElementById(`extensao-${id}`);
        const temValor = hiddenInput.value && hiddenInput.value !== '';

        const badge = document.getElementById(`badge-${id}`);
        badge.className = temValor ? 'extensao-badge extensao-badge-green' : 'extensao-badge extensao-badge-gray';
        badge.textContent = temValor ? 'Configurado ✓' : 'Não configurado';
    };

    window.salvarEdicaoCampo = function (id) {
        const inputVal = document.getElementById(`input-${id}`).value;
        const hiddenInput = document.getElementById(`extensao-${id}`);
        hiddenInput.value = inputVal; // Salva no hidden para o submit pegar

        document.getElementById(`view-${id}`).style.display = 'block';
        document.getElementById(`edit-${id}`).style.display = 'none';

        const badge = document.getElementById(`badge-${id}`);
        badge.className = 'extensao-badge extensao-badge-green';
        badge.textContent = 'Salvo ✓'; // Feedback visual imediato
        badge.style.transform = 'scale(1.1)';
        setTimeout(() => badge.style.transform = 'scale(1)', 300);
    };

    // ===== FUNÇÃO: MODAL CONFIGURAÇÕES (MODERN UI) =====
    async function exibirModalConfiguracoes() {
        return new Promise((resolve) => {
            // Fechar todos os modais antes de abrir este
            fecharTodosModais();

            const modal = document.createElement('div');
            modal.className = 'extensao-modal';

            const content = document.createElement('div');
            content.className = 'extensao-modal-content';

            // Não mostrar loading - modal vai aparecer direto com conteúdo
            modal.appendChild(content);
            document.body.appendChild(modal);

            obterConfiguracoes().then(async configs => {
                const urlAtual = await getStorage(STORAGE_KEYS.API_URL) || API_BASE_URL;

                content.innerHTML = `
                    <h2 class="extensao-title">Configurações</h2>
                    
                    <form id="extensao-config-form">
                        ${criarCampoEditavel({
                    id: 'api-url',
                    label: 'URL da API',
                    placeholder: 'http://localhost:3000/api/v1',
                    estaConfigurado: !!urlAtual,
                    valorAtual: urlAtual
                })}
                        
                        ${criarCampoEditavel({
                    id: 'gemini-key',
                    label: 'Gemini API Key',
                    tipo: 'password',
                    placeholder: 'Cole sua chave aqui',
                    estaConfigurado: configs?.temGeminiApiKey,
                    ajuda: 'Necessário para leitura inteligente de documentos'
                })}

                        ${criarCampoEditavel({
                    id: 'tramitacao-token',
                    label: 'Tramitação Token',
                    tipo: 'password',
                    estaConfigurado: configs?.temTramitacaoApiToken,
                    obrigatorio: true,
                    ajuda: 'Token para integração com o sistema Tramitação'
                })}

                        ${criarCampoEditavel({
                    id: 'tramitacao-email',
                    label: 'Email Tramitação',
                    tipo: 'email',
                    estaConfigurado: configs?.temTramitacaoEmail,
                    obrigatorio: true
                })}

                        ${criarCampoEditavel({
                    id: 'tramitacao-senha',
                    label: 'Senha Tramitação',
                    tipo: 'password',
                    estaConfigurado: configs?.temTramitacaoSenha,
                    obrigatorio: true
                })}

                        <button type="button" id="btn-config-whatsapp" class="extensao-btn-action" style="background-color: #FEF3C7; border-color: #FCD34D; color: #92400E; margin-top: 10px; font-weight: 600;">
                            Configurar WhatsApp
                        </button>

                        <div class="extensao-flex-row">
                            <button type="submit" class="extensao-btn-primary">
                                Salvar Configurações
                            </button>
                            <button type="button" id="btn-cancelar" class="extensao-btn-secondary">
                                Cancelar
                            </button>
                        </div>
                    </form>
                    <div id="config-feedback" style="margin-top: 16px; display: none; padding: 10px; border-radius: 6px; text-align: center; font-size: 13px;"></div>
                `;

                // Handlers
                document.getElementById('btn-config-whatsapp').onclick = async () => {
                    // Fechar modal de configurações antes de abrir o de WhatsApp
                    fecharTodosModais();
                    await exibirModalConfiguracaoWhatsApp();
                };

                document.getElementById('btn-cancelar').onclick = () => {
                    modal.remove();
                    resolve(false);
                };

                document.getElementById('extensao-config-form').onsubmit = async (e) => {
                    e.preventDefault();
                    const feedback = document.getElementById('config-feedback');
                    feedback.style.display = 'none';

                    // Coletar dados dos inputs HIDDEN (onde o salvarEdicaoCampo guardou)
                    // Nota: Se o campo não foi editado, o valor será '********' ou vazio.
                    // O backend deve ignorar se não enviar ou enviar vazio.

                    const dados = {
                        geminiApiKey: document.getElementById('extensao-gemini-key').value,
                        tramitacaoApiToken: document.getElementById('extensao-tramitacao-token').value,
                        tramitacaoEmail: document.getElementById('extensao-tramitacao-email').value,
                        tramitacaoSenha: document.getElementById('extensao-tramitacao-senha').value
                    };

                    // Limpar campos mascara
                    Object.keys(dados).forEach(key => {
                        if (dados[key] === '********' || dados[key] === '') delete dados[key];
                    });

                    // Lógica de salvamento da URL da API (separado)
                    const novaUrl = document.getElementById('extensao-api-url').value;
                    if (novaUrl && novaUrl !== '********') {
                        await setStorage(STORAGE_KEYS.API_URL, novaUrl);
                        API_BASE_URL = novaUrl;
                    }

                    try {
                        const token = await obterTokenAuth();
                        // Enviar apenas se houver dados para atualizar
                        if (Object.keys(dados).length > 0) {
                            await fazerRequisicao(`${API_BASE_URL}/extensao/config`, {
                                method: 'PUT',
                                headers: { 'Authorization': `Bearer ${token}` },
                                body: JSON.stringify(dados)
                            });
                        }

                        feedback.style.display = 'block';
                        feedback.style.background = '#DCFCE7';
                        feedback.style.color = '#166534';
                        feedback.textContent = 'Configurações salvas com sucesso!';

                        setTimeout(() => {
                            modal.remove();
                            resolve(true);
                        }, 1500);
                    } catch (err) {
                        feedback.style.display = 'block';
                        feedback.style.background = '#FEE2E2';
                        feedback.style.color = '#991B1B';
                        feedback.textContent = 'Erro ao salvar: ' + err.message;
                    }
                };
            });
        });
    }

    // ===== FUNÇÃO: MODAL WHATSAPP (MODERN UI) =====
    async function exibirModalConfiguracaoWhatsApp() {
        return new Promise((resolve) => {
            // Fechar todos os modais antes de abrir este
            fecharTodosModais();

            const modal = document.createElement('div');
            modal.id = 'extensao-whatsapp-modal';
            modal.className = 'extensao-modal';

            const content = document.createElement('div');
            content.id = 'extensao-whatsapp-content';
            content.className = 'extensao-modal-content';

            // Buscar configurações atuais e status do WhatsApp
            obterTokenAuth().then(async token => {
                if (!token) {
                    mostrarToast('É necessário fazer login primeiro', 'error');
                    resolve(false);
                    return;
                }

                try {
                    // Buscar configurações de WhatsApp (inclui flag isAdmin do backend)
                    const whatsappData = await obterConfiguracoesWhatsApp();

                    // ⚠️ SEGURANÇA: isAdmin vem exclusivamente do backend
                    const isAdmin = whatsappData?.isAdmin === true;
                    const configs = whatsappData?.config || {};

                    // Se for admin (validado pelo backend), buscar status de conexão
                    let statusData = null;
                    if (isAdmin) {
                        try {
                            const r = await fazerRequisicao(`${API_BASE_URL}/extensao/whatsapp/status`, {
                                headers: { 'Authorization': `Bearer ${token}` }
                            });
                            statusData = await r.json();
                        } catch (e) {
                            statusData = { status: { isReady: false, numeroConectado: null } };
                        }
                    }

                    // Dados do status (apenas se admin - validado pelo backend)
                    const isConnected = statusData?.status?.isReady || false;
                    const isConnecting = statusData?.status?.isConnecting || false;
                    const numeroConectado = statusData?.status?.numeroConectado || null;
                    const temSessaoSalva = statusData?.status?.temSessaoSalva || false;
                    const lastReadyAt = statusData?.status?.lastReadyAt || null;
                    const sessionStartedAt = statusData?.status?.sessionStartedAt || null;

                    // Formatar data do último login para exibição
                    const formatarDataLogin = (isoString) => {
                        if (!isoString) return null;
                        try {
                            const data = new Date(isoString);
                            return data.toLocaleString('pt-BR', {
                                day: '2-digit',
                                month: '2-digit',
                                year: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit'
                            });
                        } catch (e) {
                            return null;
                        }
                    };
                    const ultimoLoginFormatado = formatarDataLogin(lastReadyAt);
                    const sessaoInicioFormatado = formatarDataLogin(sessionStartedAt);

                    // Configurações do usuário
                    const ativo = configs?.ativo || false;
                    const numeroUnico = configs?.numeroUnico || '';
                    const exigencia = configs?.exigencia || '';
                    const deferido = configs?.deferido || '';
                    const indeferido = configs?.indeferido || '';
                    const emAnalise = configs?.emAnalise || '';
                    const agendamento = configs?.agendamento || '';

                    // Determinar se tem número principal configurado
                    const temNumeroPrincipal = !!(numeroUnico || exigencia || deferido || indeferido || emAnalise || agendamento);
                    // Se tem número único, usa ele; senão verifica se tem algum número individual
                    const usarMesmoNumero = !!numeroUnico;

                    content.innerHTML = `
                    <h2 class="extensao-title" style="margin-bottom: 12px; font-size: 18px;">Configurações de Notificações WhatsApp</h2>

                    <div style="margin-bottom: 12px; padding: 10px; background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 6px; color: #475569; font-size: 12px; line-height: 1.5;">
                        O sistema enviará notificações automáticas via WhatsApp quando houver mudanças no status dos processos. Configure abaixo os números que receberão as mensagens para cada tipo de atualização.
                    </div>

                    ${isAdmin ? `
                    <div style="margin: 12px 0; border-top: 1px solid #E5E7EB; padding-top: 12px;">
                        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;">
                            <h3 style="margin: 0; color: var(--text-main); font-size: 14px; font-weight: 600;">
                                Conexão WhatsApp
                            </h3>
                            <button 
                                type="button" 
                                id="extensao-whatsapp-desconectar"
                                style="
                                    padding: 6px 12px;
                                    font-size: 11px;
                                    background: ${isConnected ? '#FEE2E2' : '#F3F4F6'};
                                    color: ${isConnected ? '#991B1B' : '#6B7280'};
                                    border: 1px solid ${isConnected ? '#FECACA' : '#E5E7EB'};
                                    border-radius: 6px;
                                    cursor: pointer;
                                    font-weight: 500;
                                "
                                title="Reiniciar conexão WhatsApp"
                            >
                                Reiniciar WhatsApp
                            </button>
                        </div>
                        
                        <!-- Status simplificado -->
                        ${isConnected ? `
                        <div style="padding: 12px; background: #DCFCE7; border-radius: 8px; border-left: 4px solid #10B981;">
                            <div style="display: flex; align-items: center; gap: 10px;">
                                <div style="color: #166534;">${ICONS.checkCircle}</div>
                                <div style="flex: 1;">
                                    <div style="font-size: 13px; font-weight: 600; color: #166534;">WhatsApp Conectado</div>
                                    ${numeroConectado ? `<div style="font-size: 11px; color: #6B7280; margin-top: 2px;">Número: ${numeroConectado}</div>` : ''}
                                </div>
                            </div>
                            ${ultimoLoginFormatado ? `
                            <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid #86EFAC;">
                                <div style="display: flex; flex-wrap: wrap; gap: 12px; font-size: 11px; color: #6B7280;">
                                    <div><span style="font-weight: 500;">Última autenticação:</span> ${ultimoLoginFormatado}</div>
                                    ${sessaoInicioFormatado ? `<div><span style="font-weight: 500;">Sessão iniciada:</span> ${sessaoInicioFormatado}</div>` : ''}
                                </div>
                            </div>
                            ` : ''}
                        </div>
                        ` : `
                        <div style="padding: 12px; background: #FEF3C7; border-radius: 8px; border-left: 4px solid #F59E0B;">
                            <div style="display: flex; align-items: center; gap: 10px;">
                                <div style="color: #92400E;">
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <circle cx="12" cy="12" r="10"/>
                                        <line x1="12" y1="8" x2="12" y2="12"/>
                                        <line x1="12" y1="16" x2="12.01" y2="16"/>
                                    </svg>
                                </div>
                                <div style="flex: 1;">
                                    <div style="font-size: 13px; font-weight: 600; color: #92400E;">WhatsApp Desconectado</div>
                                    <div style="font-size: 11px; color: #78716C; margin-top: 2px;">Clique em "Reiniciar WhatsApp" para conectar</div>
                                </div>
                            </div>
                        </div>
                        `}
                        
                        <!-- QR Code Container (aparece quando clica em Conectar) -->
                        <div id="extensao-whatsapp-qr-container" style="display: none; margin-top: 12px; text-align: center;">
                            <div style="margin-bottom: 8px; color: var(--text-main); font-size: 12px; font-weight: 500;">
                                Escaneie o QR Code com o WhatsApp:
                            </div>
                            <div id="extensao-whatsapp-qr-code" style="
                                display: inline-block;
                                padding: 12px;
                                background: white;
                                border: 2px solid #E5E7EB;
                                border-radius: 8px;
                                margin-bottom: 8px;
                            "></div>
                            <div id="extensao-whatsapp-qr-status" style="
                                color: #6B7280;
                                font-size: 11px;
                                margin-top: 4px;
                            "></div>
                        </div>
                    </div>
                    ` : ''}

                    <form id="extensao-whatsapp-form" style="display: flex; flex-direction: column; gap: 12px;">
                        <!-- Toggle Ativar Notificações -->
                        <div class="extensao-field-group" style="background: #F9FAFB; padding: 12px; border-radius: 8px; border: 1px solid #E5E7EB;">
                            <label style="display: flex; align-items: center; gap: 10px; cursor: pointer;">
                                <input type="checkbox" id="extensao-whatsapp-ativo" ${ativo ? 'checked' : ''} style="width: 18px; height: 18px; cursor: pointer; accent-color: #22C55E;">
                                <span style="font-weight: 600; color: var(--text-main); font-size: 14px; flex: 1;">
                                    Ativar notificações WhatsApp
                                </span>
                            </label>
                        </div>

                        <!-- Container que aparece quando notificações estão ativas -->
                        <div id="extensao-whatsapp-config-container" style="display: ${ativo ? 'block' : 'none'};">
                            
                            <!-- PASSO 1: Número Principal (OBRIGATÓRIO) -->
                            <div style="margin-bottom: 16px; padding: 16px; background: #F0FDF4; border: 1px solid #86EFAC; border-radius: 8px;">
                                <label style="display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; color: #166534; margin-bottom: 10px;">
                                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
                                    </svg>
                                    Número Principal <span style="color: #DC2626;">*</span>
                                </label>
                                <input 
                                    type="text" 
                                    id="extensao-whatsapp-numero-principal"
                                    placeholder="551188123456"
                                    maxlength="13"
                                    class="extensao-input-modern extensao-whatsapp-input"
                                    style="width: 100%; font-size: 15px; padding: 12px;"
                                    value="${numeroUnico || exigencia || deferido || indeferido || emAnalise || agendamento || ''}"
                                >
                                <p style="margin-top: 6px; font-size: 11px; color: #6B7280;">
                                    Formato: código do país + DDD + número (ex: 5511988887777)
                                </p>
                            </div>

                            <!-- PASSO 2: Escolher se usa para todos ou configura por status -->
                            <div style="margin-bottom: 12px; padding: 12px; background: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 8px;">
                                <label style="display: flex; align-items: center; gap: 10px; cursor: pointer;">
                                    <input type="checkbox" id="extensao-whatsapp-usar-mesmo" ${usarMesmoNumero ? 'checked' : ''} style="width: 18px; height: 18px; cursor: pointer;">
                                    <span style="font-weight: 500; color: var(--text-main); font-size: 13px; flex: 1;">
                                        Usar este número para <strong>todos os status</strong>
                                    </span>
                                </label>
                                <p style="margin-top: 6px; margin-left: 28px; font-size: 11px; color: #6B7280;">
                                    Desmarque para configurar números diferentes por status
                                </p>
                            </div>

                            <!-- Números por Status (se não usar número único) -->
                            <div id="extensao-whatsapp-numeros-individuais" style="display: ${usarMesmoNumero ? 'none' : 'block'}; margin-top: 12px; padding: 16px; background: #FFFBEB; border: 1px solid #FDE68A; border-radius: 8px;">
                                <p style="font-size: 13px; font-weight: 600; color: #92400E; margin-bottom: 12px; display: flex; align-items: center; gap: 8px;">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                                    </svg>
                                    Números por Status (opcional)
                                </p>
                                <p style="font-size: 11px; color: #92400E; margin-bottom: 12px;">
                                    Deixe em branco para usar o número principal. Preencha apenas os que deseja personalizar.
                                </p>
                        
                        <!-- Exigência -->
                        <div style="margin-bottom: 12px;">
                            <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 500; color: #374151; margin-bottom: 6px;">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink: 0;">
                                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                                    <polyline points="14 2 14 8 20 8"/>
                                </svg>
                                Exigência
                            </label>
                            <input 
                                type="text" 
                                id="extensao-whatsapp-exigencia"
                                placeholder="551188123456"
                                maxlength="13"
                                class="extensao-input-modern extensao-whatsapp-input"
                                style="width: 100%;"
                                value="${exigencia}"
                            >
                        </div>

                        <!-- Deferido -->
                        <div style="margin-bottom: 12px;">
                            <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 500; color: #374151; margin-bottom: 6px;">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22C55E" stroke-width="2" style="flex-shrink: 0;">
                                    <polyline points="20 6 9 17 4 12"/>
                                </svg>
                                Deferido
                            </label>
                            <input 
                                type="text" 
                                id="extensao-whatsapp-deferido"
                                placeholder="551188123456"
                                maxlength="13"
                                class="extensao-input-modern extensao-whatsapp-input"
                                style="width: 100%;"
                                value="${deferido}"
                            >
                        </div>

                        <!-- Indeferido -->
                        <div style="margin-bottom: 12px;">
                            <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 500; color: #374151; margin-bottom: 6px;">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#EF4444" stroke-width="2" style="flex-shrink: 0;">
                                    <line x1="18" y1="6" x2="6" y2="18"/>
                                    <line x1="6" y1="6" x2="18" y2="18"/>
                                </svg>
                                Indeferido
                            </label>
                            <input 
                                type="text" 
                                id="extensao-whatsapp-indeferido"
                                placeholder="551188123456"
                                maxlength="13"
                                class="extensao-input-modern extensao-whatsapp-input"
                                style="width: 100%;"
                                value="${indeferido}"
                            >
                        </div>

                        <!-- Em Análise -->
                        <div style="margin-bottom: 12px;">
                            <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 500; color: #374151; margin-bottom: 6px;">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#3B82F6" stroke-width="2" style="flex-shrink: 0;">
                                    <circle cx="11" cy="11" r="8"/>
                                    <path d="m21 21-4.35-4.35"/>
                                </svg>
                                Em Análise
                            </label>
                            <input 
                                type="text" 
                                id="extensao-whatsapp-em-analise"
                                placeholder="551188123456"
                                maxlength="13"
                                class="extensao-input-modern extensao-whatsapp-input"
                                style="width: 100%;"
                                value="${emAnalise}"
                            >
                        </div>

                        <!-- Agendamento -->
                        <div style="margin-bottom: 12px;">
                            <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 500; color: #374151; margin-bottom: 6px;">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" stroke-width="2" style="flex-shrink: 0;">
                                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                                    <line x1="16" y1="2" x2="16" y2="6"/>
                                    <line x1="8" y1="2" x2="8" y2="6"/>
                                    <line x1="3" y1="10" x2="21" y2="10"/>
                                </svg>
                                Agendamento <span style="font-size: 11px; color: #6B7280;">(lembrete 30 dias antes)</span>
                            </label>
                                <input 
                                    type="text" 
                                    id="extensao-whatsapp-agendamento"
                                    placeholder="551188123456"
                                    maxlength="13"
                                    class="extensao-input-modern extensao-whatsapp-input"
                                    style="width: 100%;"
                                    value="${agendamento}"
                                >
                                </div>
                            </div>
                            
                            <!-- SEÇÃO PARCEIROS -->
                            <div id="extensao-parceiros-section" style="margin-top: 20px; padding-top: 16px; border-top: 2px solid #E5E7EB;">
                                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
                                    <h3 style="margin: 0; color: #1F2937; font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px;">
                                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6366F1" stroke-width="2">
                                            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                                            <circle cx="9" cy="7" r="4"/>
                                            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                                            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                                        </svg>
                                        Parceiros (Indicadores)
                                    </h3>
                                    <span style="font-size: 10px; padding: 2px 6px; background: #E0E7FF; color: #4338CA; border-radius: 4px; font-weight: 500;">NOVO</span>
                                </div>
                                
                                <div style="padding: 12px; background: #EEF2FF; border: 1px solid #C7D2FE; border-radius: 8px; margin-bottom: 12px;">
                                    <p style="font-size: 12px; color: #4338CA; margin: 0 0 8px 0; font-weight: 500;">
                                        Como funciona?
                                    </p>
                                    <ol style="font-size: 11px; color: #4B5563; margin: 0; padding-left: 16px; line-height: 1.6;">
                                        <li>Cadastre um parceiro com nome e telefone</li>
                                        <li>O sistema gera uma etiqueta (ex: <code style="background: #FEF3C7; padding: 1px 4px; border-radius: 3px; color: #92400E;">PARCEIRO:JOAO</code>)</li>
                                        <li>Adicione essa etiqueta aos clientes indicados por ele no Tramitação</li>
                                        <li>Escolha quais atualizações o parceiro recebe (Exigência, Deferido, etc.)</li>
                                        <li>O parceiro será notificado automaticamente via WhatsApp!</li>
                                    </ol>
                                </div>
                                
                                <button 
                                    type="button" 
                                    id="extensao-btn-gerenciar-parceiros"
                                    style="
                                        width: 100%;
                                        background-color: #E0E7FF;
                                        border: 1px solid #A5B4FC;
                                        color: #3730A3;
                                        padding: 12px;
                                        border-radius: 6px;
                                        font-size: 13px;
                                        font-weight: 600;
                                        cursor: pointer;
                                        display: flex;
                                        align-items: center;
                                        justify-content: center;
                                        gap: 8px;
                                    "
                                >
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                                        <circle cx="9" cy="7" r="4"/>
                                        <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                                        <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                                    </svg>
                                    Gerenciar Parceiros
                                </button>
                                
                                <p id="extensao-parceiros-count" style="text-align: center; font-size: 11px; color: #6B7280; margin-top: 8px;">
                                    Carregando parceiros...
                                </p>
                            </div>
                        </div>
                        <!-- Fim do container de configuração -->

                        <div class="extensao-flex-row" style="margin-top: 16px;">
                            <button type="submit" class="extensao-btn-primary" id="extensao-whatsapp-salvar">Salvar</button>
                            <button type="button" id="extensao-whatsapp-cancel" class="extensao-btn-secondary">Cancelar</button>
                        </div>
                    </form>
                    <div id="extensao-whatsapp-error" style="
                        color: #991B1B;
                        margin-top: 16px;
                        padding: 12px;
                        background: #FEE2E2;
                        border-radius: 6px;
                        font-size: 13px;
                        display: none;
                    "></div>
                    <div id="extensao-whatsapp-success" style="
                        color: #166534;
                        margin-top: 16px;
                        padding: 12px;
                        background: #DCFCE7;
                        border-radius: 6px;
                        font-size: 13px;
                        display: none;
                    "></div>
                `;

                    setTimeout(() => {
                        const form = document.getElementById('extensao-whatsapp-form');
                        const cancelBtn = document.getElementById('extensao-whatsapp-cancel');
                        const errorDiv = document.getElementById('extensao-whatsapp-error');
                        const successDiv = document.getElementById('extensao-whatsapp-success');

                        // Novos elementos da UI reestruturada
                        const ativoCheckbox = document.getElementById('extensao-whatsapp-ativo');
                        const configContainer = document.getElementById('extensao-whatsapp-config-container');
                        const numeroPrincipalInput = document.getElementById('extensao-whatsapp-numero-principal');
                        const usarMesmoCheckbox = document.getElementById('extensao-whatsapp-usar-mesmo');
                        const numerosIndividuais = document.getElementById('extensao-whatsapp-numeros-individuais');

                        // Elementos admin (podem não existir se não for admin)
                        const desconectarBtn = document.getElementById('extensao-whatsapp-desconectar');
                        const qrContainer = document.getElementById('extensao-whatsapp-qr-container');
                        const qrCodeDiv = document.getElementById('extensao-whatsapp-qr-code');
                        const qrStatusDiv = document.getElementById('extensao-whatsapp-qr-status');

                        if (!form || !cancelBtn) {
                            console.error('[Extensão] Elementos do formulário de WhatsApp não encontrados');
                            return;
                        }

                        // Toggle: Mostrar/ocultar configurações quando ativar/desativar notificações
                        if (ativoCheckbox && configContainer) {
                            ativoCheckbox.addEventListener('change', (e) => {
                                configContainer.style.display = e.target.checked ? 'block' : 'none';
                            });
                        }

                        // Toggle: Mostrar/ocultar números individuais
                        if (usarMesmoCheckbox && numerosIndividuais) {
                            usarMesmoCheckbox.addEventListener('change', (e) => {
                                numerosIndividuais.style.display = e.target.checked ? 'none' : 'block';
                            });
                        }

                        // Variáveis compartilhadas para limpeza de timers
                        let qrCodeTimer = null;
                        let verificarConexaoTimer = null;
                        let countdownTimer = null;
                        let isModalOpen = true;
                        let observer = null;
                        let currentQrExpiresAt = null; // Timestamp de quando o QR expira
                        let lastQrCode = null; // Para detectar se mudou

                        const limparTimers = () => {
                            if (qrCodeTimer) {
                                clearTimeout(qrCodeTimer);
                                qrCodeTimer = null;
                            }
                            if (verificarConexaoTimer) {
                                clearInterval(verificarConexaoTimer);
                                verificarConexaoTimer = null;
                            }
                            if (countdownTimer) {
                                clearInterval(countdownTimer);
                                countdownTimer = null;
                            }
                            if (observer) {
                                observer.disconnect();
                                observer = null;
                            }
                        };

                        // ========================================
                        // FUNÇÃO UNIFICADA DE EXIBIÇÃO DE QR CODE COM CONTADOR SINCRONIZADO
                        // ========================================
                        const exibirQrCode = (qrCode, expiresInMs) => {
                            if (!qrCodeDiv || !qrStatusDiv) return;

                            // Calcular tempo de expiração
                            currentQrExpiresAt = Date.now() + expiresInMs;
                            const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrCode)}`;

                            // Exibir QR Code
                            qrCodeDiv.innerHTML = `
                                <div class="extensao-qr-box" style="animation: extensaoFadeIn 0.3s ease-out;">
                                    <img src="${qrImageUrl}" alt="QR Code WhatsApp" style="max-width: 200px; height: auto; display: block; border-radius: 4px;" />
                                </div>
                            `;

                            // Limpar contador anterior
                            if (countdownTimer) {
                                clearInterval(countdownTimer);
                            }

                            // Função para atualizar contador
                            const atualizarContador = () => {
                                if (!isModalOpen || !currentQrExpiresAt) {
                                    if (countdownTimer) clearInterval(countdownTimer);
                                    return;
                                }

                                const agora = Date.now();
                                const restante = Math.max(0, currentQrExpiresAt - agora);
                                const segundos = Math.ceil(restante / 1000);
                                const porcentagem = Math.min(100, (restante / expiresInMs) * 100);

                                // Cores baseadas no tempo restante
                                let corFundo, corBorda, corTexto;
                                if (segundos > 10) {
                                    corFundo = '#DCFCE7'; corBorda = '#86EFAC'; corTexto = '#166534';
                                } else if (segundos > 5) {
                                    corFundo = '#FEF9C3'; corBorda = '#FDE047'; corTexto = '#854D0E';
                                } else {
                                    corFundo = '#FEE2E2'; corBorda = '#FECACA'; corTexto = '#991B1B';
                                }

                                qrStatusDiv.innerHTML = `
                                    <div style="font-size: 12px; color: #6B7280; margin-bottom: 8px;">
                                        Expira em ${segundos}s
                                    </div>
                                    <div style="width: 100%; height: 3px; background: #E5E7EB; border-radius: 2px; overflow: hidden;">
                                        <div style="
                                            width: ${porcentagem}%; 
                                            height: 100%; 
                                            background: ${segundos > 10 ? '#10B981' : (segundos > 5 ? '#F59E0B' : '#EF4444')}; 
                                            transition: width 0.1s linear, background 0.3s ease;
                                            border-radius: 2px;
                                        "></div>
                                    </div>
                                `;

                                // Se expirou, mostrar que está renovando
                                if (segundos <= 0) {
                                    clearInterval(countdownTimer);
                                    countdownTimer = null;
                                    currentQrExpiresAt = null;

                                    qrCodeDiv.innerHTML = `
                                        <div style="padding: 40px; text-align: center;">
                                            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#9CA3AF" stroke-width="2" class="extensao-spin" style="margin: 0 auto 12px;">
                                                <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                                            </svg>
                                            <div style="font-size: 12px; color: #6B7280;">Aguardando novo QR Code...</div>
                                        </div>
                                    `;
                                    qrStatusDiv.innerHTML = `
                                        <div style="font-size: 12px; color: #9CA3AF;">
                                            QR Code expirado. Gerando novo...
                                        </div>
                                    `;
                                }
                            };

                            // Atualizar imediatamente e depois a cada segundo
                            atualizarContador();
                            countdownTimer = setInterval(atualizarContador, 1000);
                        };

                        // ========================================
                        // FUNÇÃO PRINCIPAL DE BUSCA DE QR CODE
                        // ========================================
                        const iniciarBuscaQrCode = async (token) => {
                            if (!isModalOpen || !qrContainer || !qrCodeDiv || !qrStatusDiv) return;

                            qrContainer.style.display = 'block';

                            try {
                                // Buscar QR Code do backend
                                const qrResponse = await fazerRequisicao(`${API_BASE_URL}/extensao/whatsapp/qr-code`, {
                                    headers: { 'Authorization': `Bearer ${token}` }
                                });
                                const qrData = await qrResponse.json();

                                if (!isModalOpen) return;

                                if (qrData.success && qrData.hasQrCode && qrData.qr) {
                                    // QR Code disponível - só atualizar se mudou
                                    if (qrData.qr !== lastQrCode) {
                                        lastQrCode = qrData.qr;
                                        const expiresInMs = qrData.expiresIn || 20000; // Padrão 20s
                                        exibirQrCode(qrData.qr, expiresInMs);
                                    }

                                    // Agendar próxima verificação baseada no tempo de expiração
                                    const tempoAteProximaBusca = Math.max(2000, (qrData.expiresIn || 20000) - 2000);
                                    qrCodeTimer = setTimeout(() => iniciarBuscaQrCode(token), tempoAteProximaBusca);
                                } else {
                                    // Sem QR Code ainda - mostrar loading e tentar novamente
                                    if (!lastQrCode) {
                                        qrCodeDiv.innerHTML = `
                                            <div style="padding: 40px; text-align: center;">
                                                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#9CA3AF" stroke-width="2" class="extensao-spin" style="margin: 0 auto 12px;">
                                                    <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                                                </svg>
                                                <div style="font-size: 12px; color: #6B7280;">Aguardando QR Code...</div>
                                            </div>
                                        `;
                                        qrStatusDiv.innerHTML = `
                                            <div style="font-size: 12px; color: #9CA3AF;">Gerando QR Code...</div>
                                        `;
                                    }
                                    // Tentar novamente em 3 segundos
                                    qrCodeTimer = setTimeout(() => iniciarBuscaQrCode(token), 3000);
                                }
                            } catch (error) {
                                console.error('[Extensão] Erro ao buscar QR Code:', error);
                                if (isModalOpen) {
                                    qrCodeTimer = setTimeout(() => iniciarBuscaQrCode(token), 3000);
                                }
                            }
                        };

                        // ========================================
                        // VERIFICAR STATUS PERIODICAMENTE (menos frequente)
                        // ========================================
                        const iniciarVerificacaoStatus = async (token) => {
                            verificarConexaoTimer = setInterval(async () => {
                                if (!isModalOpen) {
                                    limparTimers();
                                    return;
                                }

                                try {
                                    const statusResponse = await fazerRequisicao(`${API_BASE_URL}/extensao/whatsapp/status`, {
                                        headers: { 'Authorization': `Bearer ${token}` }
                                    });
                                    const statusData = await statusResponse.json();

                                    if (statusData.status?.isReady) {
                                        // WhatsApp conectou! Parar tudo e mostrar sucesso
                                        limparTimers();

                                        if (qrCodeDiv) {
                                            qrCodeDiv.innerHTML = `
                                                <div class="extensao-connected-box extensao-success-anim">
                                                    <div class="extensao-connected-icon extensao-success-anim">
                                                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3">
                                                            <polyline points="20 6 9 17 4 12"/>
                                                        </svg>
                                                    </div>
                                                    <div style="flex: 1;">
                                                        <div style="font-weight: 600; font-size: 14px; color: #065F46; margin-bottom: 2px;">
                                                            WhatsApp Conectado!
                                                        </div>
                                                        <div style="font-size: 12px; color: #047857;">
                                                            ${statusData.status.numeroConectado || 'Conexão estabelecida'}
                                                        </div>
                                                    </div>
                                                </div>
                                            `;
                                        }
                                        if (qrStatusDiv) {
                                            qrStatusDiv.innerHTML = `
                                                <div style="font-size: 12px; color: #166534; margin-top: 8px; text-align: center;">
                                                    Atualizando modal...
                                                </div>
                                            `;
                                        }

                                        // Reabrir modal após 2 segundos para mostrar estado atualizado
                                        setTimeout(() => {
                                            if (isModalOpen && document.getElementById('extensao-whatsapp-modal')) {
                                                fecharTodosModais();
                                                exibirModalConfiguracaoWhatsApp();
                                            }
                                        }, 2000);
                                    }
                                } catch (error) {
                                    console.error('[Extensão] Erro ao verificar status:', error);
                                }
                            }, 5000); // Verificar status a cada 5 segundos (menos frequente)
                        };

                        // Botão único de REINICIAR WhatsApp (desconecta e reconecta)
                        if (desconectarBtn) {
                            // Criar observer após o modal ser adicionado ao DOM
                            setTimeout(() => {
                                const modalElement = document.getElementById('extensao-whatsapp-modal');
                                if (modalElement) {
                                    observer = new MutationObserver((mutations) => {
                                        if (!document.getElementById('extensao-whatsapp-modal')) {
                                            isModalOpen = false;
                                            limparTimers();
                                        }
                                    });
                                    observer.observe(document.body, {
                                        childList: true,
                                        subtree: false
                                    });
                                }
                            }, 100);

                            desconectarBtn.addEventListener('click', async () => {
                                if (!qrContainer || !qrCodeDiv || !qrStatusDiv) return;

                                desconectarBtn.disabled = true;
                                desconectarBtn.textContent = 'Reiniciando...';
                                limparTimers();
                                lastQrCode = null;
                                isModalOpen = true;

                                try {
                                    const token = await obterTokenAuth();
                                    if (!token) {
                                        mostrarToast('É necessário fazer login primeiro', 'error');
                                        desconectarBtn.textContent = 'Reiniciar WhatsApp';
                                        desconectarBtn.disabled = false;
                                        return;
                                    }

                                    // Mostrar QR Container com loading
                                    qrContainer.style.display = 'block';
                                    qrCodeDiv.innerHTML = `
                                        <div style="padding: 40px; text-align: center;">
                                            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#9CA3AF" stroke-width="2" class="extensao-spin" style="margin: 0 auto 12px;">
                                                <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                                            </svg>
                                            <div style="font-size: 12px; color: #6B7280;">Reiniciando WhatsApp...</div>
                                        </div>
                                    `;
                                    qrStatusDiv.innerHTML = '';

                                    // Reiniciar WhatsApp no backend
                                    try {
                                        await fazerRequisicao(`${API_BASE_URL}/extensao/whatsapp/desconectar`, {
                                            method: 'POST',
                                            headers: { 'Authorization': `Bearer ${token}` }
                                        });
                                        await new Promise(resolve => setTimeout(resolve, 2000));
                                    } catch (error) {
                                        console.log('[Extensão] Erro ao desconectar:', error);
                                    }

                                    // Inicializar novamente
                                    try {
                                        await fazerRequisicao(`${API_BASE_URL}/extensao/whatsapp/inicializar`, {
                                            method: 'POST',
                                            headers: { 'Authorization': `Bearer ${token}` }
                                        });
                                        await new Promise(resolve => setTimeout(resolve, 1000));
                                    } catch (error) {
                                        console.log('[Extensão] Erro ao inicializar:', error);
                                    }

                                    // Restaurar botão
                                    desconectarBtn.textContent = 'Reiniciar WhatsApp';
                                    desconectarBtn.disabled = false;

                                    // Iniciar busca de QR Code e verificação de status
                                    iniciarBuscaQrCode(token);
                                    iniciarVerificacaoStatus(token);

                                } catch (error) {
                                    console.error('[Extensão] Erro ao reiniciar WhatsApp:', error);
                                    limparTimers();
                                    desconectarBtn.textContent = 'Reiniciar WhatsApp';
                                    desconectarBtn.disabled = false;
                                    if (qrCodeDiv) {
                                        qrCodeDiv.innerHTML = '<div style="padding: 20px; color: #EF4444; text-align: center;">Erro ao reiniciar. Tente novamente.</div>';
                                    }
                                }
                            });
                        }

                        // ========================================
                        // AUTO-INICIALIZAR QR CODE SE JÁ ESTÁ CONECTANDO
                        // ========================================
                        if (isAdmin && isConnecting && !isConnected && qrContainer && qrCodeDiv && qrStatusDiv) {
                            console.log('[Extensão] WhatsApp já está conectando, buscando QR Code automaticamente...');

                            // Mostrar container e iniciar busca
                            qrContainer.style.display = 'block';
                            qrCodeDiv.innerHTML = `
                                <div style="padding: 40px; text-align: center;">
                                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#9CA3AF" stroke-width="2" class="extensao-spin" style="margin: 0 auto 12px;">
                                        <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                                    </svg>
                                    <div style="font-size: 12px; color: #6B7280;">Carregando QR Code...</div>
                                </div>
                            `;
                            qrStatusDiv.innerHTML = 'Aguardando QR Code do servidor...';

                            (async () => {
                                try {
                                    const token = await obterTokenAuth();
                                    if (token && isModalOpen) {
                                        iniciarBuscaQrCode(token);
                                        iniciarVerificacaoStatus(token);
                                    }
                                } catch (error) {
                                    console.error('[Extensão] Erro ao auto-iniciar QR Code:', error);
                                }
                            })();
                        }

                        // Removido: Toggle antigo foi substituído pela nova lógica acima

                        // ========================================
                        // VALIDAÇÃO VISUAL EM TEMPO REAL DOS INPUTS DE NÚMERO
                        // ========================================
                        const validarInputNumeroWhatsApp = (input) => {
                            if (!input) return;

                            // Remover caracteres não numéricos
                            const valor = input.value.replace(/\D/g, '');
                            input.value = valor;

                            // Validação visual
                            input.classList.remove('input-valid', 'input-invalid');

                            if (valor.length === 0) {
                                // Neutro - sem validação visual se vazio
                                input.style.borderColor = '';
                                input.style.boxShadow = '';
                                return;
                            }

                            if (valor.length >= 10 && valor.length <= 13) {
                                // Válido
                                input.classList.add('input-valid');
                            } else {
                                // Inválido
                                input.classList.add('input-invalid');
                            }
                        };

                        // Aplicar validação em todos os inputs de WhatsApp
                        const whatsappInputs = document.querySelectorAll('.extensao-whatsapp-input');
                        whatsappInputs.forEach(input => {
                            if (input.type === 'text') {
                                input.addEventListener('input', () => validarInputNumeroWhatsApp(input));
                                // Validar valores iniciais se já preenchidos
                                if (input.value) {
                                    validarInputNumeroWhatsApp(input);
                                }
                            }
                        });

                        // ========================================
                        // BOTÃO GERENCIAR PARCEIROS
                        // ========================================
                        const btnGerenciarParceiros = document.getElementById('extensao-btn-gerenciar-parceiros');
                        const parceirosCountEl = document.getElementById('extensao-parceiros-count');

                        // Carregar contagem de parceiros
                        const carregarContagemParceiros = async () => {
                            if (!parceirosCountEl) return;
                            try {
                                const token = await obterTokenAuth();
                                if (!token) return;

                                const response = await fazerRequisicao(`${API_BASE_URL}/parceiros`, {
                                    headers: { 'Authorization': `Bearer ${token}` }
                                });
                                const data = await response.json();

                                if (data.success && data.parceiros) {
                                    const total = data.parceiros.length;
                                    const ativos = data.parceiros.filter(p => p.ativo).length;
                                    if (total === 0) {
                                        parceirosCountEl.innerHTML = 'Nenhum parceiro cadastrado ainda';
                                    } else {
                                        parceirosCountEl.innerHTML = `${total} parceiro${total > 1 ? 's' : ''} cadastrado${total > 1 ? 's' : ''} (${ativos} ativo${ativos > 1 ? 's' : ''})`;
                                    }
                                } else {
                                    parceirosCountEl.innerHTML = 'Nenhum parceiro cadastrado ainda';
                                }
                            } catch (error) {
                                console.error('[Extensão] Erro ao carregar parceiros:', error);
                                parceirosCountEl.innerHTML = 'Erro ao carregar parceiros';
                            }
                        };

                        // Carregar contagem ao abrir o modal
                        carregarContagemParceiros();

                        // Event listener do botão
                        if (btnGerenciarParceiros) {
                            btnGerenciarParceiros.addEventListener('click', () => {
                                exibirModalListaParceiros();
                            });
                        }

                        form.addEventListener('submit', async (e) => {
                            e.preventDefault();
                            if (errorDiv) errorDiv.style.display = 'none';
                            if (successDiv) successDiv.style.display = 'none';

                            // ========================================
                            // NOVA LÓGICA DE LEITURA DOS CAMPOS
                            // ========================================
                            const ativo = ativoCheckbox ? ativoCheckbox.checked : false;
                            const usarMesmo = usarMesmoCheckbox ? usarMesmoCheckbox.checked : false;

                            // Número principal (obrigatório se ativo)
                            const numeroPrincipal = numeroPrincipalInput ? numeroPrincipalInput.value.replace(/\D/g, '').trim() : '';

                            // Números individuais (só usados se não usar mesmo número)
                            const exigenciaEl = document.getElementById('extensao-whatsapp-exigencia');
                            const deferidoEl = document.getElementById('extensao-whatsapp-deferido');
                            const indeferidoEl = document.getElementById('extensao-whatsapp-indeferido');
                            const emAnaliseEl = document.getElementById('extensao-whatsapp-em-analise');
                            const agendamentoEl = document.getElementById('extensao-whatsapp-agendamento');

                            const exigencia = exigenciaEl ? exigenciaEl.value.replace(/\D/g, '').trim() : '';
                            const deferido = deferidoEl ? deferidoEl.value.replace(/\D/g, '').trim() : '';
                            const indeferido = indeferidoEl ? indeferidoEl.value.replace(/\D/g, '').trim() : '';
                            const emAnalise = emAnaliseEl ? emAnaliseEl.value.replace(/\D/g, '').trim() : '';
                            const agendamento = agendamentoEl ? agendamentoEl.value.replace(/\D/g, '').trim() : '';

                            // ========================================
                            // VALIDAÇÃO
                            // ========================================

                            // Se ativo, número principal é OBRIGATÓRIO
                            if (ativo && !numeroPrincipal) {
                                if (errorDiv) {
                                    errorDiv.innerHTML = `
                                        <strong>Número principal obrigatório</strong><br>
                                        Para ativar as notificações, é necessário informar o número principal.
                                    `;
                                    errorDiv.style.display = 'block';
                                }
                                if (numeroPrincipalInput) {
                                    numeroPrincipalInput.classList.add('input-invalid');
                                    numeroPrincipalInput.focus();
                                }
                                return;
                            }

                            // Validação de formato de números (10-13 dígitos)
                            const validarNumero = (num) => {
                                if (!num) return true;
                                return num.length >= 10 && num.length <= 13;
                            };

                            // Validar número principal
                            if (numeroPrincipal && !validarNumero(numeroPrincipal)) {
                                if (errorDiv) {
                                    errorDiv.innerHTML = `
                                        <strong>Número inválido</strong><br>
                                        O número principal deve ter entre 10 e 13 dígitos (código do país + DDD + número).
                                    `;
                                    errorDiv.style.display = 'block';
                                }
                                return;
                            }

                            // Se não usar mesmo número, validar os individuais que foram preenchidos
                            if (!usarMesmo) {
                                const numerosIndividuais = [
                                    { nome: 'Exigência', valor: exigencia },
                                    { nome: 'Deferido', valor: deferido },
                                    { nome: 'Indeferido', valor: indeferido },
                                    { nome: 'Em Análise', valor: emAnalise },
                                    { nome: 'Agendamento', valor: agendamento }
                                ];

                                for (const num of numerosIndividuais) {
                                    if (num.valor && !validarNumero(num.valor)) {
                                        if (errorDiv) {
                                            errorDiv.innerHTML = `
                                                <strong>Número inválido</strong><br>
                                                O número para "${num.nome}" deve ter entre 10 e 13 dígitos.
                                            `;
                                            errorDiv.style.display = 'block';
                                        }
                                        return;
                                    }
                                }
                            }

                            try {
                                const token = await obterTokenAuth();

                                // Montar dados para envio
                                // Se usar mesmo número: enviar numeroPrincipal como numeroUnico
                                // Se não: enviar numeroPrincipal como fallback + individuais
                                const bodyData = {
                                    ativo: ativo,
                                    // Se usar mesmo número para todos, enviar como numeroUnico
                                    // Caso contrário, enviar números individuais (ou numeroPrincipal como fallback)
                                    numeroUnico: usarMesmo ? numeroPrincipal : undefined,
                                    exigencia: usarMesmo ? undefined : (exigencia || numeroPrincipal),
                                    deferido: usarMesmo ? undefined : (deferido || numeroPrincipal),
                                    indeferido: usarMesmo ? undefined : (indeferido || numeroPrincipal),
                                    emAnalise: usarMesmo ? undefined : (emAnalise || numeroPrincipal),
                                    agendamento: usarMesmo ? undefined : (agendamento || numeroPrincipal)
                                };

                                Object.keys(bodyData).forEach(key => {
                                    if (bodyData[key] === undefined || bodyData[key] === '') {
                                        delete bodyData[key];
                                    }
                                });

                                console.log('[Extensão] 📤 Enviando configurações WhatsApp:', bodyData);

                                const response = await fazerRequisicao(`${API_BASE_URL}/extensao/config/whatsapp`, {
                                    method: 'PUT',
                                    headers: {
                                        'Authorization': `Bearer ${token}`,
                                        'Content-Type': 'application/json'
                                    },
                                    body: JSON.stringify(bodyData)
                                });

                                const data = await response.json();
                                console.log('[Extensão] 📥 Resposta do backend:', data);

                                if (response.ok && data.success) {
                                    if (successDiv) {
                                        successDiv.textContent = 'Configurações de WhatsApp salvas com sucesso!';
                                        successDiv.style.display = 'block';
                                    }
                                    setTimeout(() => {
                                        if (document.body.contains(modal)) {
                                            document.body.removeChild(modal);
                                        }
                                        resolve(true);
                                    }, 1500);
                                } else {
                                    if (errorDiv) {
                                        const mensagemErro = data.message || data.error || 'Falha ao salvar configurações';
                                        errorDiv.textContent = `Erro: ${mensagemErro}`;
                                        errorDiv.style.display = 'block';
                                        console.error('[Extensão] Erro ao salvar WhatsApp:', data);
                                    }
                                }
                            } catch (error) {
                                console.error('[Extensão] Erro ao salvar configurações de WhatsApp:', error);
                                if (errorDiv) {
                                    let errorMessage = error.message || 'Erro desconhecido';
                                    if (errorMessage.includes('Failed to fetch')) {
                                        errorMessage = 'Falha ao conectar. Verifique se o backend está rodando.';
                                    } else if (errorMessage.includes('parsear JSON')) {
                                        errorMessage = 'Erro na resposta do servidor. Verifique os logs do backend.';
                                    }
                                    errorDiv.textContent = `Erro: ${errorMessage}`;
                                    errorDiv.style.display = 'block';
                                }
                            }
                        });

                        cancelBtn.addEventListener('click', () => {
                            limparTimers();
                            if (document.body.contains(modal)) {
                                modal.remove();
                            }
                            resolve(false);
                        });

                        modal.addEventListener('click', (e) => {
                            if (e.target === modal) {
                                limparTimers();
                                if (document.body.contains(modal)) {
                                    modal.remove();
                                }
                                resolve(false);
                            }
                        });
                    }, 10);

                } catch (error) {
                    console.error('[Extensão] Erro ao carregar configurações WhatsApp:', error);
                    mostrarToast('Erro ao carregar configurações', 'error');
                    resolve(false);
                }
            });

            modal.appendChild(content);
            document.body.appendChild(modal);
        });
    }
    /**
     * Obtém configurações de WhatsApp do backend
     * Retorna: { config: {...}, isAdmin: boolean }
     * ⚠️ SEGURANÇA: isAdmin vem do backend, não do frontend
     */
    async function obterConfiguracoesWhatsApp() {
        const token = await obterTokenAuth();
        if (!token) return null;

        try {
            const response = await fazerRequisicao(`${API_BASE_URL}/extensao/config/whatsapp`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            if (response.ok) {
                const data = await response.json();
                // Retornar objeto completo com config e isAdmin (do backend)
                return {
                    config: data.config || {},
                    isAdmin: data.isAdmin === true // Validação vem do backend
                };
            }
        } catch (error) {
            console.error('[Extensão] Erro ao obter configurações de WhatsApp:', error);
        }
        return null;
    }

    // ===== FUNÇÃO: MODAL LISTA DE PARCEIROS =====
    async function exibirModalListaParceiros() {
        return new Promise((resolve) => {
            fecharTodosModais();

            const modal = document.createElement('div');
            modal.id = 'extensao-parceiros-modal';
            modal.className = 'extensao-modal';

            const content = document.createElement('div');
            content.id = 'extensao-parceiros-content';
            content.className = 'extensao-modal-content';
            content.style.maxWidth = '550px';

            const renderizarLista = async () => {
                try {
                    const token = await obterTokenAuth();
                    if (!token) {
                        mostrarToast('É necessário fazer login primeiro', 'error');
                        return;
                    }

                    content.innerHTML = `
                        <h2 class="extensao-title" style="margin-bottom: 12px; font-size: 18px;">Gerenciar Parceiros</h2>
                        <div style="text-align: center; padding: 40px;">
                            <div class="extensao-spinner"></div>
                            <p style="color: #6B7280; font-size: 13px; margin-top: 12px;">Carregando parceiros...</p>
                        </div>
                    `;

                    const response = await fazerRequisicao(`${API_BASE_URL}/parceiros`, {
                        headers: { 'Authorization': `Bearer ${token}` }
                    });
                    const data = await response.json();

                    if (!data.success) {
                        throw new Error(data.message || 'Erro ao carregar parceiros');
                    }

                    const parceiros = data.parceiros || [];

                    content.innerHTML = `
                        <h2 class="extensao-title" style="margin-bottom: 12px; font-size: 18px;">Gerenciar Parceiros</h2>
                        
                        <div style="margin-bottom: 16px; padding: 12px; background: #EEF2FF; border: 1px solid #C7D2FE; border-radius: 8px;">
                            <p style="font-size: 12px; color: #4338CA; margin: 0; line-height: 1.5;">
                                <strong>Como usar:</strong> Adicione um parceiro, copie a etiqueta gerada (ex: <code style="background: #FEF3C7; padding: 1px 4px; border-radius: 3px;">PARCEIRO:NOME</code>) e aplique aos clientes indicados por ele no Tramitação.
                            </p>
                        </div>

                        <button id="extensao-btn-novo-parceiro" style="
                            width: 100%;
                            background-color: #22C55E;
                            color: white;
                            padding: 12px;
                            border-radius: 6px;
                            font-weight: 600;
                            border: none;
                            cursor: pointer;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            gap: 8px;
                            margin-bottom: 16px;
                        ">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <line x1="12" y1="5" x2="12" y2="19"></line>
                                <line x1="5" y1="12" x2="19" y2="12"></line>
                            </svg>
                            Adicionar Novo Parceiro
                        </button>

                        <div id="extensao-parceiros-lista" style="max-height: 350px; overflow-y: auto;">
                            ${parceiros.length === 0 ? `
                                <div style="text-align: center; padding: 30px; color: #6B7280;">
                                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#D1D5DB" stroke-width="1.5" style="margin: 0 auto 12px;">
                                        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                                        <circle cx="9" cy="7" r="4"/>
                                        <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                                        <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                                    </svg>
                                    <p style="font-size: 14px; margin: 0;">Nenhum parceiro cadastrado ainda</p>
                                    <p style="font-size: 12px; margin: 8px 0 0 0;">Clique em "Adicionar Novo Parceiro" para começar</p>
                                </div>
                            ` : parceiros.map(p => `
                                <div class="extensao-parceiro-card" data-id="${p.id}" style="
                                    padding: 12px;
                                    background: ${p.ativo ? '#F9FAFB' : '#FEF2F2'};
                                    border: 1px solid ${p.ativo ? '#E5E7EB' : '#FECACA'};
                                    border-radius: 8px;
                                    margin-bottom: 10px;
                                ">
                                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                                        <div style="display: flex; align-items: center; gap: 8px;">
                                            <span style="font-weight: 600; color: #1F2937;">${p.nomeEtiqueta}</span>
                                            <span style="font-size: 0.7rem; font-weight: 600; padding: 2px 6px; border-radius: 4px; background-color: ${p.ativo ? '#DCFCE7' : '#FEE2E2'}; color: ${p.ativo ? '#166534' : '#991B1B'};">
                                                ${p.ativo ? 'Ativo' : 'Inativo'}
                                            </span>
                                        </div>
                                        <div style="display: flex; gap: 4px;">
                                            <button class="extensao-btn-editar-parceiro" data-id="${p.id}" style="padding: 4px 8px; border-radius: 4px; border: none; cursor: pointer; background-color: #C8E6C9; color: #1B5E20; font-size: 12px;">Editar</button>
                                            <button class="extensao-btn-excluir-parceiro" data-id="${p.id}" style="padding: 4px 8px; border-radius: 4px; border: none; cursor: pointer; background-color: #EF9A9A; color: #B71C1C; font-size: 12px;">Excluir</button>
                                        </div>
                                    </div>
                                    <div style="font-size: 12px; color: #6B7280; margin-bottom: 6px;">
                                        📱 ${p.telefone}${p.nomeCompleto ? ` • ${p.nomeCompleto}` : ''}
                                    </div>
                                    <div style="display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 8px;">
                                        ${p.notificarExigencia ? '<span style="font-size: 10px; padding: 2px 6px; border-radius: 3px; background: #DCFCE7; color: #166534;">EXIG</span>' : ''}
                                        ${p.notificarDeferido ? '<span style="font-size: 10px; padding: 2px 6px; border-radius: 3px; background: #DCFCE7; color: #166534;">DEF</span>' : ''}
                                        ${p.notificarIndeferido ? '<span style="font-size: 10px; padding: 2px 6px; border-radius: 3px; background: #DCFCE7; color: #166534;">IND</span>' : ''}
                                        ${p.notificarAgendamento ? '<span style="font-size: 10px; padding: 2px 6px; border-radius: 3px; background: #DCFCE7; color: #166534;">AGEND</span>' : ''}
                                        ${p.notificarEmAnalise ? '<span style="font-size: 10px; padding: 2px 6px; border-radius: 3px; background: #DCFCE7; color: #166534;">ANÁLISE</span>' : ''}
                                    </div>
                                    <div style="padding: 6px 10px; background: #FEF3C7; border-radius: 4px; display: flex; align-items: center; justify-content: space-between;">
                                        <code style="font-size: 11px; color: #92400E; font-weight: 600;">PARCEIRO:${p.nomeEtiqueta}</code>
                                        <button class="extensao-btn-copiar-etiqueta" data-etiqueta="PARCEIRO:${p.nomeEtiqueta}" style="padding: 2px 8px; font-size: 10px; background: #F59E0B; color: white; border: none; border-radius: 3px; cursor: pointer;">Copiar</button>
                                    </div>
                                </div>
                            `).join('')}
                        </div>

                        <div class="extensao-flex-row" style="margin-top: 16px;">
                            <button id="extensao-parceiros-voltar" class="extensao-btn-secondary">Voltar</button>
                        </div>
                    `;

                    // Event listeners
                    setTimeout(() => {
                        const btnNovo = document.getElementById('extensao-btn-novo-parceiro');
                        const btnVoltar = document.getElementById('extensao-parceiros-voltar');

                        if (btnNovo) {
                            btnNovo.addEventListener('click', async () => {
                                await exibirModalFormParceiro(null);
                                renderizarLista();
                            });
                        }

                        if (btnVoltar) {
                            btnVoltar.addEventListener('click', () => {
                                if (document.body.contains(modal)) {
                                    document.body.removeChild(modal);
                                }
                                exibirModalConfiguracaoWhatsApp();
                                resolve(true);
                            });
                        }

                        // Botões de editar
                        document.querySelectorAll('.extensao-btn-editar-parceiro').forEach(btn => {
                            btn.addEventListener('click', async () => {
                                const id = btn.dataset.id;
                                const parceiro = parceiros.find(p => p.id == id);
                                if (parceiro) {
                                    await exibirModalFormParceiro(parceiro);
                                    renderizarLista();
                                }
                            });
                        });

                        // Botões de excluir
                        document.querySelectorAll('.extensao-btn-excluir-parceiro').forEach(btn => {
                            btn.addEventListener('click', async () => {
                                const id = btn.dataset.id;
                                if (confirm('Deseja realmente excluir este parceiro?')) {
                                    try {
                                        const token = await obterTokenAuth();
                                        await fazerRequisicao(`${API_BASE_URL}/parceiros/${id}`, {
                                            method: 'DELETE',
                                            headers: { 'Authorization': `Bearer ${token}` }
                                        });
                                        mostrarToast('Parceiro excluído com sucesso', 'success');
                                        renderizarLista();
                                    } catch (error) {
                                        mostrarToast('Erro ao excluir parceiro', 'error');
                                    }
                                }
                            });
                        });

                        // Botões de copiar etiqueta
                        document.querySelectorAll('.extensao-btn-copiar-etiqueta').forEach(btn => {
                            btn.addEventListener('click', () => {
                                const etiqueta = btn.dataset.etiqueta;
                                navigator.clipboard.writeText(etiqueta).then(() => {
                                    btn.textContent = 'Copiado!';
                                    btn.style.background = '#22C55E';
                                    setTimeout(() => {
                                        btn.textContent = 'Copiar';
                                        btn.style.background = '#F59E0B';
                                    }, 2000);
                                });
                            });
                        });
                    }, 50);

                } catch (error) {
                    console.error('[Extensão] Erro ao listar parceiros:', error);
                    content.innerHTML = `
                        <h2 class="extensao-title">Gerenciar Parceiros</h2>
                        <div style="padding: 20px; text-align: center; color: #991B1B;">
                            Erro ao carregar parceiros: ${error.message}
                        </div>
                        <button id="extensao-parceiros-voltar" class="extensao-btn-secondary" style="width: 100%; margin-top: 16px;">Voltar</button>
                    `;
                    setTimeout(() => {
                        document.getElementById('extensao-parceiros-voltar')?.addEventListener('click', () => {
                            if (document.body.contains(modal)) document.body.removeChild(modal);
                            exibirModalConfiguracaoWhatsApp();
                            resolve(false);
                        });
                    }, 50);
                }
            };

            renderizarLista();
            modal.appendChild(content);
            document.body.appendChild(modal);
        });
    }

    // ===== FUNÇÃO: MODAL FORMULÁRIO PARCEIRO (CRIAR/EDITAR) =====
    async function exibirModalFormParceiro(parceiroExistente = null) {
        return new Promise((resolve) => {
            fecharTodosModais();

            const isEdit = !!parceiroExistente;
            const modal = document.createElement('div');
            modal.id = 'extensao-form-parceiro-modal';
            modal.className = 'extensao-modal';

            const content = document.createElement('div');
            content.className = 'extensao-modal-content';
            content.style.maxWidth = '500px';

            const p = parceiroExistente || {};

            content.innerHTML = `
                <h2 class="extensao-title" style="margin-bottom: 16px; font-size: 18px;">${isEdit ? 'Editar Parceiro' : 'Novo Parceiro'}</h2>
                
                <form id="extensao-form-parceiro" style="display: flex; flex-direction: column; gap: 12px;">
                    <!-- Nome da Etiqueta -->
                    <div>
                        <label style="display: block; font-size: 13px; font-weight: 600; color: #1F2937; margin-bottom: 6px;">
                            Nome da Etiqueta <span style="color: #DC2626;">*</span>
                        </label>
                        <input 
                            type="text" 
                            id="parceiro-nome-etiqueta"
                            placeholder="Ex: JOAO, MARIA_SILVA, PARCEIRO01"
                            class="extensao-input-modern"
                            style="width: 100%; text-transform: uppercase;"
                            value="${p.nomeEtiqueta || ''}"
                            ${isEdit ? 'readonly style="background: #F3F4F6; cursor: not-allowed;"' : ''}
                            maxlength="50"
                        >
                        <small style="color: #6B7280; font-size: 11px;">Apenas letras, números e underscore. Será usada como PARCEIRO:NOME</small>
                    </div>

                    <!-- Nome Completo (opcional) -->
                    <div>
                        <label style="display: block; font-size: 13px; font-weight: 600; color: #1F2937; margin-bottom: 6px;">
                            Nome Completo (opcional)
                        </label>
                        <input 
                            type="text" 
                            id="parceiro-nome-completo"
                            placeholder="Ex: João da Silva"
                            class="extensao-input-modern"
                            style="width: 100%;"
                            value="${p.nomeCompleto || ''}"
                        >
                    </div>

                    <!-- Telefone -->
                    <div>
                        <label style="display: block; font-size: 13px; font-weight: 600; color: #1F2937; margin-bottom: 6px;">
                            Telefone WhatsApp <span style="color: #DC2626;">*</span>
                        </label>
                        <input 
                            type="text" 
                            id="parceiro-telefone"
                            placeholder="5577988887777"
                            class="extensao-input-modern extensao-whatsapp-input"
                            style="width: 100%;"
                            value="${p.telefone || ''}"
                            maxlength="13"
                        >
                        <small style="color: #6B7280; font-size: 11px;">Formato: código do país + DDD + número</small>
                    </div>

                    <!-- Email (opcional) -->
                    <div>
                        <label style="display: block; font-size: 13px; font-weight: 600; color: #1F2937; margin-bottom: 6px;">
                            Email (opcional)
                        </label>
                        <input 
                            type="email" 
                            id="parceiro-email"
                            placeholder="parceiro@email.com"
                            class="extensao-input-modern"
                            style="width: 100%;"
                            value="${p.email || ''}"
                        >
                    </div>

                    <!-- Notificações por Status -->
                    <div style="padding: 12px; background: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 8px;">
                        <label style="display: block; font-size: 13px; font-weight: 600; color: #1F2937; margin-bottom: 10px;">
                            Notificar quando houver:
                        </label>
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                            <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
                                <input type="checkbox" id="parceiro-notif-exigencia" ${p.notificarExigencia !== false ? 'checked' : ''} style="accent-color: #22C55E;">
                                <span style="font-size: 12px;">Exigências</span>
                            </label>
                            <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
                                <input type="checkbox" id="parceiro-notif-deferido" ${p.notificarDeferido !== false ? 'checked' : ''} style="accent-color: #22C55E;">
                                <span style="font-size: 12px;">Deferimentos</span>
                            </label>
                            <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
                                <input type="checkbox" id="parceiro-notif-indeferido" ${p.notificarIndeferido !== false ? 'checked' : ''} style="accent-color: #22C55E;">
                                <span style="font-size: 12px;">Indeferimentos</span>
                            </label>
                            <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
                                <input type="checkbox" id="parceiro-notif-agendamento" ${p.notificarAgendamento !== false ? 'checked' : ''} style="accent-color: #22C55E;">
                                <span style="font-size: 12px;">Agendamentos</span>
                            </label>
                            <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
                                <input type="checkbox" id="parceiro-notif-analise" ${p.notificarEmAnalise === true ? 'checked' : ''} style="accent-color: #22C55E;">
                                <span style="font-size: 12px;">Em Análise</span>
                            </label>
                        </div>
                    </div>

                    <!-- Opções de Conteúdo -->
                    <div style="padding: 12px; background: #FEF3C7; border: 1px solid #FDE68A; border-radius: 8px;">
                        <label style="display: block; font-size: 13px; font-weight: 600; color: #92400E; margin-bottom: 10px;">
                            Incluir na mensagem:
                        </label>
                        <div style="display: flex; flex-direction: column; gap: 6px;">
                            <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
                                <input type="checkbox" id="parceiro-incluir-comprovantes" ${p.incluirComprovantes !== false ? 'checked' : ''} style="accent-color: #F59E0B;">
                                <span style="font-size: 12px;">Links de comprovantes/documentos</span>
                            </label>
                            <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
                                <input type="checkbox" id="parceiro-incluir-ia" ${p.incluirAnaliseIA !== false ? 'checked' : ''} style="accent-color: #F59E0B;">
                                <span style="font-size: 12px;">Análise de IA (motivo indeferimento, etc.)</span>
                            </label>
                            <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
                                <input type="checkbox" id="parceiro-incluir-link" ${p.incluirLinkProcesso === true ? 'checked' : ''} style="accent-color: #F59E0B;">
                                <span style="font-size: 12px;">Link do processo no Tramitação</span>
                            </label>
                        </div>
                    </div>

                    <!-- Ativo -->
                    <div style="padding: 12px; background: #F0FDF4; border: 1px solid #86EFAC; border-radius: 8px;">
                        <label style="display: flex; align-items: center; gap: 10px; cursor: pointer;">
                            <input type="checkbox" id="parceiro-ativo" ${p.ativo !== false ? 'checked' : ''} style="width: 18px; height: 18px; accent-color: #22C55E;">
                            <span style="font-weight: 600; color: #166534; font-size: 13px;">Parceiro Ativo</span>
                        </label>
                        <small style="color: #6B7280; font-size: 11px; margin-left: 28px;">Desmarque para pausar notificações</small>
                    </div>

                    <!-- Observações -->
                    <div>
                        <label style="display: block; font-size: 13px; font-weight: 600; color: #1F2937; margin-bottom: 6px;">
                            Observações (opcional)
                        </label>
                        <textarea 
                            id="parceiro-observacoes"
                            placeholder="Anotações internas sobre este parceiro..."
                            class="extensao-input-modern"
                            style="width: 100%; min-height: 60px; resize: vertical;"
                        >${p.observacoes || ''}</textarea>
                    </div>

                    <div id="extensao-form-parceiro-error" style="display: none; color: #991B1B; padding: 10px; background: #FEE2E2; border-radius: 6px; font-size: 12px;"></div>

                    <div class="extensao-flex-row" style="margin-top: 8px;">
                        <button type="submit" class="extensao-btn-primary">${isEdit ? 'Salvar Alterações' : 'Criar Parceiro'}</button>
                        <button type="button" id="extensao-form-parceiro-cancel" class="extensao-btn-secondary">Cancelar</button>
                    </div>
                </form>
            `;

            modal.appendChild(content);
            document.body.appendChild(modal);

            // Event listeners
            setTimeout(() => {
                const form = document.getElementById('extensao-form-parceiro');
                const cancelBtn = document.getElementById('extensao-form-parceiro-cancel');
                const errorDiv = document.getElementById('extensao-form-parceiro-error');
                const nomeEtiquetaInput = document.getElementById('parceiro-nome-etiqueta');
                const telefoneInput = document.getElementById('parceiro-telefone');

                // Validação em tempo real do telefone
                if (telefoneInput) {
                    telefoneInput.addEventListener('input', () => {
                        telefoneInput.value = telefoneInput.value.replace(/\D/g, '');
                    });
                }

                // Validação em tempo real do nome da etiqueta
                if (nomeEtiquetaInput && !isEdit) {
                    nomeEtiquetaInput.addEventListener('input', () => {
                        nomeEtiquetaInput.value = nomeEtiquetaInput.value.toUpperCase().replace(/[^A-Z0-9_]/g, '').replace(/\s+/g, '_');
                    });
                }

                if (cancelBtn) {
                    cancelBtn.addEventListener('click', () => {
                        if (document.body.contains(modal)) document.body.removeChild(modal);
                        resolve(false);
                    });
                }

                if (form) {
                    form.addEventListener('submit', async (e) => {
                        e.preventDefault();
                        if (errorDiv) errorDiv.style.display = 'none';

                        const nomeEtiqueta = document.getElementById('parceiro-nome-etiqueta')?.value.trim();
                        const telefone = document.getElementById('parceiro-telefone')?.value.replace(/\D/g, '').trim();

                        // Validações
                        if (!nomeEtiqueta) {
                            errorDiv.textContent = 'Nome da etiqueta é obrigatório';
                            errorDiv.style.display = 'block';
                            return;
                        }

                        if (!/^[A-Z0-9_]+$/.test(nomeEtiqueta)) {
                            errorDiv.textContent = 'Nome da etiqueta deve conter apenas letras, números e underscore';
                            errorDiv.style.display = 'block';
                            return;
                        }

                        if (!telefone || telefone.length < 10 || telefone.length > 13) {
                            errorDiv.textContent = 'Telefone inválido. Use formato: 5577988887777';
                            errorDiv.style.display = 'block';
                            return;
                        }

                        const dados = {
                            nomeEtiqueta,
                            nomeCompleto: document.getElementById('parceiro-nome-completo')?.value.trim() || null,
                            telefone,
                            email: document.getElementById('parceiro-email')?.value.trim() || null,
                            notificarExigencia: document.getElementById('parceiro-notif-exigencia')?.checked,
                            notificarDeferido: document.getElementById('parceiro-notif-deferido')?.checked,
                            notificarIndeferido: document.getElementById('parceiro-notif-indeferido')?.checked,
                            notificarAgendamento: document.getElementById('parceiro-notif-agendamento')?.checked,
                            notificarEmAnalise: document.getElementById('parceiro-notif-analise')?.checked,
                            incluirComprovantes: document.getElementById('parceiro-incluir-comprovantes')?.checked,
                            incluirAnaliseIA: document.getElementById('parceiro-incluir-ia')?.checked,
                            incluirLinkProcesso: document.getElementById('parceiro-incluir-link')?.checked,
                            ativo: document.getElementById('parceiro-ativo')?.checked,
                            observacoes: document.getElementById('parceiro-observacoes')?.value.trim() || null
                        };

                        try {
                            const token = await obterTokenAuth();
                            if (!token) {
                                errorDiv.textContent = 'É necessário fazer login primeiro';
                                errorDiv.style.display = 'block';
                                return;
                            }

                            const url = isEdit ? `${API_BASE_URL}/parceiros/${parceiroExistente.id}` : `${API_BASE_URL}/parceiros`;
                            const method = isEdit ? 'PUT' : 'POST';

                            const response = await fazerRequisicao(url, {
                                method,
                                headers: {
                                    'Authorization': `Bearer ${token}`,
                                    'Content-Type': 'application/json'
                                },
                                body: JSON.stringify(dados)
                            });

                            const result = await response.json();

                            if (result.success) {
                                mostrarToast(isEdit ? 'Parceiro atualizado!' : 'Parceiro criado!', 'success');
                                if (document.body.contains(modal)) document.body.removeChild(modal);
                                resolve(true);
                            } else {
                                errorDiv.textContent = result.message || 'Erro ao salvar parceiro';
                                errorDiv.style.display = 'block';
                            }
                        } catch (error) {
                            console.error('[Extensão] Erro ao salvar parceiro:', error);
                            errorDiv.textContent = 'Erro ao salvar: ' + error.message;
                            errorDiv.style.display = 'block';
                        }
                    });
                }
            }, 50);
        });
    }

    async function mostrarOpcoesAposLogin(btnSincronizar) {
        return new Promise((resolve) => {
            // Fechar todos os modais antes de abrir este
            fecharTodosModais();

            const modal = document.createElement('div');
            modal.id = 'extensao-opcoes-modal';
            modal.className = 'extensao-modal';

            const content = document.createElement('div');
            content.id = 'extensao-opcoes-content';
            content.className = 'extensao-modal-content';

            obterConfiguracoes().then(configs => {
                // ⚠️ SEGURANÇA: Verificar apenas flags booleanos, não valores reais
                const temConfig = configs && (configs.temGeminiApiKey || configs.temTramitacaoApiToken);

                content.innerHTML = `
                    <h2 class="extensao-title">O que deseja fazer?</h2>
                    <div style="display: flex; flex-direction: column; gap: 12px;">
                        ${!temConfig ? `
                            <button 
                                id="extensao-opcoes-config"
                                class="extensao-btn-primary"
                            >
                                Configurar Credenciais
                            </button>
                        ` : ''}
                        <button 
                            id="extensao-opcoes-sincronizar"
                            class="extensao-btn-primary"
                        >
                            ${temConfig ? 'Sincronizar Agora' : 'Sincronizar (sem configurar)'}
                        </button>
                        ${temConfig ? `
                            <button 
                                id="extensao-opcoes-reconfig"
                                class="extensao-btn-secondary"
                            >
                                Alterar Configurações
                            </button>
                        ` : ''}
                        <button 
                            id="extensao-opcoes-cancel"
                            class="extensao-btn-secondary"
                        >
                            Cancelar
                        </button>
                    </div>
                `;

                setTimeout(() => {
                    const btnConfig = document.getElementById('extensao-opcoes-config');
                    const btnSincronizarOpcao = document.getElementById('extensao-opcoes-sincronizar');
                    const btnReconfig = document.getElementById('extensao-opcoes-reconfig');
                    const btnCancel = document.getElementById('extensao-opcoes-cancel');

                    if (btnConfig) {
                        btnConfig.addEventListener('click', async () => {
                            if (document.body.contains(modal)) {
                                document.body.removeChild(modal);
                            }
                            await exibirModalConfiguracoes();
                            resolve(true);
                        });
                    }

                    if (btnSincronizarOpcao) {
                        btnSincronizarOpcao.addEventListener('click', async () => {
                            if (document.body.contains(modal)) {
                                document.body.removeChild(modal);
                            }
                            await sincronizarInss(btnSincronizar);
                            resolve(true);
                        });
                    }

                    if (btnReconfig) {
                        btnReconfig.addEventListener('click', async () => {
                            if (document.body.contains(modal)) {
                                document.body.removeChild(modal);
                            }
                            await exibirModalConfiguracoes();
                            resolve(true);
                        });
                    }

                    if (btnCancel) {
                        btnCancel.addEventListener('click', () => {
                            if (document.body.contains(modal)) {
                                document.body.removeChild(modal);
                            }
                            resolve(false);
                        });
                    }

                    modal.addEventListener('click', (e) => {
                        if (e.target === modal) {
                            if (document.body.contains(modal)) {
                                document.body.removeChild(modal);
                            }
                            resolve(false);
                        }
                    });
                }, 10);
            });

            modal.appendChild(content);
            document.body.appendChild(modal);
        });
    }

    function criarBotaoSincronizar() {
        // Verificar se o botão já existe
        if (document.getElementById('btn-sincronizar-inss')) {
            return;
        }

        // Tentar múltiplos seletores para encontrar o botão "Novo"
        let botaoNovo = document.querySelector('button[data-test="new_menu_btn"]');

        // Fallback: procurar por botão que contenha "Novo" no texto
        if (!botaoNovo) {
            const botoes = document.querySelectorAll('button');
            for (const btn of botoes) {
                const texto = btn.textContent?.trim() || '';
                if (texto.toLowerCase().includes('novo') && texto.length < 20) {
                    botaoNovo = btn;
                    console.log('[Extensão] Botão "Novo" encontrado via fallback:', texto);
                    break;
                }
            }
        }

        // Fallback 2: procurar por container comum de botões (toolbar, header, etc)
        let container = null;
        if (botaoNovo) {
            container = botaoNovo.parentElement;
        } else {
            // Tentar encontrar container comum onde botões são colocados
            const possiveisContainers = [
                'header',
                '.toolbar',
                '.header',
                '.actions',
                '.btn-group',
                '[class*="toolbar"]',
                '[class*="header"]',
                '[class*="actions"]'
            ];

            for (const seletor of possiveisContainers) {
                const el = document.querySelector(seletor);
                if (el) {
                    container = el;
                    console.log('[Extensão] Container encontrado via fallback:', seletor);
                    break;
                }
            }
        }

        if (!container) {
            console.warn('[Extensão] Container não encontrado. Tentando adicionar ao body...');
            // Último recurso: adicionar ao body no topo
            container = document.body;
        }

        if (!container) {
            console.error('[Extensão] Não foi possível encontrar um container para o botão');
            return;
        }

        const btnSincronizar = document.createElement('button');
        btnSincronizar.id = 'btn-sincronizar-inss';
        btnSincronizar.type = 'button';
        btnSincronizar.className = 'btn';
        btnSincronizar.style.cssText = 'margin-top: 8px; margin-right: 8px; position: relative; background: #fffff0; color: hsl(50, 91%, 22%); border: 1px solid #fffff0; border-radius: 0.25em; padding: 6px 12px; font-weight: 600; font-size: 13px; cursor: pointer; transition: background-color 0.2s, border-color 0.2s;';
        btnSincronizar.innerHTML = `
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: middle; margin-right: 6px;">
                <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"></path>
            </svg>
            Sincronizar (INSS)
        `;
        btnSincronizar.onmouseover = function () { this.style.background = '#f5f5e6'; this.style.borderColor = '#f5f5e6'; };
        btnSincronizar.onmouseout = function () { this.style.background = '#e9c61c'; this.style.borderColor = '#e9c61c'; };

        // Verificar autenticação e adicionar indicador visual
        // Garantir que API_BASE_URL está inicializado antes de verificar
        (async () => {
            try {
                // Garantir que a URL da API está inicializada
                if (!API_BASE_URL) {
                    await inicializarUrlApi();
                }

                const autenticado = await verificarAutenticacao();
                if (autenticado) {
                    // Adicionar badge verde indicando que está logado
                    const badge = document.createElement('span');
                    badge.id = 'extensao-login-badge';
                    badge.style.cssText = `
                        position: absolute;
                        top: -4px;
                        right: -4px;
                        width: 12px;
                        height: 12px;
                        background: #10B981;
                        border: 2px solid white;
                        border-radius: 50%;
                        box-shadow: 0 0 0 1px rgba(16, 185, 129, 0.2);
                    `;
                    badge.title = 'Logado e pronto para sincronizar';
                    btnSincronizar.appendChild(badge);
                    console.log('[Extensão] Usuário autenticado - login persistente ativo');
                } else {
                    console.log('[Extensão] Usuário não autenticado - login será solicitado');
                }
            } catch (error) {
                console.warn('[Extensão] Erro ao verificar autenticação:', error);
            }
        })();

        btnSincronizar.addEventListener('click', async () => {
            try {
                // Garantir que API_BASE_URL está inicializado
                if (!API_BASE_URL) {
                    await inicializarUrlApi();
                }

                const autenticado = await verificarAutenticacao();
                if (!autenticado) {
                    // Verificar e configurar URL da API antes do login
                    try {
                        await verificarEConfigurarApiUrl();
                    } catch (error) {
                        mostrarToast('Erro ao configurar URL da API: ' + error.message, 'error', 8000);
                        return;
                    }

                    const loginOk = await exibirModalLogin();
                    if (!loginOk) {
                        return;
                    }
                    // Adicionar badge após login bem-sucedido
                    if (!document.getElementById('extensao-login-badge')) {
                        const badge = document.createElement('span');
                        badge.id = 'extensao-login-badge';
                        badge.style.cssText = `
                            position: absolute;
                            top: -4px;
                            right: -4px;
                            width: 12px;
                            height: 12px;
                            background: #10B981;
                            border: 2px solid white;
                            border-radius: 50%;
                            box-shadow: 0 0 0 1px rgba(16, 185, 129, 0.2);
                        `;
                        badge.title = 'Logado e pronto para sincronizar';
                        btnSincronizar.appendChild(badge);
                    }
                }

                await mostrarOpcoesAposLogin(btnSincronizar);
            } catch (error) {
                console.error('[Extensão] ❌ Erro ao processar clique no botão:', error);
                mostrarToast('Erro ao processar ação. Verifique o console para mais detalhes.', 'error');
            }
        });

        // Inserir o botão no container
        if (botaoNovo && botaoNovo.parentElement === container) {
            container.insertBefore(btnSincronizar, botaoNovo);
        } else {
            // Se não encontrou o botão "Novo", adicionar no início do container
            if (container.firstChild) {
                container.insertBefore(btnSincronizar, container.firstChild);
            } else {
                container.appendChild(btnSincronizar);
            }
        }

        console.log('[Extensão] ✅ Botão de sincronização criado e adicionado à página');
    }

    const intervalosAtivos = new Map();

    async function sincronizarInss(btn) {
        try {
            btn.disabled = true;
            btn.innerHTML = `
                <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide-icon-inline sw-2">
                    <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"></path>
                </svg>
                Sincronizando...
            `;

            // ⚠️ SEGURANÇA: Verificação de configurações movida para o backend
            // Frontend apenas envia requisição, backend valida se tem credenciais

            let tokenPat;
            try {
                tokenPat = await obterTokenPat();
            } catch (error) {
                mostrarToast(`Erro ao obter token PAT: ${error.message}`, 'error', 8000);
                resetarBotao(btn);
                return;
            }

            if (!tokenPat) {
                mostrarToast('Token PAT não encontrado!', 'error');
                resetarBotao(btn);
                return;
            }

            const token = await obterTokenAuth();
            let forcarExecucao = false;
            let response;
            let data;

            try {
                response = await fazerRequisicao(`${API_BASE_URL}/inss/sincronizar`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({
                        tokenPat: tokenPat,
                        forcarExecucao: forcarExecucao
                    })
                });

                data = await response.json();
            } catch (error) {
                if (error.message && error.message.includes('Já existe uma sincronização')) {
                    const querForcar = await mostrarConfirmacao(
                        'Sincronização já em andamento',
                        'Já existe uma sincronização em andamento hoje.\n\n' +
                        'Deseja forçar uma nova execução?\n\n' +
                        '⚠️ Isso pode causar processamento duplicado.',
                        { textoConfirmar: 'Forçar Execução', textoCancelar: 'Cancelar', tipo: 'warning' }
                    );

                    if (querForcar) {
                        response = await fazerRequisicao(`${API_BASE_URL}/inss/sincronizar`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${token}`
                            },
                            body: JSON.stringify({
                                tokenPat: tokenPat,
                                forcarExecucao: true
                            })
                        });
                        data = await response.json();
                    } else {
                        throw error;
                    }
                } else {
                    throw error;
                }
            }

            if (data.success) {
                const jobId = data.jobId;
                const periodo = `${new Date(data.dataInicio).toLocaleDateString('pt-BR')} a ${new Date(data.dataFim).toLocaleDateString('pt-BR')}`;

                criarBarraProgresso(jobId, { total: 0, processados: 0, sucesso: 0, erros: 0 });

                mostrarToast(
                    `Sincronização iniciada!\nPeríodo: ${periodo}`,
                    'success',
                    5000
                );

                acompanharSincronizacao(jobId, btn);
            } else {
                let mensagemErro = data.message || 'Erro desconhecido';

                if (mensagemErro.includes('Já existe uma sincronização') || mensagemErro.includes('em andamento')) {
                    const querForcar = await mostrarConfirmacao(
                        'Sincronização já em andamento',
                        mensagemErro + '\n\n' +
                        'Deseja forçar uma nova execução?\n\n' +
                        '⚠️ Isso pode causar processamento duplicado.',
                        { textoConfirmar: 'Forçar Execução', textoCancelar: 'Cancelar', tipo: 'warning' }
                    );

                    if (querForcar) {
                        try {
                            const responseForcar = await fazerRequisicao(`${API_BASE_URL}/inss/sincronizar`, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Authorization': `Bearer ${token}`
                                },
                                body: JSON.stringify({
                                    tokenPat: tokenPat,
                                    forcarExecucao: true
                                })
                            });
                            const dataForcar = await responseForcar.json();

                            if (dataForcar.success) {
                                const jobId = dataForcar.jobId;
                                const periodo = `${new Date(dataForcar.dataInicio).toLocaleDateString('pt-BR')} a ${new Date(dataForcar.dataFim).toLocaleDateString('pt-BR')}`;
                                criarBarraProgresso(jobId, { total: 0, processados: 0, sucesso: 0, erros: 0 });
                                mostrarToast(`Sincronização forçada iniciada!\nPeríodo: ${periodo}`, 'success', 5000);
                                acompanharSincronizacao(jobId, btn);
                                return;
                            } else {
                                mostrarToast(`Erro ao forçar sincronização: ${dataForcar.message}`, 'error', 10000);
                            }
                        } catch (errorForcar) {
                            mostrarToast(`Erro ao forçar sincronização: ${errorForcar.message}`, 'error', 10000);
                        }
                    }
                } else if (mensagemErro.includes('token') || mensagemErro.includes('autenticação') || mensagemErro.includes('login') || mensagemErro.includes('PAT')) {
                    // ⚠️ SEGURANÇA: Token PAT não é mais armazenado no client-side
                    // Removido - token é gerenciado apenas no backend
                    mostrarToast(
                        'Token PAT inválido ou expirado!\n\n' +
                        'O token que você forneceu não está funcionando.\n' +
                        'Por favor, faça login no PAT novamente quando sincronizar.',
                        'error',
                        12000
                    );
                } else if (mensagemErro.includes('obrigatório') || mensagemErro.includes('PAT é obrigatório')) {
                    mostrarToast(
                        'Token PAT não encontrado!\n\n' +
                        'Por favor, faça login no PAT primeiro.',
                        'error',
                        10000
                    );
                } else {
                    mostrarToast(`Erro ao iniciar sincronização: ${mensagemErro}`, 'error', 10000);
                }

                resetarBotao(btn);
            }
        } catch (error) {
            console.error('[Extensão] Erro:', error);
            mostrarToast(`Erro ao sincronizar: ${error.message}`, 'error', 8000);
            resetarBotao(btn);
        }
    }

    function criarBarraProgresso(jobId, progresso) {
        const { total, processados, sucesso, erros } = progresso;
        const percentual = total > 0 ? Math.round((processados / total) * 100) : 0;

        let containerProgresso = document.getElementById('extensao-progresso-container');
        if (!containerProgresso) {
            containerProgresso = document.createElement('div');
            containerProgresso.id = 'extensao-progresso-container';
            containerProgresso.style.cssText = `
                position: fixed;
                top: 70px;
                right: 20px;
                width: 320px;
                background-color: var(--light-yellow, #fdf9ed);
                border: 1px solid rgba(0,0,0,0.125);
                border-radius: 8px;
                padding: 16px;
                box-shadow: 0 0.125rem 0.25rem rgba(0,0,0,0.075);
                z-index: 10000;
                font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
                transition: box-shadow 0.3s ease, border-color 0.3s ease;
            `;

            const titulo = document.createElement('div');
            titulo.style.cssText = `
                font-weight: 600;
                font-size: 14px;
                color: var(--yellow-900, hsl(50, 91%, 22%));
                margin-bottom: 12px;
                display: flex;
                align-items: center;
                gap: 8px;
            `;
            titulo.innerHTML = `
                <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"></path>
                </svg>
                Sincronizando INSS...
            `;
            containerProgresso.appendChild(titulo);

            const barraWrapper = document.createElement('div');
            barraWrapper.id = 'extensao-progresso-barra-wrapper';
            barraWrapper.style.cssText = `
                position: relative;
                width: 100%;
                height: 24px;
                background-color: var(--yellow-100, #fefcf6);
                border: 1px solid var(--yellow-600, #e9c61c);
                border-radius: 4px;
                overflow: hidden;
                margin-bottom: 8px;
                cursor: help;
            `;

            const barra = document.createElement('div');
            barra.id = 'extensao-progresso-barra';
            barra.style.cssText = `
                height: 100%;
                background: linear-gradient(90deg, var(--yellow-600, #e9c61c) 0%, var(--gold, #f5f5e6) 100%);
                border-radius: 3px;
                transition: width 0.3s ease;
                display: flex;
                align-items: center;
                justify-content: center;
                color: var(--yellow-900, hsl(50, 91%, 22%));
                font-size: 11px;
                font-weight: 600;
                white-space: nowrap;
            `;
            barraWrapper.appendChild(barra);

            const tooltip = document.createElement('div');
            tooltip.id = 'extensao-progresso-tooltip';
            tooltip.style.cssText = `
                position: absolute;
                bottom: calc(100% + 8px);
                left: 50%;
                transform: translateX(-50%);
                padding: 10px 14px;
                background-color: var(--yellow-900, hsl(50, 91%, 22%));
                color: #333;
                border-radius: 6px;
                font-size: 12px;
                white-space: normal;
                min-width: 200px;
                opacity: 0;
                pointer-events: none;
                transition: opacity 0.2s ease;
                z-index: 10001;
                box-shadow: 0 2px 8px rgba(0,0,0,0.2);
            `;
            tooltip.innerHTML = `
                <div style="font-weight: 600; margin-bottom: 6px; font-size: 13px;">Progresso da Sincronização</div>
                <div id="extensao-progresso-tooltip-content" style="line-height: 1.6;"></div>
            `;
            barraWrapper.appendChild(tooltip);

            const seta = document.createElement('div');
            seta.style.cssText = `
                position: absolute;
                bottom: -6px;
                left: 50%;
                transform: translateX(-50%);
                width: 0;
                height: 0;
                border-left: 6px solid transparent;
                border-right: 6px solid transparent;
                border-top: 6px solid var(--yellow-900, hsl(50, 91%, 22%));
            `;
            tooltip.appendChild(seta);

            barraWrapper.addEventListener('mouseenter', () => {
                tooltip.style.opacity = '1';
            });
            barraWrapper.addEventListener('mouseleave', () => {
                tooltip.style.opacity = '0';
            });

            containerProgresso.appendChild(barraWrapper);

            const detalhes = document.createElement('div');
            detalhes.id = 'extensao-progresso-detalhes';
            detalhes.style.cssText = `
                font-size: 12px;
                color: var(--yellow-700, hsl(50, 50%, 40%));
                display: flex;
                justify-content: space-between;
                gap: 12px;
            `;
            containerProgresso.appendChild(detalhes);

            document.body.appendChild(containerProgresso);
        }

        const barra = document.getElementById('extensao-progresso-barra');
        if (barra) {
            if (total === 0) {
                barra.style.width = '100%';
                barra.style.background = 'linear-gradient(90deg, var(--yellow-100, #fefcf6) 0%, var(--yellow-50, hsl(49, 100%, 97%)) 100%)';
                barra.textContent = 'Aguardando...';
            } else {
                barra.style.background = 'linear-gradient(90deg, var(--yellow-600, #e9c61c) 0%, var(--gold, #f5f5e6) 100%)';
                barra.style.width = `${percentual}%`;
                barra.textContent = percentual > 5 ? `${percentual}%` : '';
            }
        }

        const tooltipContent = document.getElementById('extensao-progresso-tooltip-content');
        if (tooltipContent) {
            if (total === 0) {
                tooltipContent.innerHTML = `
                    <div style="opacity: 0.9; font-style: italic;">
                        Aguardando início do processamento...
                    </div>
                `;
            } else {
                const pendentes = total - processados;
                tooltipContent.innerHTML = `
                    <div style="margin-bottom: 4px;">
                        <span style="opacity: 0.9;">Processados:</span> 
                        <strong style="color: var(--gold, #f5f5e6);">${processados} de ${total}</strong>
                    </div>
                    <div style="margin-bottom: 4px;">
                        <span style="opacity: 0.9;">Sucesso:</span> 
                        <strong style="color: var(--color-green-100, rgb(215,247,194));">${sucesso}</strong>
                    </div>
                    <div style="margin-bottom: 4px;">
                        <span style="opacity: 0.9;">Erros:</span> 
                        <strong style="color: var(--red-100, #ffe3e3);">${erros}</strong>
                    </div>
                    ${pendentes > 0 ? `
                        <div style="margin-top: 6px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.2); font-size: 11px; opacity: 0.85;">
                            Pendentes: ${pendentes}
                        </div>
                    ` : ''}
                `;
            }
        }

        const detalhes = document.getElementById('extensao-progresso-detalhes');
        if (detalhes) {
            if (total === 0) {
                detalhes.innerHTML = `
                    <span style="font-style: italic; opacity: 0.7;">Iniciando sincronização...</span>
                `;
            } else {
                detalhes.innerHTML = `
                    <span>${processados}/${total}</span>
                    <span style="color: var(--color-green-600, rgb(5,105,13));">✓ ${sucesso}</span>
                    <span style="color: var(--red-700, #b73333);">✗ ${erros}</span>
                `;
            }
        }
    }

    function removerBarraProgresso() {
        const container = document.getElementById('extensao-progresso-container');
        if (container) {
            container.remove();
        }
    }

    function mostrarFeedbackFinal(resultado, tipo) {
        // Fechar todos os modais antes de abrir este
        fecharTodosModais();

        const modal = document.createElement('div');
        modal.id = 'extensao-feedback-modal';
        modal.className = 'extensao-modal';

        const content = document.createElement('div');
        content.className = 'extensao-modal-content';

        if (tipo === 'success') {
            const {
                protocolosProcessados = 0,
                clientesCriados = 0,
                clientesAtualizados = 0,
                notificacoesEnviadas = 0,
                erros = []
            } = resultado;

            content.innerHTML = `
                <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">
                    <div style="
                        width: 40px;
                        height: 40px;
                        border-radius: 50%;
                        background-color: #DCFCE7;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        flex-shrink: 0;
                    ">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#166534" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
                    </div>
                    <div>
                        <h2 class="extensao-title" style="margin: 0; font-size: 18px;">
                            Sincronização Concluída!
                        </h2>
                        <p style="margin: 4px 0 0 0; font-size: 13px; color: #6B7280;">
                            Processamento finalizado com sucesso
                        </p>
                    </div>
                </div>

                <div style="
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 8px;
                    margin-bottom: ${erros && erros.length > 0 ? '12px' : '16px'};
                ">
                    <div style="
                        padding: 10px;
                        background-color: #FEF3C7;
                        border-radius: 6px;
                        border-left: 3px solid #FCD34D;
                    ">
                        <div style="font-size: 11px; color: #92400E; margin-bottom: 4px; font-weight: 600;">
                            Protocolos
                        </div>
                        <div style="font-size: 18px; font-weight: 600; color: #78350F;">
                            ${protocolosProcessados}
                        </div>
                    </div>

                    <div style="
                        padding: 10px;
                        background-color: #DCFCE7;
                        border-radius: 6px;
                        border-left: 3px solid #10B981;
                    ">
                        <div style="font-size: 11px; color: #065F46; margin-bottom: 4px; font-weight: 600;">
                            Criados
                        </div>
                        <div style="font-size: 18px; font-weight: 600; color: #047857;">
                            ${clientesCriados}
                        </div>
                    </div>

                    <div style="
                        padding: 10px;
                        background-color: #DBEAFE;
                        border-radius: 6px;
                        border-left: 3px solid #3B82F6;
                    ">
                        <div style="font-size: 11px; color: #1E40AF; margin-bottom: 4px; font-weight: 600;">
                            Atualizados
                        </div>
                        <div style="font-size: 18px; font-weight: 600; color: #1E3A8A;">
                            ${clientesAtualizados}
                        </div>
                    </div>

                    <div style="
                        padding: 10px;
                        background-color: #FEF3C7;
                        border-radius: 6px;
                        border-left: 3px solid #FCD34D;
                    ">
                        <div style="font-size: 11px; color: #92400E; margin-bottom: 4px; font-weight: 600;">
                            Notificações
                        </div>
                        <div style="font-size: 18px; font-weight: 600; color: #78350F;">
                            ${notificacoesEnviadas}
                        </div>
                    </div>
                </div>

                ${erros && erros.length > 0 ? `
                    <div style="
                        padding: 10px;
                        background-color: #FEE2E2;
                        border-radius: 6px;
                        border-left: 3px solid #EF4444;
                        margin-bottom: 16px;
                    ">
                        <div style="font-size: 12px; font-weight: 600; color: #991B1B; margin-bottom: 6px;">
                            Erros: ${erros.length}
                        </div>
                        <div style="font-size: 11px; color: #991B1B; max-height: 80px; overflow-y: auto; line-height: 1.4;">
                            ${erros.slice(0, 3).map(erro => `<div style="margin-bottom: 3px;">• ${erro}</div>`).join('')}
                            ${erros.length > 3 ? `<div style="margin-top: 4px; font-style: italic; opacity: 0.8;">... e mais ${erros.length - 3} erro(s)</div>` : ''}
                        </div>
                    </div>
                ` : ''}

                <button 
                    id="extensao-feedback-fechar"
                    class="extensao-btn-primary"
                    style="width: 100%;"
                >
                    Fechar
                </button>
            `;
        } else {
            const erro = resultado.erro || 'Erro desconhecido';
            content.innerHTML = `
                <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">
                    <div style="
                        width: 40px;
                        height: 40px;
                        border-radius: 50%;
                        background-color: #FEE2E2;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        flex-shrink: 0;
                    ">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#991B1B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
                    </div>
                    <div>
                        <h2 class="extensao-title" style="margin: 0; font-size: 18px; color: #991B1B;">
                            Sincronização Falhou
                        </h2>
                        <p style="margin: 4px 0 0 0; font-size: 13px; color: #6B7280;">
                            Ocorreu um erro durante o processamento
                        </p>
                    </div>
                </div>

                <div style="
                    padding: 12px;
                    background-color: #FEE2E2;
                    border-radius: 6px;
                    border-left: 3px solid #EF4444;
                    margin-bottom: 16px;
                ">
                    <div style="font-size: 13px; color: #991B1B; white-space: pre-wrap; line-height: 1.5;">
                        ${erro}
                    </div>
                </div>

                <button 
                    id="extensao-feedback-fechar"
                    class="extensao-btn-secondary"
                    style="width: 100%; background: #EF4444; color: white; border-color: #EF4444;"
                    onmouseover="this.style.background='#DC2626'; this.style.borderColor='#DC2626';"
                    onmouseout="this.style.background='#EF4444'; this.style.borderColor='#EF4444';"
                >
                    Fechar
                </button>
            `;
        }

        modal.appendChild(content);
        document.body.appendChild(modal);

        const fechar = () => {
            modal.remove();
        };

        document.getElementById('extensao-feedback-fechar').addEventListener('click', fechar);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                fechar();
            }
        });

        if (tipo === 'success') {
            setTimeout(() => {
                if (document.getElementById('extensao-feedback-modal')) {
                    fechar();
                }
            }, 30000);
        }
    }

    async function acompanharSincronizacao(jobId, btn) {
        if (intervalosAtivos.has(jobId)) {
            clearInterval(intervalosAtivos.get(jobId));
            intervalosAtivos.delete(jobId);
        }

        let tentativas = 0;
        let errosConsecutivos = 0;
        const maxTentativas = 600; // 600 * 2s = 1200s = 20 minutos
        const maxErrosConsecutivos = 5;
        const intervalo = 2000;

        const intervaloId = setInterval(async () => {
            if (tentativas === 0) {
                intervalosAtivos.set(jobId, intervaloId);
            }
            tentativas++;

            try {
                const token = await obterTokenAuth();
                const response = await fazerRequisicao(`${API_BASE_URL}/inss/status/${jobId}`, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${token}`
                    }
                });

                if (response.status === 404) {
                    clearInterval(intervaloId);
                    intervalosAtivos.delete(jobId);
                    removerBarraProgresso();
                    mostrarToast('Job não encontrado ou backend não está respondendo. A sincronização pode ter sido cancelada.', 'error', 10000);
                    resetarBotao(btn);
                    return;
                }

                if (response.status === 502 || response.status === 503) {
                    errosConsecutivos++;
                    if (errosConsecutivos >= maxErrosConsecutivos) {
                        clearInterval(intervaloId);
                        intervalosAtivos.delete(jobId);
                        removerBarraProgresso();
                        mostrarToast('Backend não está respondendo. Verifique se o servidor está rodando.', 'error', 10000);
                        resetarBotao(btn);
                        return;
                    }
                    return;
                }

                if (!response.ok) {
                    errosConsecutivos++;
                    if (errosConsecutivos >= maxErrosConsecutivos || tentativas >= maxTentativas) {
                        clearInterval(intervaloId);
                        intervalosAtivos.delete(jobId);
                        removerBarraProgresso();
                        mostrarToast('Erro ao acompanhar sincronização. Verifique o status manualmente.', 'warning', 10000);
                        resetarBotao(btn);
                        return;
                    }
                    return;
                }

                errosConsecutivos = 0;

                const data = await response.json();

                if (tentativas % 10 === 0 || tentativas === 1) {
                    console.log('[Extensão] Status:', data.status?.status, 'Progresso:', data.status?.progress, 'Erro:', data.status?.erro);
                }

                if (!data.success || !data.status) {
                    if (tentativas >= maxTentativas) {
                        clearInterval(intervaloId);
                        intervalosAtivos.delete(jobId);
                        removerBarraProgresso();
                        mostrarToast('Não foi possível obter status da sincronização.', 'warning', 10000);
                        resetarBotao(btn);
                    }
                    return;
                }

                const status = data.status;

                if (status.status === 'pending') {
                    criarBarraProgresso(jobId, { total: 0, processados: 0, sucesso: 0, erros: 0 });
                    btn.innerHTML = `
                        <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide-icon-inline sw-2">
                            <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"></path>
                        </svg>
                        Aguardando início...
                    `;
                    return;
                }

                if (status.status === 'running') {
                    if (status.progress) {
                        const { total, processados, sucesso, erros } = status.progress;
                        const percentual = total > 0 ? Math.round((processados / total) * 100) : 0;

                        criarBarraProgresso(jobId, { total, processados, sucesso, erros });

                        btn.innerHTML = `
                            <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide-icon-inline sw-2">
                                <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"></path>
                            </svg>
                            Sincronizando... ${percentual}%
                        `;
                    } else {
                        criarBarraProgresso(jobId, { total: 0, processados: 0, sucesso: 0, erros: 0 });
                        btn.innerHTML = `
                            <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide-icon-inline sw-2">
                                <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"></path>
                            </svg>
                            Iniciando...
                        `;
                    }
                }

                if (status.status === 'completed') {
                    clearInterval(intervaloId);
                    intervalosAtivos.delete(jobId);
                    removerBarraProgresso();

                    const resultado = status.resultado || {};
                    mostrarFeedbackFinal(resultado, 'success');
                    resetarBotao(btn);
                } else if (status.status === 'failed') {
                    clearInterval(intervaloId);
                    intervalosAtivos.delete(jobId);
                    removerBarraProgresso();

                    let mensagemErro = status.erro || 'Erro desconhecido';

                    if (mensagemErro.includes('token') || mensagemErro.includes('autenticação') || mensagemErro.includes('login') || mensagemErro.includes('PAT')) {
                        // ⚠️ SEGURANÇA: Token PAT não é mais armazenado no client-side
                        // Removido - token é gerenciado apenas no backend
                        mensagemErro = 'Token PAT inválido ou expirado!\n\n' +
                            'O token que você forneceu não está funcionando.\n' +
                            'Por favor, faça login no PAT novamente quando sincronizar.';
                    } else if (mensagemErro.includes('Gemini') || mensagemErro.includes('API key')) {
                        mensagemErro = 'Erro na API do Gemini!\n\n' +
                            'Verifique se sua Gemini API Key está correta nas configurações.';
                    } else if (mensagemErro.includes('Tramitação') || mensagemErro.includes('tramitacao')) {
                        mensagemErro = 'Erro na API do Tramitação!\n\n' +
                            'Verifique se seu Token do Tramitação está correto nas configurações.';
                    }

                    mostrarFeedbackFinal({ erro: mensagemErro }, 'error');
                    resetarBotao(btn);
                }

                if (tentativas >= maxTentativas) {
                    clearInterval(intervaloId);
                    intervalosAtivos.delete(jobId);
                    removerBarraProgresso();
                    mostrarToast('Timeout: A sincronização está demorando muito. Verifique o status manualmente.', 'warning', 10000);
                    resetarBotao(btn);
                }
            } catch (error) {
                console.error('[Extensão] Erro ao verificar status:', error);
                errosConsecutivos++;

                if (errosConsecutivos >= maxErrosConsecutivos || tentativas >= maxTentativas) {
                    clearInterval(intervaloId);
                    intervalosAtivos.delete(jobId);
                    removerBarraProgresso();
                    const mensagem = errosConsecutivos >= maxErrosConsecutivos
                        ? 'Não foi possível conectar ao backend. Verifique se o servidor está rodando.'
                        : 'Timeout ao acompanhar sincronização. Verifique o status manualmente.';
                    mostrarToast(mensagem, 'error', 10000);
                    resetarBotao(btn);
                    return;
                }
            }
        }, intervalo);
    }

    function resetarBotao(btn) {
        btn.disabled = false;
        btn.innerHTML = `
            <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide-icon-inline sw-2">
                <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"></path>
            </svg>
            Sincronizar (INSS)
        `;
    }

    // Escutar mensagens do background
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'tokenPatCapturado') {
            console.log('[Extensão] Token PAT recebido do background');
            if (request.token) {
                // ⚠️ SEGURANÇA: Não armazenar token no client-side
                // Apenas enviar para o backend que salvará no banco
                atualizarPatToken(request.token).catch(error => {
                    console.error('[Extensão] Erro ao atualizar token PAT:', error);
                });
                // Atualizar UI se necessário
                const btn = document.getElementById('btn-sincronizar-inss');
                if (btn) {
                    // Feedback visual rápido
                    const originalText = btn.innerHTML;
                    btn.innerHTML = 'Token Capturado!';
                    setTimeout(() => {
                        if (btn.innerHTML === 'Token Capturado!') {
                            btn.innerHTML = originalText;
                        }
                    }, 2000);
                }
            }
        }

        if (request.action === 'patLoginConcluido') {
            mostrarToast(request.mensagem || 'Login do INSS concluído!', 'success');
        }

        // Handler para atualização disponível (modo manual)
        if (request.action === 'atualizacaoDisponivel') {
            const { version, downloadUrl, changelog } = request;
            mostrarToast(
                `🔄 Nova versão disponível: ${version}\n\nClique para baixar e instalar.`,
                'info',
                10000
            );

            // Criar botão de atualização
            setTimeout(() => {
                const atualizarBtn = document.createElement('button');
                atualizarBtn.textContent = `📥 Atualizar para v${version}`;
                atualizarBtn.style.cssText = `
                    position: fixed;
                    top: 80px;
                    right: 20px;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: #333;
                    border: none;
                    padding: 12px 24px;
                    border-radius: 8px;
                    cursor: pointer;
                    z-index: 10003;
                    font-weight: 600;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                `;
                atualizarBtn.onclick = () => {
                    window.open(downloadUrl, '_blank');
                };
                document.body.appendChild(atualizarBtn);

                setTimeout(() => {
                    if (document.body.contains(atualizarBtn)) {
                        atualizarBtn.remove();
                    }
                }, 30000);
            }, 2000);
        }

        // Handler para atualização pronta (auto-instalação)
        if (request.action === 'atualizacaoPronta') {
            const { version, downloadUrl } = request;
            mostrarToast(
                `✅ Atualização baixada! Versão ${version} pronta para instalação.\n\nUma nova aba será aberta com instruções.`,
                'success',
                8000
            );
        }

        // Handler para erro na atualização
        if (request.action === 'atualizacaoErro') {
            const { error } = request;
            mostrarToast(
                `❌ Erro ao atualizar: ${error}\n\nTente atualizar manualmente.`,
                'error',
                10000
            );
        }

        // Handler antigo (manter compatibilidade)
        if (request.action === 'atualizacaoDisponivel_OLD') {
            console.log('[Extensão] Nova versão disponível:', request.version);
            mostrarToast(
                `Nova versão disponível: ${request.version}. Clique aqui para atualizar.`,
                'info',
                10000
            );

            // Adicionar botão de atualização se necessário
            // Por enquanto, apenas notificar - atualização manual via download
        }
    });

    // ===== INICIALIZAÇÃO =====

    (async () => {
        try {
            console.log('[Extensão] Iniciando extensão...');
            await inicializarUrlApi();
            console.log('[Extensão] URL da API inicializada:', API_BASE_URL);

            // Função para tentar criar o botão com retry
            const tentarCriarBotao = () => {
                try {
                    criarBotaoSincronizar();
                } catch (error) {
                    console.error('[Extensão] Erro ao criar botão:', error);
                }
            };

            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => {
                    console.log('[Extensão] DOM carregado, criando botão...');
                    tentarCriarBotao();
                });
            } else {
                console.log('[Extensão] DOM já carregado, criando botão imediatamente...');
                tentarCriarBotao();
            }

            // Observer para detectar mudanças no DOM e recriar o botão se necessário
            const observer = new MutationObserver(() => {
                if (!document.getElementById('btn-sincronizar-inss')) {
                    console.log('[Extensão] Botão não encontrado, tentando recriar...');
                    tentarCriarBotao();
                }
            });

            if (document.body) {
                observer.observe(document.body, {
                    childList: true,
                    subtree: true
                });
            } else {
                // Se body ainda não existe, aguardar
                const bodyObserver = new MutationObserver(() => {
                    if (document.body) {
                        observer.observe(document.body, {
                            childList: true,
                            subtree: true
                        });
                        bodyObserver.disconnect();
                    }
                });
                bodyObserver.observe(document.documentElement, {
                    childList: true
                });
            }

            console.log('[Extensão] Extensão inicializada com sucesso');
        } catch (error) {
            console.error('[Extensão] Erro ao inicializar extensão:', error);
        }
    })();
}

// Export runContent to window
if (typeof window !== 'undefined') {
    window.runContent = runContent;
}
