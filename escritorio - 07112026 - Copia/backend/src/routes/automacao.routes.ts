/**
 * 🤖 ROTAS DE AUTOMAÇÃO INSS
 * 
 * Endpoints para executar fluxo automático via frontend
 * com logs em tempo real via Server-Sent Events (SSE)
 */

import { Router, Request, Response } from 'express';
import puppeteerService from '../services/PuppeteerService';
import db from '../database';
import logger from '../utils/logger';

const router = Router();

// ============================================================
// 📡 TIPOS E INTERFACES
// ============================================================

interface IniciarAutomacaoRequest {
    dataInicio: string; // DD/MM/YYYY
    dataFim: string; // DD/MM/YYYY
    status: string; // "TODOS" ou "EXIGÊNCIA", etc
    limiteProtocolos?: number; // Opcional: limitar quantidade
}

interface LogEvento {
    tipo: 'info' | 'success' | 'warning' | 'error' | 'progress';
    mensagem: string;
    timestamp: string;
    dados?: any;
}

// Array global para armazenar clientes SSE conectados
const clientesSSE = new Map<string, Response>();

// ============================================================
// 📡 ENDPOINT: Server-Sent Events (SSE) para logs em tempo real
// ============================================================

/**
 * GET /api/automacao/logs/:sessionId
 * 
 * Estabelece conexão SSE para receber logs em tempo real
 */
router.get('/logs/:sessionId', (req: Request, res: Response) => {
    const { sessionId } = req.params;

    // Configurar headers SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Adicionar cliente à lista
    clientesSSE.set(sessionId, res);

    // Enviar mensagem inicial
    enviarLog(sessionId, {
        tipo: 'info',
        mensagem: '✅ Conexão SSE estabelecida',
        timestamp: new Date().toISOString()
    });

    // Remover cliente quando desconectar
    req.on('close', () => {
        clientesSSE.delete(sessionId);
        logger.info(`🔌 Cliente SSE desconectado: ${sessionId}`);
    });
});

/**
 * Enviar log para cliente SSE específico
 */
function enviarLog(sessionId: string, log: LogEvento) {
    const cliente = clientesSSE.get(sessionId);
    if (cliente) {
        cliente.write(`data: ${JSON.stringify(log)}\n\n`);
    }

    // Também logar no console do servidor
    const emoji = log.tipo === 'success' ? '✅' : log.tipo === 'error' ? '❌' : log.tipo === 'warning' ? '⚠️' : '📋';
    logger.info(`${emoji} [${sessionId.substring(0, 8)}] ${log.mensagem}`);
}

/**
 * Broadcast: enviar log para TODOS os clientes conectados (não usado, mas pode ser útil depois)
 */
// function broadcastLog(log: LogEvento) {
//     clientesSSE.forEach((cliente, sessionId) => {
//         enviarLog(sessionId, log);
//     });
// }

// ============================================================
// 🚀 ENDPOINT: Iniciar automação
// ============================================================

/**
 * POST /api/automacao/iniciar
 * 
 * Body: {
 *   dataInicio: "01/10/2025",
 *   dataFim: "10/11/2025",
 *   status: "TODOS",
 *   limiteProtocolos: 10
 * }
 */
router.post('/iniciar', async (req: Request, res: Response) => {
    const sessionId = `session-${Date.now()}`;
    const params: IniciarAutomacaoRequest = req.body;

    // Validar parâmetros
    if (!params.dataInicio || !params.dataFim) {
        return res.status(400).json({
            sucesso: false,
            erro: 'dataInicio e dataFim são obrigatórios'
        });
    }

    // Retornar sessionId imediatamente (processo vai rodar em background)
    res.json({
        sucesso: true,
        sessionId,
        mensagem: 'Automação iniciada! Conecte-se ao endpoint /logs/:sessionId para acompanhar'
    });

    // Executar fluxo em background
    executarFluxoCompleto(sessionId, params).catch(error => {
        enviarLog(sessionId, {
            tipo: 'error',
            mensagem: `❌ Erro fatal: ${error.message}`,
            timestamp: new Date().toISOString(),
            dados: { stack: error.stack }
        });
    });
});

// ============================================================
// 🔄 FLUXO PRINCIPAL
// ============================================================

