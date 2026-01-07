import dotenv from 'dotenv';
import path from 'path';

// Carrega variáveis de ambiente
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

interface Config {
    env: string;
    port: number;
    database: {
        url: string;
        host: string;
        port: number;
        user: string;
        password: string;
        name: string;
    };
    tramitacao: {
        apiUrl: string;
        apiToken: string;
        email: string;
        password: string;
    };
    inss: {
        url: string;
        cronSchedule: string;
        headless: boolean;
        accessToken: string;
        useExistingChrome: boolean;
        limitProtocols?: number;
    };
    gemini: {
        apiKey: string;
        model: string;
        captchaModel: string;
    };
    jwt: {
        secret: string;
        expiresIn: string;
    };
    frontend: {
        url: string;
    };
    log: {
        level: string;
    };
    backblaze: {
        applicationKeyId: string;
        applicationKey: string;
        bucketId: string;
        bucketName: string;
    };
}

const config: Config = {
    env: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT || '3000', 10),
    database: {
        url: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/inss_manager',
        host: process.env.DATABASE_HOST || 'localhost',
        port: parseInt(process.env.DATABASE_PORT || '5432', 10),
        user: process.env.DATABASE_USER || 'postgres',
        password: process.env.DATABASE_PASSWORD || 'postgres',
        name: process.env.DATABASE_NAME || 'inss_manager',
    },
    tramitacao: {
        apiUrl: process.env.TRAMITACAO_API_URL || 'https://tramitacaointeligente.com.br/api/v1',
        apiToken: process.env.TRAMITACAO_API_TOKEN || '',
        email: process.env.TRAMITACAO_EMAIL || '',
        password: process.env.TRAMITACAO_PASSWORD || '',
    },
    inss: {
        url: process.env.INSS_URL || 'https://atendimento.inss.gov.br',
        cronSchedule: process.env.INSS_CRON_SCHEDULE || '0 8,14 * * *',
        headless: process.env.INSS_HEADLESS ? process.env.INSS_HEADLESS === 'true' : true,
        accessToken: process.env.INSS_ACCESS_TOKEN || '',
        useExistingChrome: process.env.USE_EXISTING_CHROME === 'true',
        limitProtocols: process.env.LIMIT_PROTOCOLS ? parseInt(process.env.LIMIT_PROTOCOLS, 10) : undefined,
    },
    gemini: {
        apiKey: process.env.GEMINI_API_KEY || '',
        model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
        captchaModel: process.env.GEMINI_CAPTCHA_MODEL || 'gemini-2.0-flash-lite', // Modelo específico para CAPTCHA fallback
    },
    jwt: {
        secret: process.env.JWT_SECRET || 'seu_segredo_super_secreto',
        expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    },
    frontend: {
        url: process.env.FRONTEND_URL || 'http://localhost:5173',
    },
    log: {
        level: process.env.LOG_LEVEL || 'info',
    },
    backblaze: {
        applicationKeyId: process.env.BACKBLAZE_APPLICATION_KEY_ID || '',
        applicationKey: process.env.BACKBLAZE_APPLICATION_KEY || '',
        bucketId: process.env.BACKBLAZE_BUCKET_ID || '',
        bucketName: process.env.BACKBLAZE_BUCKET_NAME || '',
    },
};

export default config;
