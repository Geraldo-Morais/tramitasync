/**
 * Script de inicialização de desenvolvimento
 * 
 * Garante que a porta está livre antes de iniciar o servidor
 * Mata processos anteriores se necessário
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const PORT = process.env.PORT || 3000;

async function matarProcessosNaPorta(porta: number): Promise<void> {
    console.log(`🔍 Verificando porta ${porta}...`);

    try {
        // Windows: encontrar PIDs usando a porta
        const { stdout } = await execAsync(`netstat -ano | findstr :${porta}`);

        if (!stdout || stdout.trim() === '') {
            console.log(`✅ Porta ${porta} está livre`);
            return;
        }

        // Extrair PIDs únicos
        const lines = stdout.trim().split('\n');
        const pids = new Set<string>();

        lines.forEach(line => {
            const parts = line.trim().split(/\s+/);
            const pid = parts[parts.length - 1];
            // Não matar o processo atual nem o PID 0
            if (pid && pid !== '0' && parseInt(pid) !== process.pid) {
                pids.add(pid);
            }
        });

        if (pids.size === 0) {
            console.log(`✅ Porta ${porta} está livre`);
            return;
        }

        console.log(`⚠️  Encontrados ${pids.size} processos usando a porta ${porta}`);

        // Matar cada processo
        for (const pid of pids) {
            try {
                console.log(`   Matando processo PID ${pid}...`);
                await execAsync(`taskkill /PID ${pid} /F`);
            } catch (error) {
                // Processo pode já ter sido encerrado
            }
        }

        // Aguardar um pouco para a porta ser liberada
        await new Promise(resolve => setTimeout(resolve, 1000));
        console.log(`✅ Processos finalizados`);

    } catch (error: any) {
        // Se o comando falhar, provavelmente não há processos na porta
        if (!error.message.includes('findstr')) {
            console.log(`✅ Porta ${porta} está livre`);
        }
    }
}

async function matarNgrokResidual(): Promise<void> {
    try {
        console.log('🔍 Verificando ngrok residual...');
        await execAsync('taskkill /IM ngrok.exe /F 2>nul');
        console.log('✅ Ngrok anterior finalizado');
    } catch (error) {
        // Ngrok não estava rodando
    }
}

async function main(): Promise<void> {
    console.log('\n========================================');
    console.log('🚀 Iniciando ambiente de desenvolvimento');
    console.log('========================================\n');

    // Matar processos na porta
    await matarProcessosNaPorta(Number(PORT));

    // Matar ngrok residual
    await matarNgrokResidual();

    console.log('\n📦 Iniciando servidor...\n');

    // Iniciar o servidor usando tsx watch
    const child = spawn('npx', ['tsx', 'watch', 'src/server.ts'], {
        stdio: 'inherit',
        shell: true,
        cwd: process.cwd()
    });

    child.on('error', (error) => {
        console.error('❌ Erro ao iniciar servidor:', error);
        process.exit(1);
    });

    // Propagar sinais para o processo filho
    process.on('SIGINT', () => {
        child.kill('SIGINT');
    });

    process.on('SIGTERM', () => {
        child.kill('SIGTERM');
    });
}

main().catch(error => {
    console.error('❌ Erro fatal:', error);
    process.exit(1);
});



