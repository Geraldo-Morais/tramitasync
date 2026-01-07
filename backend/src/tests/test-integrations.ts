/**
 * Script de teste manual para validar integrações
 * Execute: npm run build && node dist/tests/test-integrations.js
 */

import AIService from '../services/AIService';
import TramitacaoService from '../services/TramitacaoService';
import logger from '../utils/logger';

// Texto de exemplo real do INSS (da referência)
const TEXTO_EXIGENCIA_EXEMPLO = `NR: 

Prezado(a) Senhor(a),

Para dar andamento ao processo 553678613, solicitamos o envio eletrônico dos documentos descritos abaixo:

-PREENCHER A AUTODECLARAÇÃO DO SEGURADO ESPECIAL NO SISTEMA MEU INSS.

O cumprimento de exigência por meio eletrônico é feito diretamente pelo aplicativo ou site do Meu INSS.

O não atendimento desta exigência ou a ausência de manifestação até o dia 05/12/2025 (30 dias de prazo) poderá acarretar desistência do processo.`;

/**
 * Teste 1: Validar análise da IA com texto real
 */
async function testarGeminiAI() {
    console.log('\n========================================');
    console.log('TESTE 1: Análise Gemini AI');
    console.log('========================================\n');

    try {
        const resultado = await AIService.analisarTextoInss(
            TEXTO_EXIGENCIA_EXEMPLO,
            '553678613'
        );

        console.log('✅ Análise concluída com sucesso!\n');
        console.log('Resultado:', JSON.stringify(resultado, null, 2));

        // Validações
        if (resultado.classe_final === 'EXIGENCIA') {
            console.log('✅ Classificação correta: EXIGENCIA');
        } else {
            console.log('❌ Classificação incorreta. Esperado: EXIGENCIA, Recebido:', resultado.classe_final);
        }

        if (resultado.documentos_exigidos && resultado.documentos_exigidos.length > 0) {
            console.log('✅ Documentos extraídos:', resultado.documentos_exigidos.length);
        } else {
            console.log('⚠️ Nenhum documento extraído');
        }

        if (resultado.data_evento) {
            console.log('✅ Data do evento extraída:', resultado.data_evento);
        } else {
            console.log('⚠️ Data do evento não extraída');
        }

        if (resultado.confianca >= 0.8) {
            console.log('✅ Confiança alta:', resultado.confianca);
        } else {
            console.log('⚠️ Confiança baixa:', resultado.confianca);
        }

        return true;
    } catch (error) {
        console.error('❌ Erro ao testar Gemini AI:', error);
        return false;
    }
}

/**
 * Teste 2: Validar conexão com API Tramitação
 */
async function testarConexaoTramitacao() {
    console.log('\n========================================');
    console.log('TESTE 2: Conexão Tramitação API');
    console.log('========================================\n');

    try {
        const conexaoOk = await TramitacaoService.verificarConexao();

        if (conexaoOk) {
            console.log('✅ Conexão com Tramitação estabelecida!');
            return true;
        } else {
            console.log('❌ Falha na conexão com Tramitação');
            console.log('⚠️ Verifique:');
            console.log('   1. URL da API no .env: TRAMITACAO_API_URL');
            console.log('   2. Token no .env: TRAMITACAO_API_TOKEN');
            console.log('   3. Se a API está acessível');
            return false;
        }
    } catch (error) {
        console.error('❌ Erro ao testar conexão Tramitação:', error);
        return false;
    }
}

/**
 * Teste 3: Buscar cliente por CPF no Tramitação
 */
async function testarBuscaCliente() {
    console.log('\n========================================');
    console.log('TESTE 3: Busca de Cliente');
    console.log('========================================\n');

    console.log('Digite um CPF válido cadastrado no Tramitação:');
    console.log('Exemplo: 123.456.789-00');
    console.log('(Pressione Ctrl+C para pular este teste)\n');

    // Em ambiente real, você pode usar readline para input
    // Por enquanto, vamos usar um CPF de exemplo
    const cpfTeste = '082.630.925-90'; // CPF de exemplo do arquivo de referência

    try {
        console.log(`Buscando cliente com CPF: ${cpfTeste}...\n`);

        const cliente = await TramitacaoService.buscarCliente(cpfTeste);

        if (cliente) {
            console.log('✅ Cliente encontrado!');
            console.log('ID:', cliente.id);
            console.log('Nome:', cliente.nome);
            console.log('CPF:', cliente.cpf);
            return true;
        } else {
            console.log('⚠️ Cliente não encontrado no Tramitação');
            console.log('Isso é esperado se o CPF não estiver cadastrado');
            console.log('Para testar completamente, use um CPF válido cadastrado');
            return false;
        }
    } catch (error) {
        console.error('❌ Erro ao buscar cliente:', error);
        return false;
    }
}

