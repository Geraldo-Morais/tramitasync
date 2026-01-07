/**
 * SCRIPT: Criar todos os usuários da equipe
 * 
 * Usuários:
 * - Clayton (Admin)
 * - Ellen (Administrativo + Judicial)
 * - Júlia (Administrativo - BPC/BI)
 * - Júlio (Intermediação/Secretaria)
 * - Geraldo (Exigências)
 * - Antonio (Intermediação)
 * - Ian (Judicial - BPC/BI)
 */

import database from '../database';
import logger from '../utils/logger';
import bcrypt from 'bcryptjs';

interface Usuario {
    nome: string;
    email: string;
    senha: string;
    perfil: 'admin' | 'secretaria' | 'administrativo' | 'intermediacao' | 'judicial';
    telefone?: string;
    papel_principal?: string; // Descrição do papel
}

const usuarios: Usuario[] = [
    {
        nome: 'Clayton',
        email: 'clayton@escritorio.com',
        senha: 'clayton123',
        perfil: 'admin',
        telefone: '77999990001',
        papel_principal: 'Administrador - Visão geral de tudo'
    },
    {
        nome: 'Ellen',
        email: 'ellen@escritorio.com',
        senha: 'ellen123',
        perfil: 'administrativo',
        telefone: '77999990002',
        papel_principal: 'Administrativo (Aposentadorias, Pensão, Aux Reclusão, Sal Mat) + Judicial (todos)'
    },
    {
        nome: 'Júlia',
        email: 'julia@escritorio.com',
        senha: 'julia123',
        perfil: 'administrativo',
        telefone: '77999990003',
        papel_principal: 'Administrativo (BPC + Benefício Incapacidade)'
    },
    {
        nome: 'Júlio',
        email: 'julio@escritorio.com',
        senha: 'julio123',
        perfil: 'intermediacao',
        telefone: '77999990004',
        papel_principal: 'Intermediação - Contato com clientes e parceiros'
    },
    {
        nome: 'Geraldo',
        email: 'geraldo@escritorio.com',
        senha: 'geraldo123',
        perfil: 'administrativo',
        telefone: '77999990005',
        papel_principal: 'Controle de Exigências (cumprimento no PAT)'
    },
    {
        nome: 'Antonio',
        email: 'antonio@escritorio.com',
        senha: 'antonio123',
        perfil: 'intermediacao',
        telefone: '77999990006',
        papel_principal: 'Intermediação - Apoio ao Júlio'
    },
    {
        nome: 'Ian',
        email: 'ian@escritorio.com',
        senha: 'ian123',
        perfil: 'judicial',
        telefone: '77999990007',
        papel_principal: 'Judicial (BPC + Benefício Incapacidade)'
    }
];

async function criarUsuariosEquipe() {
    try {
        logger.info('========================================');
        logger.info('CRIANDO USUÁRIOS DA EQUIPE');
        logger.info('========================================\n');

        for (const usuario of usuarios) {
            // Verificar se já existe
            const existe = await database.getPool().query(
                'SELECT id FROM usuarios WHERE email = $1',
                [usuario.email]
            );

            if (existe.rows.length > 0) {
                logger.warn(`⚠️  ${usuario.nome} (${usuario.email}) já existe, pulando...`);
                continue;
            }

            // Hash da senha
            const senhaHash = await bcrypt.hash(usuario.senha, 10);

            // Criar usuário
            const result = await database.getPool().query(
                `INSERT INTO usuarios (nome, email, senha, perfil, ativo)
         VALUES ($1, $2, $3, $4, true)
         RETURNING id, nome, email, perfil`,
                [usuario.nome, usuario.email, senhaHash, usuario.perfil]
            );

            logger.info(`✅ ${usuario.nome}`);
            logger.info(`   Email: ${usuario.email}`);
            logger.info(`   Senha: ${usuario.senha}`);
            logger.info(`   Perfil: ${usuario.perfil}`);
            logger.info(`   Papel: ${usuario.papel_principal}`);
            logger.info(`   ID: ${result.rows[0].id}\n`);
        }

        // Resumo final
        logger.info('\n========================================');
        logger.info('✅ USUÁRIOS CRIADOS COM SUCESSO!');
        logger.info('========================================\n');

        const todos = await database.getPool().query(`
      SELECT nome, email, perfil, ativo 
      FROM usuarios 
      ORDER BY 
        CASE perfil
          WHEN 'admin' THEN 1
          WHEN 'administrativo' THEN 2
          WHEN 'judicial' THEN 3
          WHEN 'intermediacao' THEN 4
          WHEN 'secretaria' THEN 5
        END,
        nome
    `);

        logger.info('👥 EQUIPE COMPLETA:\n');
        todos.rows.forEach(u => {
            logger.info(`   ${u.ativo ? '✓' : '✗'} ${u.nome} (${u.perfil}) - ${u.email}`);
        });

        logger.info('\n📝 CREDENCIAIS PARA LOGIN:\n');
        usuarios.forEach(u => {
            logger.info(`   ${u.email} / ${u.senha}`);
        });

        logger.info('\n🎯 PRÓXIMO PASSO: Criar regras de atribuição automática de responsáveis');

        process.exit(0);
    } catch (error) {
        logger.error('❌ Erro ao criar usuários:', error);
        process.exit(1);
    }
}

criarUsuariosEquipe();
