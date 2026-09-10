/**
 * ขอบสัปดาห์ของกระดานอันดับรายสัปดาห์ — `api-contract.md` ข้อ 5
 *
 * สัปดาห์เริ่ม **วันจันทร์ 00:00 น. เวลาไทย (UTC+7)** ⚙️ แล้วแปลงเป็น UTC ก่อนยิง query
 * เพราะ `started_at` ใน DB เก็บเป็น UTC ทั้งหมด
 *
 * ไทยไม่มี DST และใช้ UTC+7 คงที่มาตั้งแต่ปี 1920 → คำนวณด้วยเลขล้วนได้ ไม่ต้องพึ่ง `Intl`
 * หรือไลบรารี timezone ตัวไหน (ถ้าวันหลังต้องรองรับโซนที่มี DST ให้เปลี่ยนมาใช้ `Intl` ทั้งไฟล์
 * อย่าไปบวกลบชั่วโมงเพิ่มทับของเดิม)
 */

/** UTC+7 — เวลาไทยเร็วกว่า UTC เท่านี้เสมอ */
export const THAI_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export interface WeekRange {
  /** วินาทีแรกของสัปดาห์ (จันทร์ 00:00 ไทย) เป็นเวลา UTC — ใช้แบบ `>= start` */
  start: Date;
  /** จันทร์ถัดไป 00:00 ไทย เป็นเวลา UTC — ใช้แบบ `< end` ไม่ใช่ `<=` */
  end: Date;
}

/**
 * สัปดาห์ที่ `now` ตกอยู่ — ขอบซ้ายรวม ขอบขวาไม่รวม
 *
 * วิธีคิด: เลื่อนเวลาไป +7 ชม. ให้ "นาฬิกาบนกำแพงที่ไทย" กลายเป็นเวลา UTC ก่อน
 * แล้วค่อยตัดเศษเป็นวันจันทร์ 00:00 ด้วยเลขจำนวนเต็ม สุดท้ายเลื่อนกลับ −7 ชม.
 */
export function weekRangeOf(now: Date = new Date()): WeekRange {
  const thai = now.getTime() + THAI_UTC_OFFSET_MS;

  // `getUTCDay()` ของเวลาที่เลื่อนแล้ว = วันในสัปดาห์ตามปฏิทินไทย (0 = อาทิตย์)
  // อาทิตย์ต้องนับเป็นวันที่ 6 ของสัปดาห์ ไม่ใช่วันที่ 0 → `(day + 6) % 7`
  const dayOfWeek = new Date(thai).getUTCDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;

  const midnightThai = Math.floor(thai / DAY_MS) * DAY_MS;
  const startThai = midnightThai - daysSinceMonday * DAY_MS;

  return {
    start: new Date(startThai - THAI_UTC_OFFSET_MS),
    end: new Date(startThai + WEEK_MS - THAI_UTC_OFFSET_MS),
  };
}

/**
 * คีย์ของสัปดาห์แบบอ่านออก เช่น `2026-09-07` (วันจันทร์ตามปฏิทินไทย)
 * ใช้เป็นส่วนหนึ่งของคีย์ cache — พอข้ามสัปดาห์คีย์เปลี่ยนเอง ไม่ต้องไล่ล้าง cache
 */
export function weekKeyOf(range: WeekRange): string {
  return new Date(range.start.getTime() + THAI_UTC_OFFSET_MS).toISOString().slice(0, 10);
}
