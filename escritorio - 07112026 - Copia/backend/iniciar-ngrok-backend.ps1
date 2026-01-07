# Script para iniciar ngrok e backend juntos
# Uso: .\iniciar-ngrok-backend.ps1

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "🚀 Iniciando Backend + ngrok" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Verificar se ngrok.exe existe
if (-not (Test-Path ".\ngrok.exe")) {
    Write-Host "❌ ngrok.exe não encontrado na pasta backend!" -ForegroundColor Red
    Write-Host "   Coloque o ngrok.exe na pasta backend ou ajuste o caminho" -ForegroundColor Yellow
    exit 1
}

# Verificar se backend já está rodando
$backendProcess = Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { 
    $_.Path -like "*escritorio*" -or $_.CommandLine -like "*npm*dev*"
}

if ($backendProcess) {
    Write-Host "⚠️  Backend já está rodando (PID: $($backendProcess.Id))" -ForegroundColor Yellow
    $resposta = Read-Host "Deseja encerrar e reiniciar? (S/N)"
    if ($resposta -eq "S" -or $resposta -eq "s") {
        Stop-Process -Id $backendProcess.Id -Force
        Start-Sleep -Seconds 2
        Write-Host "✅ Processo anterior encerrado" -ForegroundColor Green
    } else {
        Write-Host "ℹ️  Continuando com o processo existente..." -ForegroundColor Yellow
    }
}

# Verificar se ngrok já está rodando
$ngrokProcess = Get-Process -Name ngrok -ErrorAction SilentlyContinue
if ($ngrokProcess) {
    Write-Host "⚠️  ngrok já está rodando (PID: $($ngrokProcess.Id))" -ForegroundColor Yellow
    $resposta = Read-Host "Deseja encerrar e reiniciar? (S/N)"
    if ($resposta -eq "S" -or $resposta -eq "s") {
        Stop-Process -Id $ngrokProcess.Id -Force
        Start-Sleep -Seconds 2
        Write-Host "✅ ngrok anterior encerrado" -ForegroundColor Green
    } else {
        Write-Host "ℹ️  Continuando com ngrok existente..." -ForegroundColor Yellow
    }
}

# Iniciar backend em nova janela
Write-Host ""
Write-Host "📦 Iniciando backend na porta 3000..." -ForegroundColor Yellow
$backendWindow = Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$PWD'; npm run dev" -PassThru

# Aguardar backend iniciar
Write-Host "⏳ Aguardando backend iniciar (5 segundos)..." -ForegroundColor Yellow
Start-Sleep -Seconds 5

# Verificar se backend está respondendo
try {
    $response = Invoke-WebRequest -Uri "http://localhost:3000/health" -TimeoutSec 2 -ErrorAction Stop
    Write-Host "✅ Backend está respondendo!" -ForegroundColor Green
} catch {
    Write-Host "⚠️  Backend ainda não está respondendo, mas continuando..." -ForegroundColor Yellow
    Write-Host "   Verifique a janela do backend para erros" -ForegroundColor Yellow
}

# Iniciar ngrok em nova janela
Write-Host ""
Write-Host "🌐 Iniciando ngrok (túnel para porta 3000)..." -ForegroundColor Yellow
$ngrokWindow = Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$PWD'; .\ngrok.exe http 3000" -PassThru

# Aguardar ngrok iniciar
Write-Host "⏳ Aguardando ngrok iniciar (5 segundos)..." -ForegroundColor Yellow
Start-Sleep -Seconds 5

# Obter URL do ngrok
Write-Host ""
Write-Host "🔍 Obtendo URL pública do ngrok..." -ForegroundColor Yellow
Start-Sleep -Seconds 3

try {
    $tunnels = Invoke-RestMethod -Uri "http://localhost:4040/api/tunnels" -ErrorAction Stop
    if ($tunnels.tunnels -and $tunnels.tunnels.Count -gt 0) {
        $url = $tunnels.tunnels[0].public_url
        $apiUrl = "$url/api/v1"
        
        Write-Host ""
        Write-Host "========================================" -ForegroundColor Green
        Write-Host "✅ TUDO PRONTO!" -ForegroundColor Green
        Write-Host "========================================" -ForegroundColor Green
        Write-Host ""
        Write-Host "🌐 URL Pública (ngrok):" -ForegroundColor Cyan
        Write-Host "   $url" -ForegroundColor White
        Write-Host ""
        Write-Host "🔗 URL da API (para extensão):" -ForegroundColor Cyan
        Write-Host "   $apiUrl" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "📋 INSTRUÇÕES:" -ForegroundColor Cyan
        Write-Host "   1. Acesse o Tramitação Inteligente" -ForegroundColor White
        Write-Host "   2. Clique em 'Sincronizar (INSS)'" -ForegroundColor White
        Write-Host "   3. Quando pedir a URL da API, cole:" -ForegroundColor White
        Write-Host "      $apiUrl" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "💡 Para ver o dashboard do ngrok:" -ForegroundColor Cyan
        Write-Host "   http://localhost:4040" -ForegroundColor White
        Write-Host ""
        Write-Host "⚠️  Para parar, feche as janelas do backend e ngrok" -ForegroundColor Yellow
        Write-Host ""
        
        # Copiar URL para clipboard
        $apiUrl | Set-Clipboard
        Write-Host "✅ URL da API copiada para área de transferência!" -ForegroundColor Green
        Write-Host ""
    } else {
        Write-Host "⚠️  ngrok iniciado mas nenhum túnel encontrado ainda" -ForegroundColor Yellow
        Write-Host "   Aguarde alguns segundos e verifique: http://localhost:4040" -ForegroundColor Yellow
    }
} catch {
    Write-Host "⚠️  Não foi possível obter URL do ngrok automaticamente" -ForegroundColor Yellow
    Write-Host "   Verifique manualmente: http://localhost:4040" -ForegroundColor Yellow
    Write-Host "   Ou aguarde alguns segundos e execute: .\obter-url-ngrok.ps1" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "✅ Backend e ngrok iniciados em janelas separadas" -ForegroundColor Green
Write-Host "   Mantenha essas janelas abertas enquanto usar a extensão" -ForegroundColor Yellow
Write-Host ""

