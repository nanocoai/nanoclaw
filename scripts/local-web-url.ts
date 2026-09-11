import { configuredPort, readOrCreateToken } from '../src/channels/local-web.js';

const token = readOrCreateToken();
const url = `http://127.0.0.1:${configuredPort()}/#token=${encodeURIComponent(token)}`;

process.stdout.write(`${url}\n`);
