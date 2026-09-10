import { createServer } from 'node:http';
import { createApp } from './app.js';
import { createSocketServer } from './sockets/index.js';
import { startMaintenanceJobs } from './jobs/scheduler.js';
import { env } from './config/env.js';

const app = createApp();
const httpServer = createServer(app);
createSocketServer(httpServer);

// งานเบื้องหลังอยู่ใน process เดียวกับ server (ADR-052 ข้อ 1)
if (!env.disableMaintenanceJobs) startMaintenanceJobs();

httpServer.listen(env.port, () => {
  console.log(`[cubeduel] backend listening on http://localhost:${env.port}`);
});
