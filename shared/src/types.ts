// ==================== ENUMS ====================

export enum PerfilUsuario {
    ADMIN = 'admin',
    SECRETARIA = 'secretaria',
    ADMINISTRATIVO = 'administrativo',
    INTERMEDIACAO = 'intermediacao',
    JUDICIAL = 'judicial'
}

export enum StatusINSS {
    PENDENTE = 'PENDENTE',
    EM_ANALISE = 'EM_ANALISE',
    EXIGENCIA = 'CUMPRIMENTO_DE_EXIGENCIA',
    CONCLUIDA = 'CONCLUIDA',
    CANCELADA = 'CANCELADA'
}

export enum ClasseFinal {
    DEFERIDO = 'DEFERIDO',
    INDEFERIDO = 'INDEFERIDO',
    DUPLICADO = 'DUPLICADO',
    CANCELADO = 'CANCELADO',
    PENDENTE = 'PENDENTE',
    EXIGENCIA = 'EXIGENCIA',
    PERICIA = 'PERICIA',
    RECURSO = 'RECURSO',
    EM_ANALISE = 'EM_ANALISE'
}

export enum TipoBeneficio {
    BPC = 'BPC',
    SALARIO_MATERNIDADE = 'SALÁRIO MATERNIDADE',
    PENSAO = 'PENSÃO',
    APOSENTADORIAS = 'APOSENTADORIAS',
    AUX_DOENCA = 'AUX DOENÇA'
}

export enum StatusFluxo {
    NOVO = 'NOVO',
    EXIGENCIA_DETECTADA = 'EXIGENCIA_DETECTADA',
    SOLICITADO_CINTIA = 'SOLICITADO_CINTIA',
    CONTATO_COLABORADOR = 'CONTATO_COLABORADOR',
    DOCUMENTO_RECEBIDO = 'DOCUMENTO_RECEBIDO',
    DOCUMENTO_ANEXADO = 'DOCUMENTO_ANEXADO',
    CONCLUIDO = 'CONCLUIDO',
    CANCELADO = 'CANCELADO',
    ENCAMINHADO_JUDICIAL = 'ENCAMINHADO_JUDICIAL'
}

// ==================== USUÁRIO ====================

export interface Usuario {
    id: string;
    nome: string;
    email: string;
    perfil: PerfilUsuario;
    ativo: boolean;
    created_at: Date;
    updated_at: Date;
}

export interface UsuarioCreate {
    nome: string;
    email: string;
    senha: string;
    perfil: PerfilUsuario;
}

export interface UsuarioUpdate {
    nome?: string;
    email?: string;
    senha?: string;
    perfil?: PerfilUsuario;
    ativo?: boolean;
}

export interface UsuarioLogin {
    email: string;
    senha: string;
}

export interface AuthResponse {
    token: string;
    usuario: Omit<Usuario, 'senha'>;
}

// ==================== PROCESSO ====================

export interface Processo {
    id: string;
    cpf_segurado: string;
    nome_segurado: string;
    protocolo_inss: string;
    der: Date;
    status_inss: StatusINSS;
    status_fluxo: StatusFluxo;
    tipo_beneficio: TipoBeneficio;
    classe_final?: ClasseFinal;
    motivo_inss?: string;
    data_conclusao?: Date;
    responsavel_id?: string;
    responsavel?: Usuario;
    tramitacao_cliente_id?: number; // ID do cliente no Tramitação
    tramitacao_cliente_uuid?: string; // UUID do cliente no Tramitação
    created_at: Date;
    updated_at: Date;
    dt_ultima_verificacao?: Date;
}

export interface ProcessoCreate {
    cpf_segurado: string;
    nome_segurado: string;
    protocolo_inss: string;
    der: Date | string;
    status_inss: StatusINSS;
    tipo_beneficio: TipoBeneficio;
    responsavel_id?: string;
    tramitacao_cliente_id?: number;
}

export interface ProcessoUpdate {
    status_inss?: StatusINSS;
    status_fluxo?: StatusFluxo;
    classe_final?: ClasseFinal;
    motivo_inss?: string;
    data_conclusao?: Date | string;
    responsavel_id?: string;
    tramitacao_cliente_id?: number;
}

// ==================== EXIGÊNCIA ====================

export interface Exigencia {
    id: string;
    processo_id: string;
    processo?: Processo;
    data_abertura: Date;
    prazo: Date;
    resumo_exigencia: string;
    itens_pendentes: string[];
    status: 'PENDENTE' | 'EM_ANDAMENTO' | 'CUMPRIDA' | 'VENCIDA';
    tramitacao_nota_id?: number; // ID da nota criada no Tramitação
    created_at: Date;
    updated_at: Date;
}

export interface ExigenciaCreate {
    processo_id: string;
    data_abertura: Date | string;
    prazo: Date | string;
    resumo_exigencia: string;
    itens_pendentes: string[];
}

export interface ExigenciaUpdate {
    status?: 'PENDENTE' | 'EM_ANDAMENTO' | 'CUMPRIDA' | 'VENCIDA';
    resumo_exigencia?: string;
    itens_pendentes?: string[];
    tramitacao_nota_id?: number;
}

// ==================== HISTÓRICO ====================

export interface HistoricoStatus {
    id: string;
    processo_id: string;
    processo?: Processo;
    status_anterior: StatusINSS | StatusFluxo;
    status_novo: StatusINSS | StatusFluxo;
    tipo: 'STATUS_INSS' | 'STATUS_FLUXO';
    observacao?: string;
    usuario_id?: string;
    usuario?: Usuario;
    created_at: Date;
}

