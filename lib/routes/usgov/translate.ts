import type { CheerioAPI } from 'cheerio';
import { load } from 'cheerio';
import type { Element } from 'domhandler';
import pMap from 'p-map';

import { config } from '@/config';
import cache from '@/utils/cache';
import logger from '@/utils/logger';
import md5 from '@/utils/md5';
import ofetch from '@/utils/ofetch';

/**
 * Translations are cached under the source text, so an unchanged article is paid for once. A week
 * covers the daily crawl with room to spare and still lets a prompt change reach old articles.
 */
const CACHE_SECONDS = 7 * 24 * 60 * 60;

/** Bump when the prompt changes: the cache key carries it, so old wording is not reused. */
const PROMPT_VERSION = '2026-11-08';

/** Blocks that accept a `<p>` sibling. List items and table cells are skipped on purpose: a
 * paragraph next to them would break the list or table, and official releases keep their prose in
 * paragraphs anyway. */
const BLOCK_SELECTOR = 'p, h2, h3, h4, h5, h6, blockquote, figcaption';

/** Shorter blocks are labels, dates or bare numbers, and translating them only adds noise. */
const MIN_TRANSLATABLE_LENGTH = 2;

/** A long release is split so one bad chunk cannot cost the whole article. */
const BLOCKS_PER_REQUEST = 20;
const CHARS_PER_REQUEST = 3500;
const REQUEST_CONCURRENCY = 2;
const REQUEST_TIMEOUT = 120000;

const SYSTEM_PROMPT = `You translate U.S. government press releases into Simplified Chinese.

The user sends a JSON array of English blocks taken from one article: paragraphs, headings, quotes and captions.

Reply with a single JSON object of the form {"translations": [...]}. The array must hold exactly one Simplified Chinese translation per input item, in the same order and with the same count.

Keep personal names, organization names, place names, numbers, dates, dollar amounts, statute and case numbers unchanged. Translate the meaning faithfully: do not summarize, expand, merge or split blocks, and do not add notes. If an item is already Chinese or holds no translatable words, repeat it unchanged.

Output nothing outside the JSON object.`;

type ChatCompletionResponse = {
    choices?: Array<{
        message?: {
            content?: string;
        };
    }>;
};

type Block = {
    element: Element;
    text: string;
};

/**
 * Translation is an add-on step. It runs whenever a model is configured, so removing the key from
 * the env file turns it off without touching the routes.
 */
export const isTranslationEnabled = () => Boolean(config.openai.apiKey && config.openai.model);

/**
 * Returns the article HTML with a Chinese paragraph after every English one. Any failure returns
 * the input untouched: a missing translation must never cost the reader the original text.
 */
export const translateBody = async (html: string): Promise<string> => {
    if (!html) {
        return html;
    }

    const $ = load(html, null, false);
    const blocks = collectBlocks($);
    if (!blocks.length) {
        return html;
    }

    let translations: string[];
    try {
        translations = await cache.tryGet(getCacheKey(blocks), () => requestTranslations(blocks.map((block) => block.text)), CACHE_SECONDS);
    } catch (error) {
        logger.error(`Translation failed, delivering the original text: ${error}`);
        return html;
    }

    if (translations.length !== blocks.length) {
        logger.error(`Translation returned ${translations.length} blocks for ${blocks.length}, delivering the original text`);
        return html;
    }

    for (const [index, block] of blocks.entries()) {
        // The number is the position in this body version, so a reader can pair the two sides and a
        // later front end can hide one of them.
        const paragraph = String(index + 1);
        const $block = $(block.element);

        $block.attr('data-news-role', 'source').attr('data-news-paragraph', paragraph);
        // A heading stays a heading in both languages, so the outline reads the same either way.
        $block.after($(`<${block.element.tagName}></${block.element.tagName}>`).attr('data-news-role', 'translation').attr('data-news-paragraph', paragraph).text(translations[index]));
    }

    return $.html();
};

const collectBlocks = ($: CheerioAPI): Block[] => {
    const blocks: Block[] = [];

    $(BLOCK_SELECTOR).each((_, element) => {
        // A wrapper that holds other blocks is translated through its children; translating it as
        // well would repeat the same sentence, out of order.
        if ($(element).find(BLOCK_SELECTOR).length > 0) {
            return;
        }

        const text = $(element).text().replaceAll(/\s+/g, ' ').trim();
        if (text.length < MIN_TRANSLATABLE_LENGTH || !/[a-z]/i.test(text)) {
            return;
        }

        blocks.push({ element, text });
    });

    return blocks;
};

const getCacheKey = (blocks: Block[]) => `usgov:translation:${PROMPT_VERSION}:${config.openai.model}:${md5(blocks.map((block) => block.text).join('\n'))}`;

const requestTranslations = async (texts: string[]): Promise<string[]> => {
    const chunks = chunkTexts(texts);

    return (await pMap(chunks, translateChunk, { concurrency: REQUEST_CONCURRENCY })).flat();
};

const chunkTexts = (texts: string[]): string[][] => {
    const chunks: string[][] = [];
    let chunk: string[] = [];
    let chunkLength = 0;

    for (const text of texts) {
        if (chunk.length && (chunk.length >= BLOCKS_PER_REQUEST || chunkLength + text.length > CHARS_PER_REQUEST)) {
            chunks.push(chunk);
            chunk = [];
            chunkLength = 0;
        }

        chunk.push(text);
        chunkLength += text.length;
    }

    if (chunk.length) {
        chunks.push(chunk);
    }

    return chunks;
};

const translateChunk = async (texts: string[]): Promise<string[]> => {
    const response = await ofetch<ChatCompletionResponse>(`${config.openai.endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${config.openai.apiKey}`,
        },
        body: {
            model: config.openai.model,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: JSON.stringify(texts) },
            ],
            response_format: { type: 'json_object' },
        },
        timeout: REQUEST_TIMEOUT,
    });

    const translations = parseTranslations(response.choices?.[0]?.message?.content);
    if (translations?.length !== texts.length) {
        throw new Error(`Model returned ${translations?.length ?? 0} translations for ${texts.length} blocks`);
    }

    return translations;
};

const parseTranslations = (content?: string): string[] | undefined => {
    if (!content) {
        return;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch {
        return;
    }

    if (typeof parsed !== 'object' || parsed === null || !('translations' in parsed)) {
        return;
    }

    const { translations } = parsed as { translations?: unknown };

    return Array.isArray(translations) ? translations.map(String) : undefined;
};
