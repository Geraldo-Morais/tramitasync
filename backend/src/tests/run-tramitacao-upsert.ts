import TramitacaoService from '../services/TramitacaoService';
import logger from '../utils/logger';

const DADOS_PADRAO = {
    cpf: '082.630.925-90',
    nome: 'GISELE CRISTINA RIBEIRO SANTANA',
    protocolo: '553678613',
    servico: 'Salário-Maternidade Rural',
    prazo: new Date('2025-12-05T00:00:00Z'),
    documentos: ['Autodeclaração do Segurado Especial no Meu INSS'],
    motivo:
        'Solicitação de envio eletrônico de documento para dar andamento ao processo.',
};

function mostrarUso(): void {
    console.log('\nUso:');
    console.log(
        '  npx tsx src/tests/run-tramitacao-upsert.ts <CPF> <NOME COMPLETO> <PROTOCOLO> <SERVIÇO>\n'
    );
    console.log('Exemplo:');
    console.log(
        '  npx tsx src/tests/run-tramitacao-upsert.ts 123.456.789-00 "LAZARO OLIVEIRA MARANHAO" 1844964359 "Aposentadoria por Idade Rural"\n'
    );
}

async function executar(): Promise<void> {
    const [, , cpfArg, nomeArg, protocoloArg, ...servicoArgs] = process.argv;

    const dadosCliente = {
        cpf: cpfArg || DADOS_PADRAO.cpf,
        nome: nomeArg || DADOS_PADRAO.nome,
        protocolo: protocoloArg || DADOS_PADRAO.protocolo,
        servico:
            servicoArgs.length > 0
                ? servicoArgs.join(' ')
                : DADOS_PADRAO.servico,
    };

    if (!cpfArg || !nomeArg || !protocoloArg) {
        console.log('ℹ️  Parâmetros não informados. Usando dados padrão da Gisele.');
        mostrarUso();
    }

    console.log('\n========================================');
    console.log('TESTE DE UPSERT - TRAMITAÇÃO');
    console.log('========================================\n');

    console.log('Dados fornecidos:');
    console.log(JSON.stringify(dadosCliente, null, 2));

    try {
        console.log('\n▶️  Primeira execução (deve criar se não existir)...');
        const clienteCriado = await TramitacaoService.buscarOuCriarCliente(dadosCliente);

        if (!clienteCriado) {
            console.error('❌ Não foi possível buscar ou criar o cliente. Verifique os logs acima.');
            process.exit(1);
        }

        console.log('✅ Cliente pronto:');
        console.log(JSON.stringify(clienteCriado, null, 2));

        console.log('\n📝 Disparando fluxo de exigência (nota + atividade + etiqueta)...');
        const resultadoFluxo = await TramitacaoService.notificarExigencia({
            cpf: dadosCliente.cpf,
            nome: dadosCliente.nome,
            protocolo: dadosCliente.protocolo,
            beneficio: dadosCliente.servico,
            documentos: DADOS_PADRAO.documentos,
            prazo: DADOS_PADRAO.prazo,
            motivo: DADOS_PADRAO.motivo,
        });

        if (resultadoFluxo) {
            console.log('✅ Fluxo de exigência executado com sucesso.');
        } else {
            console.warn('⚠️ Fluxo de exigência não pôde ser executado. Verifique logs.');
        }

        console.log('\n▶️  Segunda execução (deve localizar o mesmo cliente)...');
        const clienteEncontrado = await TramitacaoService.buscarOuCriarCliente(dadosCliente);

        if (!clienteEncontrado) {
            console.error('❌ Segunda execução falhou ao localizar o cliente.');
            process.exit(1);
        }

        if (clienteEncontrado.id === clienteCriado.id) {
            console.log('✅ Cliente localizado com o mesmo ID: ' + clienteEncontrado.id);
        } else {
            console.warn('⚠️ Cliente localizado, mas com ID diferente.');
            console.log('Primeira execução:', clienteCriado.id);
            console.log('Segunda execução:', clienteEncontrado.id);
        }

        console.log('\n🎉 Teste concluído! Veja o Tramitação para confirmar a criação.');
    } catch (error) {
        logger.error('[Teste Upsert] Erro inesperado:', error);
        console.error('❌ Erro ao executar teste de upsert. Veja os logs acima.');
        process.exit(1);
    }
}

executar();
