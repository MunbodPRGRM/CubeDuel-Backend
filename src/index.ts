import { createServer } from 'node:http';
import { createApp } from './app.js';
import { createSocketServer } from './sockets/index.js';
import { env } from './config/env.js';

const app = createApp();
const httpServer = createServer(app);
createSocketServer(httpServer);

httpServer.listen(env.port, () => {
  console.log(`[cubeduel] backend listening on http://localhost:${env.port}`);
});
