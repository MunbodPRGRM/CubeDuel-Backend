import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env.js';

/**
 * ทางส่งอีเมลทางเดียวของทั้ง server (ADR-056)
 * ⚠️ ตอนนี้ไม่มีใครเรียก — ผู้ใช้เดียวคือหน้าลืมรหัสผ่านซึ่งถูกตัดไปแล้ว (ADR-068) · เก็บไว้เผื่อกลับมาส่งอีเมล
 *
 * รู้จักแค่ SMTP ทั่วไป ไม่ผูกกับผู้ให้บริการเจ้าไหน — ตอนนี้ใช้ Gmail + App Password เพราะไม่มีโดเมน
 * วันหลังย้ายไปเจ้าที่ส่งในนามโดเมนตัวเองได้ด้วยการแก้ `.env` อย่างเดียว
 * · `EMAIL_TRANSPORT=console` (ค่าเริ่มต้นตอน dev) พิมพ์อีเมลลง log แทนการส่ง
 */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

let transporter: Transporter | null = null;

function smtpTransporter(): Transporter {
  const smtp = env.mail.smtp;
  if (!smtp) throw new Error('ยังไม่ได้ตั้งค่า SMTP (ดู EMAIL_TRANSPORT ใน .env.example)');
  transporter ??= nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    // 465 = เข้ารหัสตั้งแต่ต่อ · 587 = ต่อธรรมดาแล้วค่อยอัปเกรดด้วย STARTTLS (nodemailer ทำให้เอง)
    secure: smtp.port === 465,
    auth: { user: smtp.user, pass: smtp.pass },
  });
  return transporter;
}

export async function sendMail(message: MailMessage): Promise<void> {
  if (env.mail.transport === 'console') {
    console.log(
      `\n[mail] EMAIL_TRANSPORT=console — ไม่ได้ส่งจริง\n  ถึง: ${message.to}\n  เรื่อง: ${message.subject}\n\n${message.text}\n`,
    );
    return;
  }
  await smtpTransporter().sendMail({ from: env.mail.from, ...message });
}