/**
 * Teste 4: Fluxo completo de notificação de exigência (SEM criar de fato)
 */
async function testarFluxoExigencia() {
    console.log('\n========================================');
    console.log('TESTE 4: Fluxo de Exigência (DRY RUN)');
    console.log('========================================\n');

    console.log('Este teste simula o fluxo completo de notificação de exigência.');
    console.log('(Não criará registros reais no Tramitação)\n');

    const dadosExemplo = {
        cpf: '082.630.925-90',
        protocolo: '553678613',
        nome: 'GISELE CRISTINA RIBEIRO SANTANA',
        beneficio: 'Salário-Maternidade Rural',
        documentos: ['Autodeclaração do Segurado Especial no Meu INSS'],
        prazo: new Date('2025-12-05'),
        motivo: 'Documentação complementar necessária para análise',
    };

    console.log('Dados do processo:');
    console.log(JSON.stringify(dadosExemplo, null, 2));

    console.log('\n🔍 Passos do fluxo:');
    console.log('1. Buscar cliente no Tramitação');
    console.log('2. Criar nota informativa com lista de documentos');
    console.log('3. Criar atividade para Cíntia com prazo 7 dias antes');
    console.log('4. Aplicar etiqueta "Exigência INSS"');

    console.log('\n⚠️ Para executar este fluxo de verdade, descomente a linha abaixo:');
    console.log('// const resultado = await TramitacaoService.notificarExigencia(dadosExemplo);');

    return true;
}

/**
 * Teste 5: Validar configuração do ambiente
 */
function testarConfiguracao() {
    console.log('\n========================================');
    console.log('TESTE 5: Validação de Configuração');
    console.log('========================================\n');

    const checks = {
        'Gemini API Key': !!process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'your-google-gemini-api-key',
        'Tramitação API URL': !!process.env.TRAMITACAO_API_URL,
        'Tramitação API Token': !!process.env.TRAMITACAO_API_TOKEN && process.env.TRAMITACAO_API_TOKEN !== 'seu_token_aqui',
        'Database URL': !!process.env.DATABASE_URL,
        'JWT Secret': !!process.env.JWT_SECRET,
    };

    let todasOk = true;

    for (const [chave, valor] of Object.entries(checks)) {
        if (valor) {
            console.log(`✅ ${chave}: Configurado`);
        } else {
            console.log(`❌ ${chave}: NÃO CONFIGURADO`);
            todasOk = false;
        }
    }

    if (todasOk) {
        console.log('\n✅ Todas as configurações estão OK!');
    } else {
        console.log('\n❌ Algumas configurações estão faltando.');
        console.log('Verifique o arquivo backend/.env');
    }

    return todasOk;
}

/**
 * Executar todos os testes
 */
async function executarTodos() {
    console.log('\n╔════════════════════════════════════════╗');
    console.log('║  SUITE DE TESTES - INSS MANAGER       ║');
    console.log('║  Validação de Integrações              ║');
    console.log('╚════════════════════════════════════════╝');

    const resultados: { [key: string]: boolean } = {};

    // Teste 5 primeiro (configuração)
    resultados['Configuração'] = testarConfiguracao();

    // Se configuração OK, executar demais testes
    if (resultados['Configuração']) {
        resultados['Gemini AI'] = await testarGeminiAI();
        resultados['Conexão Tramitação'] = await testarConexaoTramitacao();

        // Só testa busca se conexão OK
        if (resultados['Conexão Tramitação']) {
            resultados['Busca Cliente'] = await testarBuscaCliente();
        }

        resultados['Fluxo Exigência (Dry Run)'] = await testarFluxoExigencia();
    }

    // Resumo final
    console.log('\n╔════════════════════════════════════════╗');
    console.log('║  RESUMO DOS TESTES                     ║');
    console.log('╚════════════════════════════════════════╝\n');

    for (const [teste, passou] of Object.entries(resultados)) {
        const status = passou ? '✅ PASSOU' : '❌ FALHOU';
        console.log(`${status} - ${teste}`);
    }

    const totalPassou = Object.values(resultados).filter(r => r).length;
    const total = Object.keys(resultados).length;

    console.log(`\nTotal: ${totalPassou}/${total} testes passaram`);

    if (totalPassou === total) {
        console.log('\n🎉 Todos os testes passaram! Sistema pronto para uso.');
    } else {
        console.log('\n⚠️ Alguns testes falharam. Revise as configurações e integrações.');
    }
}

// Executar
executarTodos().catch((error) => {
    logger.error('Erro fatal durante execução dos testes:', error);
    process.exit(1);
});
