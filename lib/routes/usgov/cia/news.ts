import { load } from 'cheerio';
import type { Context } from 'hono';

import InvalidParameterError from '@/errors/types/invalid-parameter';
import type { Data, Route } from '@/types';
import { getRouteLimit } from '@/utils/route-limit';

import { fetchArticleItems, fetchText, parseOfficialDate } from '../utils';

const ROOT_URL = 'https://www.cia.gov';
const SECTIONS = {
    'press-releases': '/stories/press-releases-and-statements',
    speeches: '/stories/speeches-and-transcripts',
} as const;

type Section = keyof typeof SECTIONS;

export const route: Route = {
    path: '/cia/:section',
    categories: ['government'],
    example: '/usgov/cia/press-releases',
    parameters: {
        section: 'Listing to read: `press-releases` or `speeches`',
    },
    name: 'News',
    maintainers: ['hjkcai'],
    description: 'Press releases and prepared remarks from the Central Intelligence Agency. The listing is parsed from the official stories page and the full text fetched from each article page.',
    zh: {
        name: '新闻',
        description: '中央情报局的新闻稿和讲话稿。列表解析自官方 stories 页面，正文取自每篇文章页。',
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
        title: `CIA - ${section}`,
        link: listUrl,
        description: `News from the U.S. Central Intelligence Agency (${section}).`,
        language: 'en',
        item: await fetchArticleItems(
            list.map((entry) => ({
                sourceId: `cia-${section}`,
                ...entry,
            }))
        ),
    };
}

/**
 * CIA list entries render the link, title and publication date next to each other, with the date
 * prefixed by "Published".
 */
async function parseList(listUrl: string, limit: number) {
    const { html } = await fetchText(listUrl);
    const $ = load(html);

    return $('a.title-link')
        .toArray()
        .slice(0, limit)
        .map((element) => {
            const $element = $(element);
            const published = $element.parent().find('p').first().text();

            return {
                link: new URL($element.attr('href')!, listUrl).href,
                title: $element.text().trim(),
                pubDate: parseOfficialDate(published.replace(/^Published\s+/i, '')),
            };
        });
}
