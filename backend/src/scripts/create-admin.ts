import bcrypt from 'bcryptjs';
import db from '../database';
import logger from '../utils/logger';

async function createAdmin() {
    try {
        const hash = await bcrypt.hash('admin123', 10);

        await db.query(
            `INSERT INTO usuarios (nome, email, senha, perfil, ativo) 
             VALUES ($1, $2, $3, $4, $5) 
             ON CONFLICT (email) DO NOTHING`,
            ['Admin', 'admin@escritorio.com', hash, 'admin', true]
        );

        logger.info('✅ Usuário admin criado: admin@escritorio.com / admin123');
        process.exit(0);
    } catch (error) {
        logger.error('❌ Erro ao criar admin:', error);
        process.exit(1);
    }
}

createAdmin();
