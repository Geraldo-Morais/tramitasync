# 🧪 Testes de Integração - INSS Manager

## Objetivo

Validar as integrações críticas do sistema:
- ✅ Gemini AI (análise de textos)
- ✅ Tramitação Inteligente API (CRM)
- ✅ Configuração do ambiente

## Como Executar

```bash
cd backend
npm run build
node dist/tests/test-integrations.js
```

## Testes Incluídos

### 1. Validação de Configuração
Verifica se todas as variáveis de ambiente estão configuradas:
- `GEMINI_API_KEY`
- `TRAMITACAO_API_URL`
- `TRAMITACAO_API_TOKEN`
- `DATABASE_URL`
- `JWT_SECRET`

### 2. Análise Gemini AI
Testa a análise de um texto real de exigência do INSS:
- ✅ Classificação correta (EXIGENCIA)
- ✅ Extração de documentos
- ✅ Extração de data limite
- ✅ Confiança ≥ 0.8

### 3. Conexão Tramitação API
Verifica se a API está acessível e autenticada.

### 4. Busca de Cliente
Testa o endpoint de busca por CPF no Tramitação.

### 5. Fluxo de Exigência (Dry Run)
Simula o fluxo completo sem criar registros reais:
- Buscar cliente
- Criar nota
- Criar atividade
- Aplicar etiqueta

## Resultado Esperado

```
╔════════════════════════════════════════╗
║  RESUMO DOS TESTES                     ║
╚════════════════════════════════════════╝

✅ PASSOU - Configuração
✅ PASSOU - Gemini AI
✅ PASSOU - Conexão Tramitação
⚠️ FALHOU - Busca Cliente (normal se CPF não cadastrado)
✅ PASSOU - Fluxo Exigência (Dry Run)

Total: 4/5 testes passaram

🎉 Todos os testes passaram! Sistema pronto para uso.
```

## Troubleshooting

### ❌ "Gemini API error: 400"
- Verifique se `GEMINI_API_KEY` está correto
- Teste a key em: https://makersuite.google.com/

### ❌ "Tramitacao API error: 401"
- Verifique se `TRAMITACAO_API_TOKEN` está correto
- Token atual: `GPmQGP32jFcsGAoYeRxe9Lo6JoHn9PjkRRTuHXDmAhsK`

### ❌ "Connection timeout"
- Verifique se `TRAMITACAO_API_URL` está correto
- URL esperada: `https://api.tramitacaointeligente.com.br`

## Testes Manuais com Postman

### Buscar Clientes
```
GET {{tramitacao_url}}/clientes
Authorization: Bearer {{tramitacao_token}}
```

### Criar Nota
```
POST {{tramitacao_url}}/notas
Authorization: Bearer {{tramitacao_token}}
Content-Type: application/json

{
  "cliente_id": "ID_DO_CLIENTE",
  "titulo": "Teste de Integração",
  "texto": "Nota teste",
  "tipo": "INFORMACAO"
}
```

### Criar Atividade
```
POST {{tramitacao_url}}/atividades
Authorization: Bearer {{tramitacao_token}}
Content-Type: application/json

{
  "cliente_id": "ID_DO_CLIENTE",
  "titulo": "Atividade Teste",
  "descricao": "Descrição da atividade",
  "responsavel": "cintia",
  "prazo": "2025-12-31T23:59:59.000Z",
  "prioridade": "ALTA"
}
```

## Próximos Passos

Após todos os testes passarem:

1. ✅ Executar Worker completo: `npm run worker:manual`
2. ✅ Validar criação de registros no banco
3. ✅ Verificar integração Tramitação em produção
4. ✅ Configurar Cron para execução automática (8h e 14h)
