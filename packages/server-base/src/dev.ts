import { FctpServer } from './index.js';

const server = new FctpServer({ storeFile: process.env.FCTP_STORE ?? './.data/fctp.json' });
await server.open();
const listening = await server.listen(Number(process.env.PORT ?? 8080));
process.stdout.write(`FCTP server-base listening on http://127.0.0.1:${listening.port}\n`);
