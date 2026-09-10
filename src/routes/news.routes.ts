import { Router } from 'express';
import { asyncHandler } from '../middleware/async-handler.js';
import { queryOf, validateQuery } from '../middleware/validate.js';
import {
  newsIdParamSchema,
  newsListQuerySchema,
  type NewsListQueryInput,
} from '../schemas/news.schema.js';
import { getNews, listNews } from '../services/news.service.js';

/** ข่าวสารฝั่งผู้ใช้ — เปิดสาธารณะ ไม่ต้องล็อกอิน (api-contract.md ข้อ 7) */
export const newsRouter = Router();

newsRouter.get(
  '/',
  validateQuery(newsListQuerySchema),
  asyncHandler(async (req, res) => {
    const q = queryOf<typeof newsListQuerySchema>(req) as NewsListQueryInput;
    res.json(await listNews(q));
  }),
);

newsRouter.get(
  '/:newsId',
  asyncHandler(async (req, res) => {
    const newsId = newsIdParamSchema.parse(req.params.newsId);
    res.json({ data: await getNews(newsId) });
  }),
);