export interface HistoricoStatusCreate {
    processo_id: string;
    status_anterior: StatusINSS | StatusFluxo;
    status_novo: StatusINSS | StatusFluxo;
    tipo: 'STATUS_INSS' | 'STATUS_FLUXO';
    observacao?: string;
    usuario_id?: string;
}

// ==================== PROCESSO JUDICIAL ====================

export interface ProcessoJudicial {
    id: string;
    processo_id: string;
    processo?: Processo;
    numero_judicial: string;
    data_entrada_justica: Date;
    vara?: string;
    comarca?: string;
    observacoes?: string;
    created_at: Date;
    updated_at: Date;
}

export interface ProcessoJudicialCreate {
    processo_id: string;
    numero_judicial: string;
    data_entrada_justica: Date | string;
    vara?: string;
    comarca?: string;
    observacoes?: string;
}

export interface ProcessoJudicialUpdate {
    numero_judicial?: string;
    data_entrada_justica?: Date | string;
    vara?: string;
    comarca?: string;
    observacoes?: string;
}

// ==================== TRAMITAÇÃO API ====================

export interface TramitacaoCliente {
    id: number;
    uuid: string;
    name: string;
    cpf_cnpj: string;
    email?: string;
    phone_mobile?: string;
    phone_1?: string;
    phone_2?: string;
    birthdate?: string;
    meu_inss_pass?: string;
    created_at: string;
    updated_at: string;
    tags?: Array<{ name: string; color: string }>;
}

export interface TramitacaoClienteCreate {
    customer: {
        name: string;
        cpf_cnpj: string;
        email?: string;
        phone_mobile?: string;
        birthdate?: string;
        meu_inss_pass?: string;
        tags?: string[];
    };
}

export interface TramitacaoNota {
    id: number;
    uuid: string;
    content: string;
    created_at: string;
    updated_at: string;
    user: {
        id: string;
        name: string;
        email: string;
    };
    customer?: {
        id: number;
        name: string;
        cpf_cnpj: string;
    };
}

export interface TramitacaoNotaCreate {
    note: {
        content: string;
        user_id: string;
        customer_id?: number;
    };
}

// ==================== ESTATÍSTICAS ====================

export interface EstatisticasGerais {
    total_processos: number;
    total_mes: number;
    deferidos: number;
    indeferidos: number;
    duplicados: number;
    cancelados: number;
    pendentes: number;
    em_exigencia: number;
    taxa_deferimento: number;
    taxa_indeferimento: number;
}

export interface EstatisticasPorTipo {
    tipo: TipoBeneficio;
    total: number;
    deferidos: number;
    indeferidos: number;
    pendentes: number;
    taxa_deferimento: number;
}

export interface EstatisticasMensais {
    mes: number;
    ano: number;
    total: number;
    deferidos: number;
    indeferidos: number;
    pendentes: number;
}

export interface ExigenciaPendente {
    processo: Processo;
    exigencia: Exigencia;
    dias_restantes: number;
    esta_vencida: boolean;
}

// ==================== DASHBOARD ====================

export interface DashboardData {
    estatisticas_gerais: EstatisticasGerais;
    estatisticas_por_tipo: EstatisticasPorTipo[];
    estatisticas_mensais: EstatisticasMensais[];
    exigencias_pendentes: ExigenciaPendente[];
    processos_recentes: Processo[];
    notificacoes_recentes: Notificacao[];
}

// ==================== NOTIFICAÇÕES ====================

export interface Notificacao {
    id: string;
    processo_id: string;
    processo?: Processo;
    tipo: 'MUDANCA_STATUS' | 'EXIGENCIA' | 'PRAZO_VENCENDO' | 'PRAZO_VENCIDO';
    mensagem: string;
    lida: boolean;
    usuario_id?: string;
    created_at: Date;
}

export interface NotificacaoCreate {
    processo_id: string;
    tipo: 'MUDANCA_STATUS' | 'EXIGENCIA' | 'PRAZO_VENCENDO' | 'PRAZO_VENCIDO';
    mensagem: string;
    usuario_id?: string;
}

// ==================== FILTROS ====================

export interface FiltrosProcesso {
    status_inss?: StatusINSS[];
    status_fluxo?: StatusFluxo[];
    tipo_beneficio?: TipoBeneficio[];
    classe_final?: ClasseFinal[];
    data_inicio?: Date | string;
    data_fim?: Date | string;
    responsavel_id?: string;
    busca?: string; // CPF, nome ou protocolo
    apenas_com_exigencia?: boolean;
    apenas_vencidos?: boolean;
    page?: number;
    limit?: number;
}

export interface PaginatedResponse<T> {
    data: T[];
    total: number;
    page: number;
    limit: number;
    total_pages: number;
}

// ==================== API RESPONSES ====================

export interface ApiResponse<T = any> {
    success: boolean;
    data?: T;
    message?: string;
    errors?: Record<string, string[]>;
}

export interface ApiError {
    success: false;
    message: string;
    errors?: Record<string, string[]>;
    statusCode: number;
}

// ==================== WEBHOOK ====================

export interface WebhookEvent {
    event: string;
    data: any;
    idempotency_key: string;
    timestamp: string;
}

export interface WebhookCustomerEvent extends WebhookEvent {
    event: 'customer.created' | 'customer.updated' | 'customer.destroyed';
    data: TramitacaoCliente | { id: number };
}

export interface WebhookUserEvent extends WebhookEvent {
    event: 'user.created' | 'user.updated' | 'user.destroyed';
    data: any;
}
