/**
 * Serviço de Gerenciamento de Parceiros (SaaS)
 * 
 * Gerencia parceiros/captadores de cada escritório para notificações automáticas.
 * Parceiros são identificados pela etiqueta PARCEIRO:NOME no Tramitação.
 */

import Database from '../database';
import logger from '../utils/logger';

export interface ParceiroConfig {
    id?: number;
    userId: string;
    nomeEtiqueta: string;      // Ex: "ARMENIO", "SINDICATO_RURAL"
    nomeCompleto?: string;     // Ex: "Dr. Armênio Silva"
    telefone: string;          // Ex: "5577988887777"
    email?: string;
    notificarExigencia: boolean;
    notificarDeferido: boolean;
    notificarIndeferido: boolean;
    notificarAgendamento: boolean;
    notificarEmAnalise: boolean;
    ativo: boolean;
    incluirLinkProcesso: boolean;
    incluirComprovantes: boolean;
    incluirAnaliseIA: boolean;
    observacoes?: string;
    createdAt?: Date;
    updatedAt?: Date;
}

export interface ParceiroNotificacao {
    parceiro: ParceiroConfig;
    deveNotificar: boolean;
    tipoStatus: 'EXIGENCIA' | 'DEFERIDO' | 'INDEFERIDO' | 'AGENDAMENTO' | 'EM_ANALISE';
}

class ParceirosService {

    /**
     * Busca todos os parceiros de um usuário
     */
    async listarParceiros(userId: string): Promise<ParceiroConfig[]> {
        const query = `
            SELECT * FROM parceiros_config
            WHERE user_id = $1
            ORDER BY nome_etiqueta ASC
        `;

        const resultado = await Database.query(query, [userId]);
        return resultado.map(this.mapearParaBD);
    }

    /**
     * Busca um parceiro pelo nome da etiqueta
     */
    async buscarPorEtiqueta(userId: string, nomeEtiqueta: string): Promise<ParceiroConfig | null> {
        const query = `
            SELECT * FROM parceiros_config
            WHERE user_id = $1 AND UPPER(nome_etiqueta) = UPPER($2)
        `;

        const resultado = await Database.query(query, [userId, nomeEtiqueta]);

        if (resultado.length === 0) return null;
        return this.mapearParaBD(resultado[0]);
    }

    /**
     * Busca um parceiro pelo ID
     */
    async buscarPorId(userId: string, id: number): Promise<ParceiroConfig | null> {
        const query = `
            SELECT * FROM parceiros_config
            WHERE user_id = $1 AND id = $2
        `;

        const resultado = await Database.query(query, [userId, id]);

        if (resultado.length === 0) return null;
        return this.mapearParaBD(resultado[0]);
    }

    /**
     * Cria um novo parceiro
     */
    async criarParceiro(parceiro: Omit<ParceiroConfig, 'id' | 'createdAt' | 'updatedAt'>): Promise<ParceiroConfig> {
        // Normalizar nome da etiqueta para UPPERCASE
        const nomeEtiquetaNormalizado = parceiro.nomeEtiqueta.toUpperCase().trim().replace(/\s+/g, '_');

        // Validar formato
        if (!this.validarNomeEtiqueta(nomeEtiquetaNormalizado)) {
            throw new Error('Nome da etiqueta inválido. Use apenas letras, números e underscore.');
        }

        // Validar telefone
        if (!this.validarTelefone(parceiro.telefone)) {
            throw new Error('Telefone inválido. Use formato: 5577988887777');
        }

        const query = `
            INSERT INTO parceiros_config (
                user_id, nome_etiqueta, nome_completo, telefone, email,
                notificar_exigencia, notificar_deferido, notificar_indeferido,
                notificar_agendamento, notificar_em_analise, ativo,
                incluir_link_processo, incluir_comprovantes, incluir_analise_ia,
                observacoes
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
            RETURNING *
        `;

        const valores = [
            parceiro.userId,
            nomeEtiquetaNormalizado,
            parceiro.nomeCompleto || null,
            parceiro.telefone.replace(/\D/g, ''),
            parceiro.email || null,
            parceiro.notificarExigencia ?? true,
            parceiro.notificarDeferido ?? true,
            parceiro.notificarIndeferido ?? true,
            parceiro.notificarAgendamento ?? true,
            parceiro.notificarEmAnalise ?? false,
            parceiro.ativo ?? true,
            parceiro.incluirLinkProcesso ?? false,
            parceiro.incluirComprovantes ?? true,
            parceiro.incluirAnaliseIA ?? true,
            parceiro.observacoes || null
        ];

        const resultado = await Database.query(query, valores);
        logger.info(`[Parceiros] Parceiro criado: ${nomeEtiquetaNormalizado} para usuário ${parceiro.userId}`);

        return this.mapearParaBD(resultado[0]);
    }

