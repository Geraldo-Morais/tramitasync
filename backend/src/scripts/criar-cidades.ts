/**
 * Script rápido: Criar tabela cidades e inserir dados
 */

import 'dotenv/config';
import Database from '../database';

async function criarTabelaCidades() {
    try {
        console.log('📋 Criando tabela cidades...\n');

        // Criar tabela
        await Database.query(`
            CREATE TABLE IF NOT EXISTS cidades (
                id SERIAL PRIMARY KEY,
                nome VARCHAR(200) NOT NULL,
                uf VARCHAR(2) NOT NULL,
                ativo BOOLEAN DEFAULT true,
                criado_em TIMESTAMP DEFAULT NOW(),
                atualizado_em TIMESTAMP DEFAULT NOW()
            );
        `);

        console.log('✅ Tabela cidades criada');

        // Criar índices
        await Database.query(`CREATE INDEX IF NOT EXISTS idx_cidades_nome ON cidades(nome);`);
        await Database.query(`CREATE INDEX IF NOT EXISTS idx_cidades_uf ON cidades(uf);`);
        await Database.query(`CREATE INDEX IF NOT EXISTS idx_cidades_ativo ON cidades(ativo);`);

        console.log('✅ Índices criados');

        // Inserir cidades
        const cidades = [
            ['Cândido Sales', 'BA'],
            ['Vitória da Conquista', 'BA'],
            ['Itapetinga', 'BA'],
            ['Barra do Choça', 'BA'],
            ['Poções', 'BA'],
            ['Planalto', 'BA'],
            ['Ribeirão do Largo', 'BA'],
            ['Maetinga', 'BA'],
            ['Tremedal', 'BA'],
            ['Belo Campo', 'BA']
        ];

        for (const [nome, uf] of cidades) {
            await Database.query(`
                INSERT INTO cidades (nome, uf)
                VALUES ($1, $2)
                ON CONFLICT DO NOTHING
            `, [nome, uf]);
        }

        console.log(`✅ ${cidades.length} cidades inseridas`);

        // Conferir
        const result = await Database.query(`SELECT COUNT(*) as total FROM cidades`);
        console.log(`\n📊 Total de cidades no banco: ${result[0].total}\n`);

        const listagem = await Database.query(`SELECT id, nome, uf FROM cidades ORDER BY nome`);
        console.log('Cidades cadastradas:');
        listagem.forEach(c => console.log(`   ${c.id}. ${c.nome}/${c.uf}`));

        console.log('\n✅ Script concluído!');

    } catch (error: any) {
        console.error('❌ Erro:', error.message);
        process.exit(1);
    } finally {
        await Database.close();
        process.exit(0);
    }
}

criarTabelaCidades();
