import type { Context } from 'hono';

import type { Data, Route } from '@/types';
import { getRouteLimit } from '@/utils/route-limit';

import { fetchFeedArticleItems } from '../utils';

const SOURCE_ID = 'fbi-press-releases';
const LIST_URL = 'https://www.fbi.gov/news/press-releases';
const FEED_URL = `${LIST_URL}/rss.xml`;

export const route: Route = {
    path: '/fbi/press-releases',
    categories: ['government'],
    example: '/usgov/fbi/press-releases',
    name: 'Press Releases',
    maintainers: ['hjkcai'],
    description: 'National press releases from the FBI. The list comes from the official RSS feed and the full text from each official article page, which is often hosted by the Department of Justice.',
    zh: {
        name: '新闻稿',
        description: 'FBI 全国新闻稿。列表取自官方 RSS，正文取自官方文章页；多数稿件实际由司法部发布。',
    },
    handler,
};

async function handler(ctx: Context): Promise<Data> {
    return {
        title: 'FBI Press Releases',
        link: LIST_URL,
        description: 'National press releases from the U.S. Federal Bureau of Investigation.',
        language: 'en',
        item: await fetchFeedArticleItems(FEED_URL, SOURCE_ID, getRouteLimit(ctx, 20)),
    };
}
