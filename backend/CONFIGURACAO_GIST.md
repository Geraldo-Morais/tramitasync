# 🔧 Configuração do GitHub Gist para Descoberta de URL

## O Problema

Quando você usa ngrok (plano free), a URL muda **a cada reinício**. A extensão Chrome precisa saber qual é a URL atual do backend.

## A Solução Automática

O backend atualiza automaticamente um GitHub Gist com a URL do ngrok. A extensão lê esse Gist para descobrir a URL atual.

## Como Configurar

### 1. Criar um Personal Access Token no GitHub

1. Acesse: https://github.com/settings/tokens
2. Clique em "Generate new token (classic)"
3. Marque a permissão: `gist`
4. Clique em "Generate token"
5. **COPIE O TOKEN** (ele só aparece uma vez!)

### 2. Adicionar as Variáveis no `.env` do Backend

Adicione estas linhas no arquivo `backend/.env`:

```env
# Descoberta de URL (OBRIGATÓRIO para extensão funcionar remotamente)
URL_DISCOVERY_SERVICE=gist
GITHUB_TOKEN=ghp_seu_token_aqui
GIST_ID=09c33aba43ad48e7f9c9932671a273b7
```

### 3. Reiniciar o Backend

```bash
cd backend
npm run dev
```

O backend irá:
1. Iniciar o ngrok
2. Obter a nova URL pública
3. Atualizar automaticamente o Gist

### 4. Verificar se Funcionou

Rode o script de verificação:

```powershell
.\extrair-url-gist.ps1
```

Ou acesse o Gist diretamente:
https://gist.githubusercontent.com/Geraldo-Morais/09c33aba43ad48e7f9c9932671a273b7/raw/ngrok-url.json

## Troubleshooting

### Erro 404 na Extensão

Significa que o Gist tem uma URL antiga. Soluções:

1. **Verifique se o backend está rodando**: O Gist só é atualizado quando o backend inicia
2. **Verifique o GITHUB_TOKEN**: Deve ter permissão de `gist`
3. **Verifique os logs do backend**: Procure por "URL atualizada no GitHub Gist"

### O Gist Não Atualiza

1. Verifique se `URL_DISCOVERY_SERVICE=gist` está no .env
2. Verifique se o token tem permissão de gist
3. Reinicie o backend completamente

### Onde Ver a URL Atual

- No terminal do backend, procure: `🌐 Túnel público: https://xxx.ngrok-free.dev`
- Ou acesse: http://localhost:3000/api/v1/system/public-url

## Fluxo Completo

```
1. Backend inicia
   ↓
2. NgrokTunnelService mata processos ngrok antigos
   ↓
3. NgrokTunnelService inicia novo túnel ngrok
   ↓
4. Ngrok retorna nova URL (ex: https://abc123.ngrok-free.dev)
   ↓
5. NgrokTunnelService chama UrlDiscoveryService
   ↓
6. UrlDiscoveryService atualiza o Gist com a nova URL
   ↓
7. Extensão lê o Gist e descobre a URL
   ↓
8. Extensão faz requisições para o backend! ✅
```

## Variáveis de Ambiente Completas

```env
# === DESCOBERTA DE URL ===
# Tipo: gist (recomendado), hastebin, pastebin, 0x0
URL_DISCOVERY_SERVICE=gist

# Token do GitHub (com permissão de gist)
GITHUB_TOKEN=ghp_xxxxxxxxxxxx

# ID do seu Gist (para manter URL fixa)
GIST_ID=09c33aba43ad48e7f9c9932671a273b7

# === OPCIONAL ===
# Desabilitar ngrok (útil se usar URL fixa em produção)
DISABLE_NGROK_TUNNEL=false
```



