import { Client } from 'pg';
import config from '../config';
import logger from '../utils/logger';

async function createDatabase(): Promise<void> {
    // Conectar ao postgres (banco padrão) para criar o novo banco
    const client = new Client({
        host: config.database.host,
        port: config.database.port,
        user: config.database.user,
        password: config.database.password,
        database: 'postgres', // Conectar ao banco padrão
    });

    try {
        await client.connect();
        logger.info('Conectado ao PostgreSQL');

        // Verificar se o banco já existe
        const checkQuery = `
      SELECT 1 FROM pg_database WHERE datname = $1
    `;
        const result = await client.query(checkQuery, [config.database.name]);

        if (result.rows.length > 0) {
            logger.info(`✅ Banco de dados '${config.database.name}' já existe`);
        } else {
            // Criar o banco
            await client.query(`CREATE DATABASE ${config.database.name}`);
            logger.info(`✅ Banco de dados '${config.database.name}' criado com sucesso`);
        }

        await client.end();
        logger.info('Conexão fechada');

        logger.info('\n📝 Próximos passos:');
        logger.info('1. Execute: npm run db:migrate');
        logger.info('2. (Opcional) Execute: npm run db:seed\n');

    } catch (error) {
        logger.error('❌ Erro ao criar banco de dados', error);
        await client.end();
        process.exit(1);
    }
}

// Executar se chamado diretamente
if (require.main === module) {
    createDatabase();
}

export default createDatabase;
