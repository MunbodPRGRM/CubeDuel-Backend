/**
 * ตัวจับเวลาของงานเบื้องหลัง — **อยู่ใน process เดียวกับ server** ไม่มี cron ข้างนอก
 * (เหตุผลและข้อจำกัดตอนสเกลหลาย instance อยู่ใน ADR-052 ข้อ 1)
 *
 * เรียกจาก `index.ts` เท่านั้น — `createApp()` ต้องไม่สตาร์ตอะไรเอง ไม่งั้นสคริปต์ที่ import
 * แอปเข้าไปเฉย ๆ (เทส/สโมค) จะมีงานเบื้องหลังแอบเดินอยู่ด้วย
 */
import { MOVE_LOG_PURGE_INTERVAL_MS, UNSUSPEND_JOB_INTERVAL_MS } from '../constants.js';
import { purgeExpiredMoveLogs, unsuspendExpiredAccounts } from './maintenance.js';

interface JobSpec {
  name: string;
  intervalMs: number;
  /** คืนจำนวนแถวที่แตะ — 0 แปลว่าไม่มีอะไรต้องทำ (ไม่ต้อง log) */
  run: () => Promise<number>;
}

const JOBS: JobSpec[] = [
  {
    name: 'ปลดระงับบัญชีที่ครบกำหนด',
    intervalMs: UNSUSPEND_JOB_INTERVAL_MS,
    run: () => unsuspendExpiredAccounts(),
  },
  {
    name: 'ล้าง move log ที่หมดอายุ',
    intervalMs: MOVE_LOG_PURGE_INTERVAL_MS,
    run: () => purgeExpiredMoveLogs(),
  },
];

/** งานพังต้องไม่ทำให้ server ล้ม — log แล้วปล่อยให้รอบหน้าลองใหม่ */
async function runSafely(job: JobSpec): Promise<void> {
  try {
    const count = await job.run();
    if (count > 0) console.log(`[job] ${job.name}: ${count} แถว`);
  } catch (error) {
    console.error(`[job] ${job.name} ล้มเหลว`, error);
  }
}

/**
 * เริ่มงานเบื้องหลังทั้งหมด — คืนฟังก์ชันหยุด (ใช้ตอนปิด server และในสโมคเทส)
 *
 * รันทันทีหนึ่งรอบตอนสตาร์ต เพราะของที่ค้างระหว่าง server ดับต้องถูกเก็บกวาดเลย
 * ไม่ใช่รอครบรอบแรก · `unref()` ทำให้ตัวจับเวลาไม่กันไม่ให้ process จบ
 */
export function startMaintenanceJobs(): () => void {
  const timers = JOBS.map((job) => {
    void runSafely(job);
    const timer = setInterval(() => void runSafely(job), job.intervalMs);
    timer.unref();
    return timer;
  });

  return () => timers.forEach((timer) => clearInterval(timer));
}
