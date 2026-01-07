/**
 * Script de Teste - Envio de Mensagem WhatsApp
 * 
 * Envia uma mensagem de teste para um número específico.
 * 
 * Uso: npx tsx src/scripts/test-whatsapp-msg.ts <NUMERO_DESTINO>
 * Exemplo: npx tsx src/scripts/test-whatsapp-msg.ts 5577988682628
 */

import whatsappService from '../services/WhatsAppService';

const numeroDestino = process.argv[2];

if (!numeroDestino) {
    console.log('\n❌ Erro: Número de destino não informado');
    console.log('\nUso: npx tsx src/scripts/test-whatsapp-msg.ts <NUMERO_DESTINO>');
    console.log('Exemplo: npx tsx src/scripts/test-whatsapp-msg.ts 5577988682628\n');
    process.exit(1);
}

// Mensagem de teste
const mensagemTeste = `📋 *INSS Manager - Mensagem de Teste*

Esta é uma mensagem de teste do sistema INSS Manager.

✅ Se você recebeu esta mensagem, a integração WhatsApp está funcionando corretamente!

---
Enviado em: ${new Date().toLocaleString('pt-BR')}
Sistema: INSS Manager v1.0.6`;

async function enviarMensagemTeste() {
    console.log('\n========================================');
    console.log('📱 TESTE DE ENVIO WHATSAPP');
    console.log('========================================\n');

    // Verificar status
    console.log('Verificando conexão WhatsApp...');
    const status = await whatsappService.obterStatus();

    if (!status.isReady) {
        console.log('❌ WhatsApp não está conectado!');
        console.log('   Conecte primeiro via extensão Chrome.\n');
        process.exit(1);
    }

    console.log('✅ WhatsApp conectado');
    console.log('   Número conectado:', status.numeroConectado);
    console.log('   Número destino:', numeroDestino);
    console.log('\nEnviando mensagem...\n');

    console.log('--- MENSAGEM ---');
    console.log(mensagemTeste);
    console.log('----------------\n');

    const sucesso = await whatsappService.enviar(numeroDestino, mensagemTeste);

    if (sucesso) {
        console.log('✅ Mensagem enviada com sucesso!\n');
    } else {
        console.log('❌ Falha ao enviar mensagem\n');
        console.log('Possíveis causas:');
        console.log('- Número não registrado no WhatsApp');
        console.log('- Formato do número incorreto');
        console.log('- Conexão instável\n');
    }

    console.log('========================================\n');
}

// Executar
enviarMensagemTeste()
    .then(() => {
        // Aguardar um pouco para garantir que a mensagem foi enviada
        setTimeout(() => process.exit(0), 2000);
    })
    .catch(err => {
        console.error('Erro:', err);
        process.exit(1);
    });



