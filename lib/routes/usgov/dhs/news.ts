import { load } from 'cheerio';
import type { Context } from 'hono';

import InvalidParameterError from '@/errors/types/invalid-parameter';
import type { Data, Route } from '@/types';
import { getRouteLimit } from '@/utils/route-limit';

import { fetchArticleItems, fetchText, parseOfficialDate } from '../utils';

const ROOT_URL = 'https://www.dhs.gov';
// `featured` is a curated cross-section that repeats press releases, so it is left out.
const SECTIONS = {
    'press-releases': '/news-releases/press-releases',
    blog: '/news-releases/blog',
} as const;

type Section = keyof typeof SECTIONS;

type ListEntry = {
    link: string;
    title: string;
    pubDate?: Date;
};

export const route: Route = {
    path: '/dhs/:section',
    categories: ['government'],
    example: '/usgov/dhs/press-releases',
    parameters: {
        section: 'Listing to read: `press-releases` or `blog`',
    },
    name: 'News',
    maintainers: ['hjkcai'],
    description: 'News releases and blog posts from the Department of Homeland Security. DHS has no official feed, so the listing page is parsed and the full text fetched from each article page.',
    zh: {
        name: '新闻',
        description: '国土安全部的新闻稿和博客文章。DHS 没有官方 RSS，因此解析列表页并从每篇文章页取回正文。',
    },
    handler,
};

async function handler(ctx: Context): Promise<Data> {
    const section = ctx.req.param('section') as Section;
    if (!Object.hasOwn(SECTIONS, section)) {
        throw new InvalidParameterError(`section must be one of ${Object.keys(SECTIONS).join(', ')}`);
    }

    const listUrl = `${ROOT_URL}${SECTIONS[section]}`;
    const limit = getRouteLimit(ctx, 20);
    const list = await parseList(listUrl, limit);

    return {
        title: `Department of Homeland Security - ${section}`,
        link: listUrl,
        description: `News from the U.S. Department of Homeland Security (${section}).`,
        language: 'en',
        item: await fetchArticleItems(
            list.map((entry) => ({
                sourceId: `dhs-${section}`,
                ...entry,
            }))
        ),
    };
}

/**
 * The press release listing uses a USWDS collection, while the blog listing uses a compact
 * "news updates" row layout. Both expose the article link and a machine-readable date.
 */
async function parseList(listUrl: string, limit: number): Promise<ListEntry[]> {
    const { html } = await fetchText(`${listUrl}?items_per_page=${Math.max(25, limit)}`);
    const $ = load(html);

    const collection = $('li.usa-collection__item')
        .toArray()
        .map((element) => {
            const $element = $(element);
            const anchor = $element.find('.usa-collection__heading a').first();

            return {
                link: new URL(anchor.attr('href')!, listUrl).href,
                title: anchor.text().trim(),
                pubDate: parseOfficialDate($element.find('time[datetime]').first().attr('datetime')),
            };
        });

    const rows = $('.news-updates.views-row')
        .toArray()
        .map((element) => {
            const $element = $(element);
            const anchor = $element.find('.news-updates-title a').first();

            return {
                link: new URL(anchor.attr('href')!, listUrl).href,
                title: anchor.text().trim(),
                pubDate: parseOfficialDate($element.find('time[datetime]').first().attr('datetime')),
            };
        });

    return [...collection, ...rows].slice(0, limit);
}
