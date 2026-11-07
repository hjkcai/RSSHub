import type { Context } from 'hono';

import InvalidParameterError from '@/errors/types/invalid-parameter';
import type { Data, Route } from '@/types';
import { getRouteLimit } from '@/utils/route-limit';

import { fetchFeedArticleItems } from '../utils';

const ROOT_URL = 'https://www.fbi.gov';
const OFFICE_PATTERN = /^[a-z]+$/;

export const route: Route = {
    path: '/fbi/field-office/:office',
    categories: ['government'],
    example: '/usgov/fbi/field-office/newyork',
    parameters: {
        office: 'Field office slug as used in its URL, for example `newyork`, `sanfrancisco` or `washingtondc`',
    },
    name: 'Field Office News',
    maintainers: ['hjkcai'],
    description: 'News and press releases from an FBI field office. Use the last path segment of the office page on fbi.gov as the slug, so `https://www.fbi.gov/contact-us/field-offices/newyork` becomes `newyork`.',
    zh: {
        name: '地方办公室新闻',
        description: 'FBI 地方办公室的新闻与新闻稿。参数取该办公室页面地址的最后一段，例如 `https://www.fbi.gov/contact-us/field-offices/newyork` 对应 `newyork`。',
    },
    handler,
};

async function handler(ctx: Context): Promise<Data> {
    const office = ctx.req.param('office');
    if (!office || !OFFICE_PATTERN.test(office)) {
        throw new InvalidParameterError('office must be a field office slug such as `newyork`');
    }

    const listUrl = `${ROOT_URL}/contact-us/field-offices/${office}/news`;

    return {
        title: `FBI ${office} Field Office News`,
        link: listUrl,
        description: `News and press releases from the FBI ${office} field office.`,
        language: 'en',
        item: await fetchFeedArticleItems(`${listUrl}/rss.xml`, `fbi-field-office-${office}`, getRouteLimit(ctx, 20)),
    };
}