async function executarFluxoCompleto(sessionId: string, params: IniciarAutomacaoRequest) {
    const inicio = Date.now();

    try {
        enviarLog(sessionId, {
            tipo: 'info',
            mensagem: '🚀 Iniciando automação INSS',
            timestamp: new Date().toISOString(),
            dados: params
        });

        // ============================================================
        // ETAPA 1: Inicializar Puppeteer
        // ============================================================
        enviarLog(sessionId, {
            tipo: 'progress',
            mensagem: '🌐 Abrindo navegador...',
            timestamp: new Date().toISOString()
        });

        await puppeteerService.initialize();

        enviarLog(sessionId, {
            tipo: 'success',
            mensagem: '✅ Navegador aberto',
            timestamp: new Date().toISOString()
        });

        // ============================================================
        // ETAPA 2: Login no PAT
        // ============================================================
        enviarLog(sessionId, {
            tipo: 'progress',
            mensagem: '🔐 Fazendo login no PAT...',
            timestamp: new Date().toISOString()
        });

        const accessToken = process.env.INSS_ACCESS_TOKEN || '';
        if (!accessToken) {
            throw new Error('INSS_ACCESS_TOKEN não configurado no .env');
        }

        await puppeteerService.login(accessToken);

        enviarLog(sessionId, {
            tipo: 'success',
            mensagem: '✅ Login realizado com sucesso',
            timestamp: new Date().toISOString()
        });

        // ============================================================
        // ETAPA 3: Buscar protocolos
        // ============================================================
        enviarLog(sessionId, {
            tipo: 'progress',
            mensagem: `🔍 Buscando protocolos (${params.dataInicio} a ${params.dataFim})...`,
            timestamp: new Date().toISOString()
        });

        // Converter strings DD/MM/YYYY para Date
        const [diaI, mesI, anoI] = params.dataInicio.split('/');
        const [diaF, mesF, anoF] = params.dataFim.split('/');
        const dataInicioDate = new Date(parseInt(anoI), parseInt(mesI) - 1, parseInt(diaI));
        const dataFimDate = new Date(parseInt(anoF), parseInt(mesF) - 1, parseInt(diaF));

        const protocolos = await puppeteerService.coletarProtocolos(
            dataInicioDate,
            dataFimDate,
            params.status
        );

        // Verificar se tem CAPTCHA após a busca
        const temCaptcha = await puppeteerService.detectarCaptcha();
        if (temCaptcha) {
            enviarLog(sessionId, {
                tipo: 'warning',
                mensagem: '🚨 CAPTCHA DETECTADO! Por favor, resolva o CAPTCHA no navegador e pressione ENTER aqui no console para continuar...',
                timestamp: new Date().toISOString()
            });

            // Aguardar CAPTCHA ser resolvido (timeout de 5 minutos)
            await puppeteerService.aguardarCaptchaResolvido();

            enviarLog(sessionId, {
                tipo: 'success',
                mensagem: '✅ CAPTCHA resolvido! Continuando...',
                timestamp: new Date().toISOString()
            });
        }

        enviarLog(sessionId, {
            tipo: 'success',
            mensagem: `✅ ${protocolos.length} protocolos encontrados`,
            timestamp: new Date().toISOString(),
            dados: { total: protocolos.length }
        });

        // Limitar quantidade se especificado
        const protocolosParaProcessar = params.limiteProtocolos
            ? protocolos.slice(0, params.limiteProtocolos)
            : protocolos;

        if (params.limiteProtocolos && protocolos.length > params.limiteProtocolos) {
            enviarLog(sessionId, {
                tipo: 'warning',
                mensagem: `⚠️ Processando apenas ${params.limiteProtocolos} protocolos (limite definido)`,
                timestamp: new Date().toISOString()
            });
        }

        // ============================================================
        // ETAPA 4: Processar cada protocolo
        // ============================================================
        let sucessos = 0;
        let erros = 0;

        for (let i = 0; i < protocolosParaProcessar.length; i++) {
            const protocolo = protocolosParaProcessar[i];

            enviarLog(sessionId, {
                tipo: 'progress',
                mensagem: `📄 [${i + 1}/${protocolosParaProcessar.length}] Processando protocolo ${protocolo}...`,
                timestamp: new Date().toISOString()
            });

            try {
                // 4.1: Extrair detalhes
                enviarLog(sessionId, {
                    tipo: 'info',
                    mensagem: `  📥 Extraindo detalhes do protocolo ${protocolo}...`,
                    timestamp: new Date().toISOString()
                });

                const detalhes = await puppeteerService.extrairDetalhesProtocolo(protocolo, {
                    dataInicio: dataInicioDate,
                    dataFim: dataFimDate,
                    status: params.status
                });

                if (!detalhes.nome || !detalhes.cpf) {
                    throw new Error('Dados incompletos (possível erro 406)');
                }

                enviarLog(sessionId, {
                    tipo: 'success',
                    mensagem: `  ✅ Dados extraídos: ${detalhes.nome} (CPF: ${detalhes.cpf})`,
                    timestamp: new Date().toISOString(),
                    dados: { protocolo, nome: detalhes.nome, cpf: detalhes.cpf }
                });

                // 4.2: Verificar se já existe no banco
                const existente = await db.queryFull(
                    'SELECT id FROM processos WHERE protocolo = $1',
                    [protocolo]
                );

                if (existente.rows.length > 0) {
                    enviarLog(sessionId, {
                        tipo: 'warning',
                        mensagem: `  ⏭️ Protocolo ${protocolo} já existe no banco, pulando...`,
                        timestamp: new Date().toISOString()
                    });
                    continue;
                }

                // 4.3: Log dos comentários (análise IA virá depois)
                if (detalhes.comentarios && detalhes.comentarios.length > 0) {
                    enviarLog(sessionId, {
                        tipo: 'info',
                        mensagem: `  💬 ${detalhes.comentarios.length} comentário(s) encontrado(s)`,
                        timestamp: new Date().toISOString(),
                        dados: { totalComentarios: detalhes.comentarios.length }
                    });
                }

                // 4.4: Salvar no banco
                enviarLog(sessionId, {
                    tipo: 'info',
                    mensagem: `  💾 Salvando no banco de dados...`,
                    timestamp: new Date().toISOString()
                });

                await db.queryFull(
                    `INSERT INTO processos (protocolo, nome, cpf, servico, status, data_entrada)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [
                        protocolo,
                        detalhes.nome,
                        detalhes.cpf,
                        detalhes.servico,
                        detalhes.statusAtual,
                        detalhes.dataSolicitacao
                    ]
                );

                enviarLog(sessionId, {
                    tipo: 'success',
                    mensagem: `  ✅ Protocolo ${protocolo} salvo com sucesso!`,
                    timestamp: new Date().toISOString()
                });

                sucessos++;

            } catch (error: any) {
                erros++;
                enviarLog(sessionId, {
                    tipo: 'error',
                    mensagem: `  ❌ Erro ao processar ${protocolo}: ${error.message}`,
                    timestamp: new Date().toISOString(),
                    dados: { protocolo, erro: error.message }
                });
            }
        }

        // ============================================================
        // ETAPA 5: Finalizar
        // ============================================================
        await puppeteerService.close();

        const duracao = Math.round((Date.now() - inicio) / 1000);

        enviarLog(sessionId, {
            tipo: 'success',
            mensagem: `🎉 Automação concluída! Sucessos: ${sucessos} | Erros: ${erros} | Duração: ${duracao}s`,
            timestamp: new Date().toISOString(),
            dados: { sucessos, erros, duracao, total: protocolosParaProcessar.length }
        });

    } catch (error: any) {
        enviarLog(sessionId, {
            tipo: 'error',
            mensagem: `❌ Erro fatal: ${error.message}`,
            timestamp: new Date().toISOString(),
            dados: { stack: error.stack }
        });
    } finally {
        // Aguardar 5s e remover cliente (dar tempo do frontend ler última mensagem)
        setTimeout(() => {
            clientesSSE.delete(sessionId);
        }, 5000);
    }
}

// ============================================================
// 📊 ENDPOINT: Status da automação
// ============================================================

/**
 * GET /api/automacao/status
 * 
 * Retorna quantos clientes SSE estão conectados (= automações rodando)
 */
router.get('/status', (req: Request, res: Response) => {
    res.json({
        sucesso: true,
        automacoesAtivas: clientesSSE.size,
        sessoes: Array.from(clientesSSE.keys())
    });
});

export default router;