    /**
     * Atualiza um parceiro existente
     */
    async atualizarParceiro(userId: string, id: number, dados: Partial<ParceiroConfig>): Promise<ParceiroConfig | null> {
        // Verificar se existe
        const existente = await this.buscarPorId(userId, id);
        if (!existente) return null;

        // Normalizar nome da etiqueta se fornecido
        let nomeEtiquetaNormalizado = existente.nomeEtiqueta;
        if (dados.nomeEtiqueta) {
            nomeEtiquetaNormalizado = dados.nomeEtiqueta.toUpperCase().trim().replace(/\s+/g, '_');
            if (!this.validarNomeEtiqueta(nomeEtiquetaNormalizado)) {
                throw new Error('Nome da etiqueta inválido');
            }
        }

        // Validar telefone se fornecido
        if (dados.telefone && !this.validarTelefone(dados.telefone)) {
            throw new Error('Telefone inválido');
        }

        const query = `
            UPDATE parceiros_config SET
                nome_etiqueta = COALESCE($3, nome_etiqueta),
                nome_completo = COALESCE($4, nome_completo),
                telefone = COALESCE($5, telefone),
                email = COALESCE($6, email),
                notificar_exigencia = COALESCE($7, notificar_exigencia),
                notificar_deferido = COALESCE($8, notificar_deferido),
                notificar_indeferido = COALESCE($9, notificar_indeferido),
                notificar_agendamento = COALESCE($10, notificar_agendamento),
                notificar_em_analise = COALESCE($11, notificar_em_analise),
                ativo = COALESCE($12, ativo),
                incluir_link_processo = COALESCE($13, incluir_link_processo),
                incluir_comprovantes = COALESCE($14, incluir_comprovantes),
                incluir_analise_ia = COALESCE($15, incluir_analise_ia),
                observacoes = COALESCE($16, observacoes),
                updated_at = NOW()
            WHERE user_id = $1 AND id = $2
            RETURNING *
        `;

        const valores = [
            userId,
            id,
            nomeEtiquetaNormalizado !== existente.nomeEtiqueta ? nomeEtiquetaNormalizado : null,
            dados.nomeCompleto,
            dados.telefone?.replace(/\D/g, ''),
            dados.email,
            dados.notificarExigencia,
            dados.notificarDeferido,
            dados.notificarIndeferido,
            dados.notificarAgendamento,
            dados.notificarEmAnalise,
            dados.ativo,
            dados.incluirLinkProcesso,
            dados.incluirComprovantes,
            dados.incluirAnaliseIA,
            dados.observacoes
        ];

        const resultado = await Database.query(query, valores);
        logger.info(`[Parceiros] Parceiro atualizado: ID ${id}`);

        return this.mapearParaBD(resultado[0]);
    }

    /**
     * Exclui um parceiro
     */
    async excluirParceiro(userId: string, id: number): Promise<boolean> {
        const query = `
            DELETE FROM parceiros_config
            WHERE user_id = $1 AND id = $2
        `;

        await Database.query(query, [userId, id]);
        logger.info(`[Parceiros] Parceiro excluído: ID ${id}`);
        return true;
    }

    /**
     * Busca parceiros que devem ser notificados para um determinado status
     * Analisa as tags do cliente buscando padrão PARCEIRO:NOME
     */
    async buscarParceirosParaNotificacao(
        userId: string,
        tagsCliente: string[],
        tipoStatus: 'EXIGENCIA' | 'DEFERIDO' | 'INDEFERIDO' | 'AGENDAMENTO' | 'EM_ANALISE'
    ): Promise<ParceiroNotificacao[]> {
        const notificacoes: ParceiroNotificacao[] = [];

        // Buscar tags que começam com PARCEIRO:
        const tagsParceiro = tagsCliente.filter(tag =>
            tag.toUpperCase().startsWith('PARCEIRO:')
        );

        if (tagsParceiro.length === 0) {
            return [];
        }

        for (const tag of tagsParceiro) {
            // Extrair nome do parceiro (parte após PARCEIRO:)
            const nomeParceiro = tag.substring(9).toUpperCase().trim();

            if (!nomeParceiro) continue;

            // Buscar parceiro na configuração
            const parceiro = await this.buscarPorEtiqueta(userId, nomeParceiro);

            if (!parceiro) {
                logger.warn(`[Parceiros] Parceiro "${nomeParceiro}" não encontrado na configuração do usuário ${userId}`);
                continue;
            }

            if (!parceiro.ativo) {
                logger.info(`[Parceiros] Parceiro "${nomeParceiro}" está inativo, pulando notificação`);
                continue;
            }

            // Verificar se deve notificar para este tipo de status
            let deveNotificar = false;
            switch (tipoStatus) {
                case 'EXIGENCIA':
                    deveNotificar = parceiro.notificarExigencia;
                    break;
                case 'DEFERIDO':
                    deveNotificar = parceiro.notificarDeferido;
                    break;
                case 'INDEFERIDO':
                    deveNotificar = parceiro.notificarIndeferido;
                    break;
                case 'AGENDAMENTO':
                    deveNotificar = parceiro.notificarAgendamento;
                    break;
                case 'EM_ANALISE':
                    deveNotificar = parceiro.notificarEmAnalise;
                    break;
            }

            notificacoes.push({
                parceiro,
                deveNotificar,
                tipoStatus
            });
        }

        return notificacoes;
    }

