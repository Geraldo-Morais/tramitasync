import winston from 'winston';
import config from '../config';
import fs from 'fs';
import path from 'path';

const levels = {
    error: 0,
    warn: 1,
    info: 2,
    http: 3,
    debug: 4,
};

const level = () => {
    const env = config.env || 'development';
    const isDevelopment = env === 'development';
    return isDevelopment ? 'debug' : 'warn';
};

const colors = {
    error: 'red',
    warn: 'yellow',
    info: 'green',
    http: 'magenta',
    debug: 'white',
};

winston.addColors(colors);

const format = winston.format.combine(
    winston.format.timestamp({ format: 'DD/MM/YYYY HH:mm' }),
    winston.format.colorize({ all: true }),
    winston.format.printf(
        (info) => `${info.timestamp} ${info.level}: ${info.message}`,
    ),
);

const transports: winston.transport[] = [
    new winston.transports.Console(),
];

// Função auxiliar para verificar se podemos escrever no arquivo
function podeEscreverArquivo(filePath: string): boolean {
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        // Tentar abrir o arquivo para escrita
        const fd = fs.openSync(filePath, 'a');
        fs.closeSync(fd);
        return true;
    } catch (error: any) {
        // Se houver erro de permissão ou outro erro, retornar false
        return false;
    }
}

// Tentar adicionar arquivos de log apenas se possível
const errorLogPath = path.join(process.cwd(), 'logs', 'error.log');
const allLogPath = path.join(process.cwd(), 'logs', 'all.log');

if (podeEscreverArquivo(errorLogPath)) {
    try {
        const errorFileTransport = new winston.transports.File({
            filename: errorLogPath,
            level: 'error',
            handleExceptions: true,
            handleRejections: true,
        });

        errorFileTransport.on('error', () => {
            // Ignorar erros silenciosamente
        });

        transports.push(errorFileTransport);
    } catch {
        // Ignorar se não conseguir criar
    }
}

if (podeEscreverArquivo(allLogPath)) {
    try {
        const allFileTransport = new winston.transports.File({
            filename: allLogPath,
            handleExceptions: true,
            handleRejections: true,
        });

        allFileTransport.on('error', () => {
            // Ignorar erros silenciosamente
        });

        transports.push(allFileTransport);
    } catch {
        // Ignorar se não conseguir criar
    }
}

const logger = winston.createLogger({
    level: config.log.level || level(),
    levels,
    format,
    transports,
    exceptionHandlers: [
        new winston.transports.Console(),
    ],
    rejectionHandlers: [
        new winston.transports.Console(),
    ],
});

export default logger;
