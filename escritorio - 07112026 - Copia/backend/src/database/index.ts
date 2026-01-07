import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import config from '../config';
import logger from '../utils/logger';

class Database {
    private pool: Pool;
    private static instance: Database;

    private constructor() {
        // Se DATABASE_URL estiver definido, usar ela (prioridade)
        // Caso contrário, usar configurações individuais
        const poolConfig = process.env.DATABASE_URL
            ? {
                connectionString: process.env.DATABASE_URL,
                max: 20,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 15000, // Aumentado para Supabase
                ssl: {
                    rejectUnauthorized: false, // Necessário para Supabase
                },
            }
            : {
                host: config.database.host,
                port: config.database.port,
                user: config.database.user,
                password: config.database.password,
                database: config.database.name,
                max: 20,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 15000, // Aumentado para Supabase
                ssl: {
                    rejectUnauthorized: false, // Necessário para Supabase
                },
            };

        this.pool = new Pool(poolConfig);

        this.pool.on('error', (err) => {
            logger.error('Erro inesperado no pool de conexões PostgreSQL', err);
        });

        logger.info('Pool de conexões PostgreSQL inicializado');
    }

    public static getInstance(): Database {
        if (!Database.instance) {
            Database.instance = new Database();
        }
        return Database.instance;
    }

    public getPool(): Pool {
        return this.pool;
    }

    public async query<T = any>(text: string, params?: any[]): Promise<T[]> {
        const start = Date.now();
        try {
            const result = await this.pool.query(text, params);
            const duration = Date.now() - start;
            logger.debug(`Query executada em ${duration}ms`, { text, params });
            return result.rows;
        } catch (error) {
            logger.error('Erro ao executar query', { text, params, error });
            throw error;
        }
    }

    public async queryFull<T extends QueryResultRow = QueryResultRow>(
        text: string,
        params?: any[]
    ): Promise<QueryResult<T>> {
        const start = Date.now();
        try {
            const result = await this.pool.query<T>(text, params);
            const duration = Date.now() - start;
            logger.debug(`Query executada em ${duration}ms`, { text, params });
            return result;
        } catch (error) {
            logger.error('Erro ao executar query', { text, params, error });
            throw error;
        }
    }

    public async getClient(): Promise<PoolClient> {
        return this.pool.connect();
    }

    public async testConnection(): Promise<boolean> {
        try {
            const result = await this.query('SELECT NOW()');
            logger.info('Conexão com PostgreSQL estabelecida com sucesso', result[0]);
            return true;
        } catch (error) {
            logger.error('Falha ao conectar com PostgreSQL', error);
            return false;
        }
    }

    public async close(): Promise<void> {
        await this.pool.end();
        logger.info('Pool de conexões PostgreSQL fechado');
    }
}

export default Database.getInstance();
