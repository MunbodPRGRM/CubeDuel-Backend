import type { News, Prisma, User } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { errors } from '../lib/errors.js';
import { deleteNewsImage } from '../lib/uploads.js';
import type {
  CreateNewsInput,
  NewsListQueryInput,
  UpdateNewsInput,
} from '../schemas/news.schema.js';
import { writeAuditLog } from './audit.service.js';

/**
 * ข่าวสารและกิจกรรม (docs/api-contract.md ข้อ 7)
 *
 * ฝั่งผู้ใช้อ่านได้โดยไม่ต้องล็อกอิน · ฝั่งแอดมินเขียนได้อย่างเดียวและต้องมี `AdminAuditLog` ทุกครั้ง
 * ไฟล์รูปอยู่บนดิสก์ ไม่ได้อยู่ใน DB → **การลบไฟล์ต้องทำหลังทรานแซกชันสำเร็จเท่านั้น**
 * ไม่งั้นทรานแซกชัน rollback แล้วไฟล์หายไปแล้ว เอาคืนไม่ได้ (ADR-049 ข้อ 2)
 */

/** ความยาวสูงสุดของคำโปรยในหน้ารายการ (ADR-049 ข้อ 4) */
const EXCERPT_LENGTH = 160;

type NewsWithAuthor = News & { author: Pick<User, 'userId' | 'username' | 'nickname'> };

const authorSelect = { select: { userId: true, username: true, nickname: true } } as const;

export interface NewsAuthorDto {
  userId: number;
  username: string;
  nickname: string | null;
}

export interface NewsListItemDto {
  newsId: number;
  title: string;
  excerpt: string;
  image: string | null;
  author: NewsAuthorDto;
  createdAt: string;
  updatedAt: string;
}

export interface NewsDetailDto extends Omit<NewsListItemDto, 'excerpt'> {
  content: string;
}

/** คำโปรย = บรรทัดแรก ๆ ของเนื้อข่าวที่ยุบขึ้นบรรทัดใหม่ให้เป็นช่องว่าง */
function excerptOf(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  return flat.length <= EXCERPT_LENGTH ? flat : `${flat.slice(0, EXCERPT_LENGTH).trimEnd()}…`;
}

function toListItem(news: NewsWithAuthor): NewsListItemDto {
  return {
    newsId: news.newsId,
    title: news.title,
    excerpt: excerptOf(news.content),
    image: news.image,
    author: news.author,
    createdAt: news.createdAt.toISOString(),
    updatedAt: news.updatedAt.toISOString(),
  };
}

function toDetail(news: NewsWithAuthor): NewsDetailDto {
  const { excerpt: _excerpt, ...rest } = toListItem(news);
  return { ...rest, content: news.content };
}

// ---------------------------------------------------------------- ฝั่งผู้ใช้ (🌐)

export async function listNews(q: NewsListQueryInput) {
  const [total, rows] = await prisma.$transaction([
    prisma.news.count(),
    prisma.news.findMany({
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      include: { author: authorSelect },
    }),
  ]);

  return {
    data: rows.map(toListItem),
    meta: {
      page: q.page,
      limit: q.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / q.limit)),
    },
  };
}

export async function getNews(newsId: number): Promise<NewsDetailDto> {
  const news = await prisma.news.findUnique({
    where: { newsId },
    include: { author: authorSelect },
  });
  if (!news) throw errors.notFound('ไม่พบข่าวที่ต้องการ');
  return toDetail(news);
}

// ---------------------------------------------------------------- ฝั่งแอดมิน (🛡️)

export async function createNews(
  adminId: number,
  input: CreateNewsInput,
  imagePath: string | null,
): Promise<NewsDetailDto> {
  const created = await prisma.$transaction(async (tx) => {
    const news = await tx.news.create({
      data: { title: input.title, content: input.content, image: imagePath, authorId: adminId },
      include: { author: authorSelect },
    });
    await writeAuditLog(tx, {
      adminId,
      action: 'create_news',
      detail: { newsId: news.newsId, title: news.title, hasImage: imagePath !== null },
    });
    return news;
  });

  return toDetail(created);
}

export async function updateNews(
  adminId: number,
  newsId: number,
  input: UpdateNewsInput,
  imagePath: string | null,
): Promise<NewsDetailDto> {
  const current = await prisma.news.findUnique({ where: { newsId } });
  if (!current) throw errors.notFound('ไม่พบข่าวที่ต้องการ');

  const changesText = input.title !== undefined || input.content !== undefined;
  if (!changesText && !imagePath && !input.removeImage) {
    throw errors.validation('ไม่มีอะไรให้แก้');
  }

  if (imagePath && input.removeImage) {
    throw errors.validation('ส่งรูปใหม่พร้อมกับสั่งลบรูปไม่ได้', {
      image: 'เลือกอย่างใดอย่างหนึ่ง',
    });
  }

  const data: Prisma.NewsUpdateInput = {};
  if (input.title !== undefined) data.title = input.title;
  if (input.content !== undefined) data.content = input.content;
  if (imagePath) data.image = imagePath;
  else if (input.removeImage) data.image = null;

  const updated = await prisma.$transaction(async (tx) => {
    const news = await tx.news.update({
      where: { newsId },
      data,
      include: { author: authorSelect },
    });
    await writeAuditLog(tx, {
      adminId,
      action: 'update_news',
      detail: {
        newsId,
        // เก็บค่าเก่าไว้ด้วย ไม่งั้น log บอกได้แค่ว่า "มีคนแก้" แต่ไม่รู้ว่าแก้จากอะไร (ADR-017)
        before: { title: current.title, image: current.image },
        after: { title: news.title, image: news.image },
      },
    });
    return news;
  });

  // รูปเก่าเป็นขยะแล้วเมื่อทรานแซกชันผ่าน — ลบทีหลังเสมอ ห้ามลบก่อน
  if (current.image && current.image !== updated.image) await deleteNewsImage(current.image);

  return toDetail(updated);
}

export async function deleteNews(adminId: number, newsId: number): Promise<{ newsId: number }> {
  const current = await prisma.news.findUnique({ where: { newsId } });
  if (!current) throw errors.notFound('ไม่พบข่าวที่ต้องการ');

  await prisma.$transaction(async (tx) => {
    await tx.news.delete({ where: { newsId } });
    await writeAuditLog(tx, {
      adminId,
      action: 'delete_news',
      detail: { newsId, title: current.title, image: current.image },
    });
  });

  await deleteNewsImage(current.image);
  return { newsId };
}
