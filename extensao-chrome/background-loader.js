// background-loader.js - Injeção via EVAL no MAIN world com Bridge Completa
console.log('[Background] Service worker iniciado');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    // 1. Fetch Proxy COMPLETO (para pular CORS - suporta GET, POST, PUT, DELETE, etc)
    if (message.action === 'fetchResource') {
        const fetchOptions = {
            method: message.method || 'GET',
            cache: 'no-cache',
            headers: {
                'Accept': 'application/json',
                'ngrok-skip-browser-warning': 'true',
                ...(message.headers || {})
            }
        };

        // Adicionar body se presente (para POST, PUT, PATCH)
        if (message.body) {
            fetchOptions.body = typeof message.body === 'string'
                ? message.body
                : JSON.stringify(message.body);
        }

        console.log(`[Background] Fetch Proxy: ${fetchOptions.method} ${message.url}`);

        fetch(message.url, fetchOptions)
            .then(async r => {
                const text = await r.text();
                return {
                    ok: r.ok,
                    status: r.status,
                    statusText: r.statusText,
                    text,
                    headers: Object.fromEntries(r.headers.entries())
                };
            })
            .then(result => {
                if (result.ok) {
                    sendResponse({
                        success: true,
                        body: result.text,
                        status: result.status,
                        headers: result.headers
                    });
                } else {
                    sendResponse({
                        success: false,
                        error: `HTTP ${result.status}: ${result.statusText}`,
                        body: result.text,
                        status: result.status
                    });
                }
            })
            .catch(err => {
                console.error('[Background] Fetch error:', err);
                sendResponse({ success: false, error: err.message });
            });
        return true;
    }

    // 2. Injetor de Código
    if (message.action === 'injectCode') {
        if (!sender.tab?.id) return;

        console.log('[Background] Preparando ambiente na tab:', sender.tab.id);

        chrome.scripting.executeScript({
            target: { tabId: sender.tab.id },
            world: 'MAIN', // Executa no contexto da página
            args: [message.code, message.baseUrl],
            func: (code, baseUrl) => {
                // --- 🌉 INÍCIO DA BRIDGE (DEFINIDA DENTRO DO EXECUTE SCRIPT) ---
                const BRIDGE_ID = 'tramita_extension_bridge';

                // Garantir que window.chrome existe
                window.chrome = window.chrome || {};

                // Helper para chamar a extensão (Página -> Content Script)
                window.__callExtension = function (method, args) {
                    return new Promise((resolve, reject) => {
                        const reqId = Math.random().toString(36).substring(2);
                        const handler = (e) => {
                            if (e.detail && e.detail.reqId === reqId) {
                                window.removeEventListener(BRIDGE_ID + '_res', handler);
                                if (e.detail.error) reject(new Error(e.detail.error));
                                else resolve(e.detail.result);
                            }
                        };
                        window.addEventListener(BRIDGE_ID + '_res', handler);
                        window.dispatchEvent(new CustomEvent(BRIDGE_ID + '_req', {
                            detail: { reqId, method, args }
                        }));
                    });
                };

                // Mock chrome.storage (Redireciona para o Content Script)
                if (!window.chrome.storage) {
                    window.chrome.storage = {
                        local: {
                            get: (keys) => window.__callExtension('storage.local.get', [keys]),
                            set: (items) => window.__callExtension('storage.local.set', [items]),
                            remove: (keys) => window.__callExtension('storage.local.remove', [keys]),
                            clear: () => window.__callExtension('storage.local.clear', [])
                        }
                    };
                }

                // Mock chrome.runtime (COM onMessage!)
                if (!window.chrome.runtime) {
                    // Lista de listeners registrados pelo código injetado
                    const messageListeners = [];

                    // Ouvir eventos vindos do Content Script (que repassa mensagens do background)
                    window.addEventListener('tramita_background_msg', (e) => {
                        const { message, sender } = e.detail;
                        console.log('[Bridge] Mensagem recebida do background:', message);
                        messageListeners.forEach(listener => {
                            try {
                                listener(message, sender, () => { });
                            } catch (err) {
                                console.error('[Bridge] Erro no listener:', err);
                            }
                        });
                    });

                    window.chrome.runtime = {
                        sendMessage: (msg, cb) => {
                            window.__callExtension('runtime.sendMessage', [msg])
                                .then(res => { if (cb) cb(res); })
                                .catch(err => console.error('Bridge Error:', err));
                        },
                        id: 'dummy_id',
                        getURL: (path) => path,
                        // 🔥 AQUI ESTÁ A CORREÇÃO DO ERRO "undefined reading onMessage"
                        onMessage: {
                            addListener: (callback) => {
                                console.log('[Bridge] Listener de mensagem registrado!');
                                messageListeners.push(callback);
                            },
                            removeListener: (callback) => {
                                const idx = messageListeners.indexOf(callback);
                                if (idx > -1) messageListeners.splice(idx, 1);
                            }
                        }
                    };
                }
                // --- FIM DA BRIDGE ---

                try {
                    console.log('[Injector] Executando window.eval()...');
                    window.eval(code);

                    if (typeof window.runContent === 'function') {
                        console.log('[Injector] Chamando runContent()...');
                        window.runContent(baseUrl);
                        console.log('[Injector] Sucesso! 🚀');
                    } else {
                        console.error('[Injector] runContent não foi encontrada');
                    }
                } catch (e) {
                    console.error('[Injector] Erro Fatal no Eval:', e);
                }
            }
        });

        sendResponse({ success: true });
    }
});