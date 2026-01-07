import 'dotenv/config';
import WhatsAppService from '../services/WhatsAppService';
import Database from '../database';

const POLLING_INTERVAL_MS = 3000;

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function getUserIdFromEmail(email: string): Promise<string> {
    const users = await Database.query<{ id: string | number }>(
        'SELECT id FROM usuarios_extensao WHERE email = $1 LIMIT 1',
        [email]
    );

    if (!users.length || !users[0]?.id) {
        throw new Error(`Usuario ${email} nao encontrado em usuarios_extensao`);
    }

    return String(users[0].id);
}

async function resolveUserId(): Promise<string> {
    const arg = process.argv[2]?.trim();
    if (arg) {
        if (arg.includes('@')) {
            return await getUserIdFromEmail(arg.toLowerCase());
        }
        return arg;
    }

    if (process.env.TEST_WHATSAPP_USER_ID) {
        return process.env.TEST_WHATSAPP_USER_ID;
    }

    if (process.env.TEST_WHATSAPP_EMAIL) {
        return await getUserIdFromEmail(process.env.TEST_WHATSAPP_EMAIL);
    }

    throw new Error(
        'Informe userId ou email via argumento ou configure TEST_WHATSAPP_USER_ID/TEST_WHATSAPP_EMAIL.'
    );
}

async function run() {
    const userId = await resolveUserId();
    await Database.close().catch(() => undefined);
    console.log(`[test-whatsapp] Iniciando simulacao para userId=${userId}`);
    let attempt = 0;

    while (true) {
        attempt += 1;
        console.log(`[test-whatsapp] Tentativa ${attempt} - ${new Date().toISOString()}`);

        try {
            const qrData = await WhatsAppService.obterQrCode(userId);

            if (qrData?.qr) {
                console.log('[test-whatsapp] QR Code base64 recebido:');
                console.log(qrData.qr);
                console.log(`[test-whatsapp] Timestamp=${qrData.timestamp} expiresIn=${qrData.expiresIn}ms`);
                break;
            }

            console.log(`[test-whatsapp] Ainda sem QR Code. Aguardando ${POLLING_INTERVAL_MS / 1000}s...`);
        } catch (error: any) {
            const status = error?.response?.status;
            if (status) {
                console.error(`[test-whatsapp] Erro HTTP ${status} na tentativa ${attempt}.`);
            } else {
                console.error(`[test-whatsapp] Erro na tentativa ${attempt}: ${error?.message || error}`);
            }
        }

        await delay(POLLING_INTERVAL_MS);
    }

    console.log('[test-whatsapp] Teste concluido com sucesso.');
}

run().catch(error => {
    console.error('[test-whatsapp] Erro inesperado:', error);
    process.exit(1);
});
