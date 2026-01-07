# Workers - Automação INSS

Este diretório contém os workers de automação responsáveis pela coleta e processamento de dados do INSS.

## 📋 InssWorker

Worker principal que orquestra todo o fluxo de automação.

### Fluxo de Execução

```
┌─────────────────────────────────────────────────────────────────┐
│                         CRON JOB                                │
│                    2x ao dia (8h e 14h)                         │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                   1. PUPPETEER SERVICE                          │
│               • Login no sistema INSS                           │
│               • Coleta lista de protocolos                      │
│               • Extração de dados de cada protocolo             │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                      2. AI SERVICE                              │
│               • Envia texto bruto para Gemini AI                │
│               • Análise e classificação automática              │
│               • Extração de documentos exigidos                 │
│               • Detecção de datas de eventos                    │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                   3. COMPARAÇÃO COM BD                          │
│               • Busca processo existente                        │
│               • Compara status anterior vs novo                 │
│               • Detecta mudanças significativas                 │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                  4. PERSISTÊNCIA (PostgreSQL)                   │
│               • Atualiza/Insere processo                        │
│               • Registra histórico de status                    │
│               • Armazena análise da IA                          │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                 5. TRAMITAÇÃO SERVICE                           │
│               • Busca cliente pelo CPF                          │
│               • Cria notas informativas                         │
│               • Cria atividades/tarefas                         │
│               • Aplica etiquetas                                │
│               • Cria agendamentos (perícias)                    │
└─────────────────────────────────────────────────────────────────┘
```

### Ações por Status

#### 🔴 EXIGÊNCIA Detectada

```typescript
1. Criar Nota de Alerta no Tramitação
   - Título: "⚠️ EXIGÊNCIA Detectada - Protocolo [X]"
   - Texto: Motivo da exigência + lista de documentos

2. Criar Atividade para Intermediação (Cíntia)
   - Título: "Contatar Colaborador - Exigência INSS"
   - Responsável: "intermediacao"
   - Prioridade: ALTA

3. Aplicar Etiqueta
   - "Status: Em Exigência"
```

#### 🟢 DEFERIDO

```typescript
1. Criar Nota de Sucesso
   - Título: "🎉 REQUERIMENTO DEFERIDO"
   - Texto: Motivo da concessão

2. Aplicar Etiqueta
   - "Resultado: Deferido"
```

#### 🔴 INDEFERIDO

```typescript
1. Criar Nota Urgente
   - Título: "❌ REQUERIMENTO INDEFERIDO"
   - Texto: Motivo do indeferimento

2. Criar Atividade para Judicial
   - Título: "Avaliar Ação Judicial"
   - Responsável: "judicial"
   - Prioridade: URGENTE

3. Aplicar Etiqueta
   - "Resultado: Indeferido"
```

#### 📅 PERÍCIA Agendada

```typescript
1. Criar Agendamento
   - Data detectada pela IA
   - Local: Agência INSS

2. Criar Nota Informativa
   - Título: "📅 Perícia Agendada - [DATA]"

3. Aplicar Etiqueta
   - "Status: Perícia Agendada"
```

## 🧠 AIService

Serviço de análise de texto usando Google Gemini AI.

### Prompt Otimizado

O prompt é estruturado para extrair:

1. **classe_final**: Classificação do status
   - `DEFERIDO` | `INDEFERIDO` | `EXIGENCIA` | `PERICIA` | `RECURSO` | `CANCELADO` | `EM_ANALISE`

2. **motivo_ia**: Explicação clara do status

3. **documentos_exigidos**: Array de documentos solicitados (se exigência)

4. **data_evento**: Data de agendamento (se perícia/avaliação)

5. **confianca**: Score de 0.0 a 1.0

### Exemplo de Resposta da IA

```json
{
  "classe_final": "EXIGENCIA",
  "motivo_ia": "Solicitada complementação de documentação para análise do benefício",
  "documentos_exigidos": [
    "Laudo médico atualizado (últimos 90 dias)",
    "Comprovante de renda familiar",
    "Documentos pessoais do grupo familiar"
  ],
  "data_evento": null,
  "confianca": 0.92
}
```

