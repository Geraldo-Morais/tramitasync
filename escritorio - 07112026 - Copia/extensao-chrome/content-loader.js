// content-loader.js - Proxy Isolado (Sem injeção DOM)
(function () {
    'use strict';

    let API_BASE_URL = null;
    const GIST_ID = '09c33aba43ad48e7f9c9932671a273b7';
    const GIST_DISCOVERY_URL = `https://gist.githubusercontent.com/Geraldo-Morais/${GIST_ID}/raw/ngrok-url.json`;
    const BRIDGE_ID = 'tramita_extension_bridge';

    // --- 1. CONFIGURAR LISTENERS (PROXY) ---
    
    // Escutar pedidos da Página (Main World) e repassar para Chrome APIs
    window.addEventListener(BRIDGE_ID + '_req', async (e) => {
        const { reqId, method, args } = e.detail;
        let result = null;
        let error = null;

        try {
            if (method === 'storage.local.get') {
                result = await chrome.storage.local.get(args[0]);
            } else if (method === 'storage.local.set') {
                await chrome.storage.local.set(args[0]);
                result = true;
            } else if (method === 'storage.local.remove') {
                await chrome.storage.local.remove(args[0]);
            } else if (method === 'runtime.sendMessage') {
                result = await chrome.runtime.sendMessage(args[0]);
            }
        } catch (err) {
            error = err.message || 'Erro na bridge';
        }

        // Devolver resposta para a página
        window.dispatchEvent(new CustomEvent(BRIDGE_ID + '_res', {
            detail: { reqId, result, error }
        }));
    });

    // Escutar mensagens do Background (Extensão) e repassar para a Página
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        // Disparar evento no DOM para a Bridge capturar
        window.dispatchEvent(new CustomEvent('tramita_background_msg', {
            detail: { message, sender: { id: sender.id, url: sender.url } }
        }));
        // Não precisamos esperar resposta da página por enquanto
    });

    // --- 2. CARREGAMENTO ---

    function fetchViaBackground(url) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ action: 'fetchResource', url }, (response) => {
                if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
                if (response && response.success) resolve(response.body);
                else reject(new Error(response?.error || 'Falha no fetch'));
            });
        });
    }

    async function detectarUrlBackend() {
        try {
            const responseGist = await fetch(GIST_DISCOVERY_URL + `?t=${Date.now()}`, { signal: AbortSignal.timeout(5000) });
            if (responseGist.ok) {
                const data = await responseGist.json();
                const url = data.apiUrl || data.url;
                if (url && url.startsWith('http')) {
                    API_BASE_URL = url;
                    await chrome.storage.local.set({ extensao_api_url: url });
                    return url;
                }
            }
        } catch (e) { console.error('[Loader] Gist error:', e); }
        
        const stored = await chrome.storage.local.get(['extensao_api_url']);
        if (stored.extensao_api_url) {
            API_BASE_URL = stored.extensao_api_url;
            return API_BASE_URL;
        }
        throw new Error('URL Backend não encontrada');
    }

    async function carregarCSS(baseUrl) {
        try {
            const css = await fetchViaBackground(`${baseUrl}/extensao/code/styles?t=${Date.now()}`);
            const style = document.createElement('style');
            style.textContent = css;
            document.head.appendChild(style);
            console.log('[Loader] CSS injetado');
        } catch (e) { console.error('[Loader] Erro CSS:', e); }
    }

    async function carregarCodigo(baseUrl) {
        try {
            const code = await fetchViaBackground(`${baseUrl}/extensao/code/content?t=${Date.now()}`);
            console.log('[Loader] Código baixado. Enviando para injeção...');
            
            // Pede ao background para injetar (incluindo a Bridge)
            chrome.runtime.sendMessage({
                action: 'injectCode',
                code: code,
                baseUrl: baseUrl
            });
        } catch (e) {
            console.error('[Loader] Erro Código:', e);
        }
    }

    async function inicializar() {
        await detectarUrlBackend();
        
        let url = API_BASE_URL.trim();
        if (url.endsWith('/')) url = url.slice(0, -1);
        if (!url.endsWith('/api/v1')) url += url.endsWith('/api') ? '/v1' : '/api/v1';

        await Promise.all([carregarCSS(url), carregarCodigo(url)]);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inicializar);
    else inicializar();
})();