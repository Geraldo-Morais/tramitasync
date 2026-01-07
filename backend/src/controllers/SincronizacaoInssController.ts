import { SincronizacaoInssService } from '../services/SincronizacaoInssService';
import logger from '../utils/logger';
import auditLogger from '../utils/auditLogger';

// Gerador simples de UUID v4
function uuidv4(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

interface JobStatus {
    jobId: string;
    status: 'running' | 'completed' | 'failed' | 'pending';
    progress?: {
        total: number;
        processados: number;
        sucesso: number;
        erros: number;
    };
    resultado?: {
        protocolosProcessados: number;
        clientesCriados: number;
        clientesAtualizados: number;
        notificacoesEnviadas: number;
        erros: string[];
        protocolosComErro?: string[];
    };
    erro?: string;
    dataInicio?: string;
    dataFim?: string;
    iniciadoEm?: Date;
    finalizadoEm?: Date;
}

/**
 * Controller para sincronização INSS
 * Gerencia jobs de sincronização assíncronos
 */
export class SincronizacaoInssController {
    private jobs: Map<string, JobStatus> = new Map();
    private sincronizacaoService: SincronizacaoInssService;

    constructor() {
        this.sincronizacaoService = new SincronizacaoInssService(
            (jobId: string, progress: any) => this.atualizarProgresso(jobId, progress),
            (jobId: string, resultado: any) => this.finalizarJob(jobId, resultado),
            (jobId: string, erro: string) => this.falharJob(jobId, erro)
        );
    }

    /**
     * Inicia uma nova sincronização
     */
    async iniciarSincronizacao(
        tokenPat: string,
        forcarExecucao: boolean = false,
        userId?: string,
        userConfig?: {
            geminiApiKey?: string;
            tramitacaoApiToken?: string;
            tramitacaoEmail?: string;
            tramitacaoSenha?: string;
        }
    ): Promise<{
        success: boolean;
        message?: string;
        jobId?: string;
        dataInicio?: string;
        dataFim?: string;
    }> {
        try {
            // Limpar jobs travados (running/pending há mais de 30 minutos)
            this.limparJobsTravados();

            // Verificar se já existe uma sincronização rodando hoje
            if (!forcarExecucao) {
                const hoje = new Date().toISOString().split('T')[0];
                const agora = Date.now();
                const jobsHoje = Array.from(this.jobs.values()).filter(job => {
                    if (!job.iniciadoEm) return false;
                    const dataJob = job.iniciadoEm.toISOString().split('T')[0];
                    const tempoDecorrido = agora - job.iniciadoEm.getTime();
                    const estaTravado = tempoDecorrido > 30 * 60 * 1000; // 30 minutos

                    // Ignorar jobs travados
                    if (estaTravado) return false;

                    return dataJob === hoje && (job.status === 'running' || job.status === 'pending');
                });

                if (jobsHoje.length > 0) {
                    return {
                        success: false,
                        message: 'Já existe uma sincronização em andamento hoje. Use forcarExecucao=true para executar mesmo assim.'
                    };
                }
            }

            // Calcular datas (ontem e hoje, ou última sexta até hoje se segunda)
            const { dataInicio, dataFim } = this.calcularDatas();

            // Criar novo job
            const jobId = uuidv4();
            const job: JobStatus & { userId?: string } = {
                jobId,
                status: 'pending',
                dataInicio: dataInicio.toISOString(),
                dataFim: dataFim.toISOString(),
                iniciadoEm: new Date(),
                userId // Armazenar userId para logs de auditoria
            };

            this.jobs.set(jobId, job);

            // Atualizar status para 'running' imediatamente com progresso inicial
            job.status = 'running';
            job.progress = {
                total: 0,
                processados: 0,
                sucesso: 0,
                erros: 0
            };
            this.jobs.set(jobId, job);

            // Log de auditoria
            auditLogger.logSync('Sincronização INSS iniciada', userId, undefined, {
                jobId,
                dataInicio: dataInicio.toISOString(),
                dataFim: dataFim.toISOString(),
                forcarExecucao
            });

            // Iniciar sincronização de forma assíncrona com configurações do usuário
            this.sincronizacaoService.executarSincronizacao(jobId, tokenPat, dataInicio, dataFim, userId, userConfig)
                .catch((error: any) => {
                    logger.error(`❌ Erro na sincronização ${jobId}: ${error.message}`, error);
                    this.falharJob(jobId, error.message);
                });

            return {
                success: true,
                jobId,
                dataInicio: dataInicio.toISOString(),
                dataFim: dataFim.toISOString()
            };
        } catch (error: any) {
            logger.error(`❌ Erro ao iniciar sincronização: ${error.message}`, error);
            return {
                success: false,
                message: error.message
            };
        }
    }

    /**
     * Obtém o status de um job
     */
    async obterStatus(jobId: string): Promise<JobStatus | null> {
        return this.jobs.get(jobId) || null;
    }

    /**
     * Calcula as datas de início e fim para sincronização
     * 
     * 🧪 MODO TESTE: Usando período fixo 10/11/2025 - 15/11/2025
     * TODO: Após testes, voltar para lógica dinâmica (ontem/hoje)
     */
    private calcularDatas(): { dataInicio: Date; dataFim: Date } {
        // 🧪 PERÍODO DE TESTE FIXO - REMOVER APÓS TESTES
        // Usar formato com timezone explícito para evitar off-by-one
        const dataInicio = new Date(2025, 10, 10, 0, 0, 0, 0); // Mês é 0-indexed (10 = novembro)
        const dataFim = new Date(2025, 10, 15, 23, 59, 59, 999); // 15 de novembro

        return { dataInicio, dataFim };

        /* LÓGICA ORIGINAL - DESCOMENTAR APÓS TESTES
        const hoje = new Date();
        const diaSemana = hoje.getDay(); // 0 = domingo, 1 = segunda, ..., 6 = sábado

        let dataInicio: Date;

        if (diaSemana === 1) {
            // Segunda-feira: pegar da última sexta-feira
            dataInicio = new Date(hoje);
            const diasAtras = hoje.getDay() === 1 ? 3 : 0; // Segunda = 3 dias atrás (sexta)
            dataInicio.setDate(hoje.getDate() - diasAtras);
        } else {
            // Outros dias: pegar de ontem
            dataInicio = new Date(hoje);
            dataInicio.setDate(hoje.getDate() - 1);
        }

        // Início do dia (00:00:00)
        dataInicio.setHours(0, 0, 0, 0);

        // Fim do dia atual (23:59:59)
        const dataFim = new Date(hoje);
        dataFim.setHours(23, 59, 59, 999);

        return { dataInicio, dataFim };
        */
    }

    /**
     * Atualiza o progresso de um job
     */
    private atualizarProgresso(jobId: string, progress: any): void {
        const job = this.jobs.get(jobId);
        if (job) {
            job.status = 'running';
            job.progress = progress;
            this.jobs.set(jobId, job);
        }
    }

    /**
     * Finaliza um job com sucesso
     */
    private finalizarJob(jobId: string, resultado: any): void {
        const job = this.jobs.get(jobId);
        if (job) {
            job.status = 'completed';
            job.resultado = resultado;
            job.finalizadoEm = new Date();
            this.jobs.set(jobId, job);

            // Log de auditoria
            const userId = (job as any).userId;
            auditLogger.logSync('Sincronização INSS concluída', userId, undefined, {
                jobId,
                protocolosProcessados: resultado?.protocolosProcessados || 0,
                clientesCriados: resultado?.clientesCriados || 0,
                clientesAtualizados: resultado?.clientesAtualizados || 0,
                notificacoesEnviadas: resultado?.notificacoesEnviadas || 0,
                erros: resultado?.erros?.length || 0
            });
        }
    }

    /**
     * Marca um job como falho
     */
    private falharJob(jobId: string, erro: string): void {
        const job = this.jobs.get(jobId);
        if (job) {
            job.status = 'failed';
            job.erro = erro;
            job.finalizadoEm = new Date();
            this.jobs.set(jobId, job);

            // Log de auditoria
            const userId = (job as any).userId;
            auditLogger.logSync('Sincronização INSS falhou', userId, undefined, {
                jobId,
                erro
            });
        }
    }

    /**
     * Limpa jobs travados (running/pending há mais de 30 minutos)
     */
    private limparJobsTravados(): void {
        const agora = Date.now();
        const jobsParaLimpar: string[] = [];

        for (const [jobId, job] of this.jobs.entries()) {
            if (!job.iniciadoEm) continue;

            const tempoDecorrido = agora - job.iniciadoEm.getTime();
            const estaTravado = tempoDecorrido > 30 * 60 * 1000; // 30 minutos

            if ((job.status === 'running' || job.status === 'pending') && estaTravado) {
                jobsParaLimpar.push(jobId);
                logger.warn(`🧹 Limpando job travado: ${jobId} (${Math.round(tempoDecorrido / 1000 / 60)} minutos)`);
            }
        }

        for (const jobId of jobsParaLimpar) {
            const job = this.jobs.get(jobId);
            if (job) {
                job.status = 'failed';
                job.erro = 'Job travado - timeout após 30 minutos';
                job.finalizadoEm = new Date();
                this.jobs.set(jobId, job);
            }
        }
    }
}