## 🌐 PuppeteerService

Serviço de web scraping do portal INSS usando Puppeteer.

### Funcionalidades

1. **initialize()**: Inicia navegador (headless ou com interface)
2. **login()**: Autentica no sistema INSS
3. **coletarProtocolos()**: Busca protocolos por período
4. **extrairDetalhesProcesso()**: Extrai dados completos de um protocolo
5. **screenshot()**: Tira prints para debug

### Configurações

```env
INSS_URL=https://atendimento.inss.gov.br
INSS_HEADLESS=true  # false para ver o navegador
```

### Anti-Detecção

- User-Agent customizado
- Delays entre requisições (2 segundos)
- Viewport realista (1920x1080)

### ⚠️ TODO: Implementação Específica

Os métodos estão estruturados mas precisam ser **adaptados ao layout real do sistema INSS**:

```typescript
// Exemplo de seletores a serem descobertos:
await this.page.type('#campo-usuario', username);
await this.page.type('#campo-senha', password);
await this.page.click('#botao-login');
```

**Como descobrir os seletores:**
1. Acessar o sistema INSS manualmente
2. Abrir DevTools (F12)
3. Usar "Inspecionar Elemento"
4. Copiar seletores CSS ou XPath

## 🔌 TramitacaoService

Cliente HTTP para integração com API do Tramitação Inteligente.

### Métodos Principais

```typescript
// Buscar cliente pelo CPF
const cliente = await tramitacaoService.buscarCliente('123.456.789-00');

// Criar nota
await tramitacaoService.criarNota(cliente.id, {
  titulo: 'Título da nota',
  texto: 'Conteúdo da nota',
  tipo: 'ALERTA'
});

// Criar atividade/tarefa
await tramitacaoService.criarAtividade(cliente.id, {
  titulo: 'Tarefa para fulano',
  descricao: 'Descrição detalhada',
  responsavel: 'intermediacao',
  prazo: new Date('2025-12-31'),
  prioridade: 'ALTA'
});

// Aplicar etiqueta
await tramitacaoService.aplicarEtiqueta(cliente.id, 'Status: Em Análise');

// Criar agendamento (perícia, etc)
await tramitacaoService.criarAgendamento(cliente.id, {
  titulo: 'Perícia Médica',
  descricao: 'Perícia agendada pelo INSS',
  data: new Date('2025-11-20'),
  local: 'Agência INSS Centro'
});
```

### Fallbacks

Se a API do Tramitação não tiver endpoints específicos:
- **Atividades**: Cria como nota especial `📋 TAREFA: ...`
- **Agendamentos**: Cria como atividade com prazo

## 🚀 Como Usar

### 1. Configurar .env

```env
# Google Gemini AI
GEMINI_API_KEY=your_api_key_here
GEMINI_MODEL=gemini-1.5-flash

# INSS
INSS_URL=https://atendimento.inss.gov.br
INSS_CRON_SCHEDULE=0 8,14 * * *
INSS_HEADLESS=true

# Tramitação
TRAMITACAO_API_URL=https://tramitacaointeligente.com.br/api/v1
TRAMITACAO_API_TOKEN=seu_token_aqui
```

### 2. Iniciar Worker no Server

```typescript
// backend/src/server.ts
import inssWorker from './workers/InssWorker';

// Iniciar worker
inssWorker.start();
```

### 3. Execução Manual (para testes)

```typescript
import inssWorker from './workers/InssWorker';

// Executar imediatamente
await inssWorker.runManual();
```

## 📊 Logs

O worker gera logs detalhados:

