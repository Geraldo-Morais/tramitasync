/**
 * Script de Teste - Sincronização Simulada
 * 
 * Simula todo o fluxo da plataforma com dados fictícios,
 * sem necessidade de PAT Token real.
 * 
 * Uso: npx tsx src/scripts/test-sync-simulado.ts
 */

import logger from '../utils/logger';
import whatsappService from '../services/WhatsAppService';

// Dados simulados do INSS
const dadosSimuladosINSS = {
    protocolo: '35024.012345/2025-00',
    cpf: '123.456.789-00',
    nome: 'MARIA SILVA DOS SANTOS',
    beneficio: 'APOSENTADORIA POR IDADE',
    nb: '123.456.789-0',
    situacao: 'EM EXIGÊNCIA',
    dataRequerimento: '15/10/2025',
    dataUltimaAtualizacao: '28/11/2025',
    exigencias: [
        {
            codigo: 'EX001',
            descricao: 'Apresentar extrato CNIS atualizado',
            prazo: '15/12/2025'
        },
        {
            codigo: 'EX002',
            descricao: 'Comprovante de residência atual',
            prazo: '15/12/2025'
        }
    ],
    agendamento: {
        data: '20/01/2026',
        hora: '14:30',
        local: 'APS Vitória da Conquista',
        tipo: 'Perícia Médica'
    }
};

// Análise simulada da IA
const analiseIA = {
    tipo: 'EXIGÊNCIA',
    urgencia: 'ALTA',
    prazo_dias: 16,
    resumo: 'Cliente precisa apresentar 2 documentos até 15/12/2025',
    documentos_necessarios: [
        'Extrato CNIS atualizado (obter no Meu INSS ou agência)',
        'Comprovante de residência recente (últimos 3 meses)'
    ],
    recomendacao: 'Entrar em contato urgente com o cliente para reunir documentação'
};

// Função para gerar mensagem WhatsApp
function gerarMensagemWhatsApp(dados: typeof dadosSimuladosINSS, analise: typeof analiseIA): string {
    let msg = `📋 *INSS Manager - Atualização de Processo*\n\n`;
    msg += `Cliente: ${dados.nome}\n`;
    msg += `Protocolo: ${dados.protocolo}\n`;
    msg += `Benefício: ${dados.beneficio}\n\n`;

    msg += `⚠️ *Status: ${dados.situacao}*\n\n`;

    if (dados.exigencias && dados.exigencias.length > 0) {
        msg += `📄 Documentos necessários até ${dados.exigencias[0].prazo}:\n`;
        dados.exigencias.forEach(ex => {
            msg += `• ${ex.descricao}\n`;
        });
        msg += '\n';
    }

    if (dados.agendamento) {
        msg += `📅 Agendamento detectado:\n`;
        msg += `${dados.agendamento.data} às ${dados.agendamento.hora} - ${dados.agendamento.local}\n\n`;
    }

    msg += `💡 Recomendação: ${analise.recomendacao}\n\n`;
    msg += `---\nGerado automaticamente pelo INSS Manager`;

    return msg;
}

async function executarTesteSimulado() {
    console.log('\n========================================');
    console.log('🧪 TESTE DE SINCRONIZAÇÃO SIMULADA');
    console.log('========================================\n');

    // Etapa 1: Simular consulta INSS
    console.log('📡 ETAPA 1: Consultando INSS (SIMULADO)...');
    console.log('   CPF:', dadosSimuladosINSS.cpf);
    console.log('   Protocolo encontrado:', dadosSimuladosINSS.protocolo);
    console.log('   Status:', dadosSimuladosINSS.situacao);
    console.log('   ✅ Dados obtidos com sucesso\n');

    // Etapa 2: Análise da IA
    console.log('🤖 ETAPA 2: Analisando com IA (SIMULADO)...');
    console.log('   Tipo:', analiseIA.tipo);
    console.log('   Urgência:', analiseIA.urgencia);
    console.log('   Prazo:', analiseIA.prazo_dias, 'dias');
    console.log('   Resumo:', analiseIA.resumo);
    console.log('   ✅ Análise concluída\n');

    // Etapa 3: Comparação com Tramitação (simulada)
    console.log('🔄 ETAPA 3: Comparando com Tramitação (SIMULADO)...');
    console.log('   Diferenças detectadas:');
    console.log('   - Status mudou: "EM ANÁLISE" → "EM EXIGÊNCIA"');
    console.log('   - 2 novas exigências identificadas');
    console.log('   - Agendamento para 20/01/2026 encontrado');
    console.log('   ✅ Comparação concluída\n');

    // Etapa 4: Atualização no Tramitação (simulada)
    console.log('📝 ETAPA 4: Atualizando Tramitação (SIMULADO)...');
    console.log('   - Adicionando etiqueta: EXIGÊNCIA');
    console.log('   - Adicionando nota com análise da IA');
    console.log('   - Criando lembrete para prazo (15/12/2025)');
    console.log('   - Criando lembrete 30 dias antes agendamento');
    console.log('   ✅ Tramitação atualizada\n');

    // Etapa 5: Envio WhatsApp
    console.log('📱 ETAPA 5: Enviando notificação WhatsApp...');

    const mensagem = gerarMensagemWhatsApp(dadosSimuladosINSS, analiseIA);
    console.log('\n--- MENSAGEM A SER ENVIADA ---');
    console.log(mensagem);
    console.log('------------------------------\n');

    // Verificar se WhatsApp está conectado
    const status = await whatsappService.obterStatus();

    if (status.isReady) {
        console.log('   WhatsApp conectado! Número:', status.numeroConectado);

        // Perguntar se quer enviar de verdade
        console.log('\n⚠️  ATENÇÃO: O WhatsApp está conectado.');
        console.log('   Para enviar a mensagem de teste, execute:');
        console.log('   npx tsx src/scripts/test-whatsapp-msg.ts <NUMERO_DESTINO>');
        console.log('   Exemplo: npx tsx src/scripts/test-whatsapp-msg.ts 5577988682628\n');
    } else {
        console.log('   ⚠️ WhatsApp não conectado - mensagem não será enviada');
        console.log('   Conecte o WhatsApp primeiro via extensão\n');
    }

    // Resumo final
    console.log('========================================');
    console.log('✅ TESTE SIMULADO CONCLUÍDO');
    console.log('========================================');
    console.log('\nResumo da sincronização:');
    console.log('- 1 processo consultado');
    console.log('- 1 análise de IA gerada');
    console.log('- 1 cliente atualizado no Tramitação');
    console.log('- 2 lembretes criados');
    console.log('- 1 notificação WhatsApp preparada');
    console.log('\n');
}

// Executar
executarTesteSimulado()
    .then(() => process.exit(0))
    .catch(err => {
        console.error('Erro:', err);
        process.exit(1);
    });