    /**
     * Gera mensagem personalizada para parceiro
     */
    gerarMensagemParceiro(
        parceiro: ParceiroConfig,
        dados: {
            nomeCliente: string;
            cpfMascarado: string;
            protocolo: string;
            beneficio: string;
            status: string;
            motivo?: string;
            sugestaoAcao?: string;
            linkProcesso?: string;
            comprovantes?: { tipo: string; url: string }[];
            analiseIA?: string;
        }
    ): string {
        let mensagem = `*Atualização de Processo*\n\n`;
        mensagem += `*Cliente*: ${dados.nomeCliente}\n`;
        mensagem += `*CPF*: ${dados.cpfMascarado}\n`;
        mensagem += `*Protocolo*: ${dados.protocolo}\n`;
        mensagem += `*Benefício*: ${dados.beneficio}\n`;
        mensagem += `*Status*: ${dados.status}\n`;

        if (dados.motivo) {
            mensagem += `\n*Motivo*:\n${dados.motivo}\n`;
        }

        if (dados.sugestaoAcao) {
            mensagem += `\n*Sugestão de Ação*:\n${dados.sugestaoAcao}\n`;
        }

        // Incluir análise da IA se configurado
        if (parceiro.incluirAnaliseIA && dados.analiseIA) {
            mensagem += `\n*Análise*:\n${dados.analiseIA}\n`;
        }

        // Incluir comprovantes se configurado
        if (parceiro.incluirComprovantes && dados.comprovantes && dados.comprovantes.length > 0) {
            mensagem += `\n*Comprovantes*:\n`;
            for (const comp of dados.comprovantes) {
                mensagem += `- ${comp.tipo}: ${comp.url}\n`;
            }
        }

        // Incluir link do processo se configurado (apenas para parceiros com acesso)
        if (parceiro.incluirLinkProcesso && dados.linkProcesso) {
            mensagem += `\n*Link do Processo*:\n${dados.linkProcesso}\n`;
        }

        mensagem += `\n_Notificação automática - ${new Date().toLocaleString('pt-BR')}_`;

        return mensagem;
    }

    // =============== HELPERS ===============

    private validarNomeEtiqueta(nome: string): boolean {
        // Apenas letras, números e underscore
        return /^[A-Z0-9_]+$/.test(nome) && nome.length >= 2 && nome.length <= 100;
    }

    private validarTelefone(telefone: string): boolean {
        const apenasNumeros = telefone.replace(/\D/g, '');
        // Deve ter entre 10 e 15 dígitos (incluindo código do país)
        return apenasNumeros.length >= 10 && apenasNumeros.length <= 15;
    }

    private mapearParaBD(row: any): ParceiroConfig {
        return {
            id: row.id,
            userId: row.user_id,
            nomeEtiqueta: row.nome_etiqueta,
            nomeCompleto: row.nome_completo,
            telefone: row.telefone,
            email: row.email,
            notificarExigencia: row.notificar_exigencia,
            notificarDeferido: row.notificar_deferido,
            notificarIndeferido: row.notificar_indeferido,
            notificarAgendamento: row.notificar_agendamento,
            notificarEmAnalise: row.notificar_em_analise,
            ativo: row.ativo,
            incluirLinkProcesso: row.incluir_link_processo,
            incluirComprovantes: row.incluir_comprovantes,
            incluirAnaliseIA: row.incluir_analise_ia,
            observacoes: row.observacoes,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };
    }
}

export default new ParceirosService();