```
[InssWorker] ========== INICIANDO COLETA ==========
[Puppeteer] Iniciando navegador...
[Puppeteer] Login realizado com sucesso
[Puppeteer] Coletando protocolos de 28/10/2025 a 04/11/2025
[Puppeteer] 15 protocolos encontrados
[InssWorker] Processando protocolo 123456789
[Puppeteer] Extraindo detalhes do protocolo 123456789
[AIService] Analisando protocolo 123456789
[AIService] Protocolo 123456789 analisado: EXIGENCIA (confiança: 0.92)
[InssWorker] Mudança detectada no protocolo 123456789: EM_ANALISE → CUMPRIMENTO_DE_EXIGENCIA
[InssWorker] Tratando mudança de status: EXIGENCIA
[Tramitacao] Buscando cliente com CPF 12345678900
[Tramitacao] Cliente encontrado: João da Silva (ID: abc-123)
[Tramitacao] Criando nota para cliente abc-123
[Tramitacao] Nota criada com sucesso (ID: nota-456)
[Tramitacao] Criando atividade para cliente abc-123
[Tramitacao] Atividade criada com sucesso (ID: ativ-789)
[InssWorker] ========== COLETA FINALIZADA ==========
[InssWorker] Tempo total: 142s
[InssWorker] Processados: 15/15
[InssWorker] Mudanças detectadas: 3
[InssWorker] Erros: 0
```

## 🐛 Debugging

### Tirar Screenshots

```typescript
// Em qualquer ponto do código Puppeteer
await puppeteerService.screenshot('nome-do-debug');
// Salvo em: ./logs/screenshots/nome-do-debug-[timestamp].png
```

### Modo Visual (Não-Headless)

```env
INSS_HEADLESS=false
```

### Verificar Conexões

```typescript
// Verificar API do Tramitação
const ok = await tramitacaoService.verificarConexao();

// Verificar Login INSS
const logado = await puppeteerService.verificarLogin();

// Verificar Gemini AI
const configured = aiService.isConfigured();
```

## ⚙️ Configurações de Cron

```
# Formato: minuto hora dia mês dia-da-semana

0 8,14 * * *     # 8h e 14h todos os dias (padrão)
0 */2 * * *      # A cada 2 horas
0 9-17 * * 1-5   # Horário comercial (9h-17h, seg-sex)
*/30 * * * *     # A cada 30 minutos (teste)
```

## 🔧 Tratamento de Erros

### Retry Logic

```typescript
// TODO: Implementar retry com backoff exponencial
for (let tentativa = 1; tentativa <= 3; tentativa++) {
  try {
    await processarProtocolo(protocolo);
    break;
  } catch (error) {
    if (tentativa === 3) throw error;
    await delay(Math.pow(2, tentativa) * 1000); // 2s, 4s, 8s
  }
}
```

### CAPTCHA

```typescript
// TODO: Implementar solução
// Opções:
// 1. Serviço de terceiros (2Captcha, Anti-Captcha)
// 2. Notificar operador humano
// 3. IA para resolver (complexo)
```

## 📈 Métricas e Monitoramento

### Futuros Melhorias

1. **Dashboard de Monitoramento**
   - Processos coletados por dia
   - Taxa de sucesso
   - Tempo médio de execução
   - Erros por tipo

2. **Alertas**
   - Notificar se worker falhar
   - Alertar se taxa de erro > 10%
   - Notificar se IA tiver baixa confiança

3. **Rate Limiting**
   - Controlar requisições ao INSS
   - Evitar bloqueio por abuso

4. **Cache**
   - Cachear protocolos já processados
   - Evitar reprocessamento desnecessário

## 🚨 Segurança

### Credenciais

```typescript
// NUNCA hardcodar credenciais
// ❌ BAD
const senha = '123456';

// ✅ GOOD
const senha = process.env.INSS_PASSWORD;
```

### Logs

```typescript
// Não logar dados sensíveis
logger.info(`Login com CPF ${cpf.replace(/\d(?=\d{3})/g, '*')}`);
// Resultado: Login com CPF ***.456.789-00
```

## 📚 Referências

- [Puppeteer Docs](https://pptr.dev/)
- [Google Gemini API](https://ai.google.dev/docs)
- [node-cron](https://github.com/node-cron/node-cron)
- [Tramitação Inteligente API](https://tramitacaointeligente.com.br/docs)
