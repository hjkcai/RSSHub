import type { Context } from 'hono';

import type { Data, Route } from '@/types';
import { getRouteLimit } from '@/utils/route-limit';

import { fetchFeedArticleItems } from '../utils';

const SOURCE_ID = 'doj-news';
const LIST_URL = 'https://www.justice.gov/news';
// The news listing pages sit behind an anti-bot challenge, the official feed does not.
const FEED_URL = `${LIST_URL}/rss?m=1`;

export const route: Route = {
    path: '/doj/news',
    categories: ['government'],
    example: '/usgov/doj/news',
    name: 'News',
    maintainers: ['hjkcai'],
    description: 'Press releases, statements and videos published by the Department of Justice. The list comes from the official RSS feed and the full text from each official article page.',
    zh: {
        name: '新闻',
        description: '司法部发布的新闻稿、声明和视频。列表取自官方 RSS，正文取自每篇官方文章页面。',
    },
    handler,
};

async function handler(ctx: Context): Promise<Data> {
    return {
        title: 'Department of Justice News',
        link: LIST_URL,
        description: 'Press releases, statements and videos from the U.S. Department of Justice.',
        language: 'en',
        item: await fetchFeedArticleItems(FEED_URL, SOURCE_ID, getRouteLimit(ctx, 20)),
    };
}
