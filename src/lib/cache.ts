/**
 * cache ในหน่วยความจำแบบมีอายุ — ใช้กับ query ที่หนักและยอมให้ข้อมูลเก่าได้ไม่กี่วินาที
 * ตอนนี้มีผู้ใช้รายเดียวคือกระดานอันดับรายสัปดาห์ (`api-contract.md` ข้อ 5 — cache 60 วินาที)
 *
 * อยู่ใน memory ของ process เดียวตาม ADR-034 ข้อ 1 (รัน instance เดียว) — ถ้าวันหลังต้องขยาย
 * เป็นหลาย instance ให้ย้ายไป Redis ทั้งไฟล์ อย่าปล่อยให้แต่ละ instance มี cache ของตัวเอง
 * เพราะผู้ใช้จะเห็นอันดับกระโดดไปมาตาม instance ที่สุ่มไปโดน
 */

interface Entry<T> {
  expiresAt: number;
  /** ค่าที่คำนวณเสร็จแล้ว — ยังไม่มีจนกว่า `pending` จะจบ */
  value?: T;
  /** งานที่กำลังคำนวณอยู่ — มีไว้กัน cache stampede (ดูคำอธิบายใน `getOrCompute`) */
  pending?: Promise<T>;
}

export class TtlCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(private readonly ttlMs: number) {}

  /**
   * คืนค่าที่ cache ไว้ ถ้าหมดอายุหรือยังไม่เคยมีก็เรียก `compute` แล้วเก็บผลไว้
   *
   * **กัน cache stampede:** ถ้ามี request หลายตัวเข้ามาพร้อมกันตอน cache เย็น
   * ทุกตัวจะรอ Promise ก้อนเดียวกัน ไม่ใช่ต่างคนต่างยิง query หนักพร้อมกัน
   * — จุดนี้สำคัญกับกระดานรายสัปดาห์ เพราะมันคือ query ที่หนักที่สุดในระบบ
   */
  async getOrCompute(key: string, compute: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.entries.get(key);

    if (hit && hit.expiresAt > now) {
      if (hit.pending) return hit.pending;
      return hit.value as T;
    }

    const entry: Entry<T> = { expiresAt: now + this.ttlMs };
    // ตั้ง pending ก่อน await เสมอ — ถ้าตั้งทีหลัง request ที่แทรกเข้ามาระหว่างนั้นจะยิง query ซ้ำ
    entry.pending = compute()
      .then((value) => {
        entry.value = value;
        entry.pending = undefined;
        // นับอายุจากตอน "คำนวณเสร็จ" ไม่ใช่ตอนเริ่ม — query ที่ใช้ 3 วินาทีจะได้มีอายุครบ 60 จริง
        entry.expiresAt = Date.now() + this.ttlMs;
        return value;
      })
      .catch((err: unknown) => {
        // ไม่ cache ความล้มเหลว — ลบทิ้งให้ request ถัดไปลองใหม่ได้ทันที
        this.entries.delete(key);
        throw err;
      });

    this.entries.set(key, entry);
    this.sweep(now);
    return entry.pending;
  }

  /** ล้างของหมดอายุทิ้ง — คีย์ของกระดานมีสัปดาห์อยู่ในชื่อ ของสัปดาห์เก่าจึงค้างเปล่า ๆ ถ้าไม่กวาด */
  private sweep(now: number): void {
    for (const [key, entry] of this.entries) {
      if (!entry.pending && entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  /** ใช้ในเทสและสโมคเทสเป็นหลัก — ของจริงปล่อยให้หมดอายุเอง */
  clear(): void {
    this.entries.clear();
  }
}
