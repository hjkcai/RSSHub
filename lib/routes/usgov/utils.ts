import type { Cheerio, CheerioAPI } from 'cheerio';
import { load } from 'cheerio';
import type { Element } from 'domhandler';
import pMap from 'p-map';
import { CookieJar } from 'tough-cookie';
import { Agent, ProxyAgent } from 'undici';

import { config } from '@/config';
import type { DataItem } from '@/types';
import cache from '@/utils/cache';
import logger from '@/utils/logger';
import md5 from '@/utils/md5';
import ofetch from '@/utils/ofetch';
import { parseDate } from '@/utils/parse-date';
import parser from '@/utils/rss-parser';
import timezone from '@/utils/timezone';

import { translateBody } from './translate';

const INTERSTITIAL_MARKER = 'bm-verify';
const MAX_INTERSTITIAL_ATTEMPTS = 3;
const OFFICIAL_DATE_PATTERN = /[A-Z][a-z]+ \d{1,2}, \d{4}/;
const BODY_TILE_PATTERN = /IRichText-text-tile|rawhtml-tile/;

// fbi.gov inspects the TLS handshake, so Node's default cipher order and signature algorithms
// are rejected even when the HTTP headers claim to be Chrome. These lists are Chrome's.
const CHROME_CIPHERS = [
    'TLS_AES_128_GCM_SHA256',
    'TLS_AES_256_GCM_SHA384',
    'TLS_CHACHA20_POLY1305_SHA256',
    'ECDHE-ECDSA-AES128-GCM-SHA256',
    'ECDHE-RSA-AES128-GCM-SHA256',
    'ECDHE-ECDSA-AES256-GCM-SHA384',
    'ECDHE-RSA-AES256-GCM-SHA384',
    'ECDHE-ECDSA-CHACHA20-POLY1305',
    'ECDHE-RSA-CHACHA20-POLY1305',
    'ECDHE-RSA-AES128-SHA',
    'ECDHE-RSA-AES256-SHA',
    'AES128-GCM-SHA256',
    'AES256-GCM-SHA384',
    'AES128-SHA',
    'AES256-SHA',
].join(':');
const CHROME_SIGNATURE_ALGORITHMS = 'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha512';

const cookieJar = new CookieJar();

type ArticleSeed = {
    /** Source identifier, part of the GUID so sibling agencies cannot collide. */
    sourceId: string;
    link: string;
    title?: string;
    pubDate?: Date;
};

type ParsedArticle = {
    title?: string;
    description?: string;
    pubDate?: Date;
    author?: string;
    category?: string[];
};

type CachedArticle = Omit<ParsedArticle, 'pubDate'> & {
    /** ISO string, because cached values round-trip through JSON. */
    pubDate?: string;
    finalUrl: string;
};

type FetchOptions = {
    /** Add a Chinese paragraph after each English one. Off keeps the feed English-only. */
    translate?: boolean;
};

/**
 * Fetches a batch of articles. A single unreadable article is logged and skipped, so the rest of
 * the feed still reaches the archive.
 */
export const fetchArticleItems = async (seeds: ArticleSeed[], options: FetchOptions = {}): Promise<DataItem[]> => {
    const items = await pMap(
        seeds,
        async (seed) => {
            try {
                return await fetchArticleItem(seed, options);
            } catch (error) {
                logger.error(`Skipping ${seed.link}: ${error}`);
                return;
            }
        },
        { concurrency: 4 }
    );

    return items.filter((item): item is DataItem => item !== undefined);
};

/**
 * Fetches one official article and turns it into a feed item. Failures are the caller's problem,
 * so this throws and lets {@link fetchArticleItems} skip just that item.
 */
const fetchArticleItem = async ({ sourceId, link, title, pubDate }: ArticleSeed, options: FetchOptions): Promise<DataItem> => {
    const article = await cache.tryGet<CachedArticle>(`usgov:article:${link}`, async () => {
        const page = await fetchText(link);
        const parsed = parseArticle(page.url, page.html);

        return {
            ...parsed,
            pubDate: toIsoString(parsed.pubDate),
            finalUrl: page.url,
        };
    });
    const description = article.description ?? '';
    // The GUID hashes the official text only, so a translation appearing later updates the same
    // Feedbin entry instead of being archived as a new revision.
    const guid = `${sourceId}:${link}:${md5(toPlainText(description))}`;

    return {
        guid,
        title: article.title || title || link,
        link,
        pubDate: article.pubDate ? new Date(article.pubDate) : pubDate,
        description: options.translate ? await translateBody(description) : description,
        author: article.author,
        category: article.category,
        attachments: collectPdfAttachments(description, article.finalUrl),
    };
};

/**
 * Fetches an official feed and turns its entries into full-text articles. Falls back to `<guid>`
 * because the FBI feeds omit `<link>` entirely.
 */
export const fetchFeedArticleItems = async (feedUrl: string, sourceId: string, limit: number, options: FetchOptions = {}): Promise<DataItem[]> => {
    const { html } = await fetchText(feedUrl);
    const feed = await parser.parseString(html);

    return fetchArticleItems(
        feed.items.slice(0, limit).flatMap((entry) => {
            const link = entry.link || entry.guid;

            return link
                ? {
                      sourceId,
                      link,
                      title: entry.title,
                      pubDate: entry.pubDate ? parseDate(entry.pubDate) : undefined,
                  }
                : [];
        }),
        options
    );
};

/**
 * Fetches a page with a shared cookie jar and transparently solves the Akamai interstitial
 * challenge used by justice.gov. The challenge issues a cookie, so the jar has to survive across
 * the challenge response, the verification POST and the retried page request.
 */
export const fetchText = (url: string) => fetchTextWithChallenge(url, 0);

const fetchTextWithChallenge = async (url: string, depth: number): Promise<{ url: string; html: string }> => {
    const response = await fetchWithCookies(url);
    const html = typeof response._data === 'string' ? response._data : '';
    const pageUrl = response.url || url;

    if (!html.includes(INTERSTITIAL_MARKER)) {
        if (response.status >= 400) {
            throw new Error(`Request to ${url} failed with status ${response.status}`);
        }
        return { url: pageUrl, html };
    }

    if (depth >= MAX_INTERSTITIAL_ATTEMPTS) {
        throw new Error(`Failed to pass the anti-bot challenge on ${url}`);
    }

    await solveInterstitial(html, pageUrl);

    // The challenge belongs to the page that answered, which may be another host after a
    // redirect (FBI articles often live on justice.gov), so retry that page directly.
    return fetchTextWithChallenge(pageUrl, depth + 1);
};

const fetchWithCookies = async (url: string) => {
    // Cloudflare sometimes rejects a fresh TLS session on fbi.gov and accepts a retry, so a
    // single failed round is retried rather than reported.
    const response = await sendRequest(url);

    return response.status === 403 ? sendRequest(url) : response;
};

const sendRequest = async (url: string) => {
    const cookie = await cookieJar.getCookieString(url);
    const response = await ofetch.raw<string, 'text'>(url, {
        headers: cookie ? { cookie } : undefined,
        // Hosts without a TLS fingerprint requirement keep RSSHub's own proxy settings.
        dispatcher: getFingerprintDispatcher(url),
        // Feeds and pages are all parsed as text; the default JSON sniffing would drop them.
        responseType: 'text',
        redirect: 'follow',
        ignoreResponseError: true,
    });
    // Redirects can land on another host (FBI press releases mostly do), so cookies belong to
    // the URL that actually answered.
    await saveCookies(response.headers, response.url || url);

    return response;
};

let directDispatcher: Agent | undefined;
let proxyDispatcher: ProxyAgent | undefined;

const getFingerprintDispatcher = (url: string) => {
    if (!new URL(url).hostname.endsWith('fbi.gov')) {
        return;
    }

    const proxyUri = config.proxyUri?.replace(/\/$/, '');
    if (!proxyUri) {
        directDispatcher ??= new Agent({ connect: { preferH2: true, ciphers: CHROME_CIPHERS, sigalgs: CHROME_SIGNATURE_ALGORITHMS } });
        return directDispatcher;
    }

    proxyDispatcher ??= new ProxyAgent({
        uri: proxyUri,
        token: config.proxy.auth ? `Basic ${config.proxy.auth}` : undefined,
        requestTls: {
            preferH2: true,
            ciphers: CHROME_CIPHERS,
            sigalgs: CHROME_SIGNATURE_ALGORITHMS,
        },
    });
    return proxyDispatcher;
};

const saveCookies = async (headers: Headers, url: string) => {
    // A cookie jar rejects cookies for a foreign domain, which is never a reason to drop a page.
    await Promise.all(
        headers.getSetCookie().map(async (cookie) => {
            try {
                await cookieJar.setCookie(cookie, url);
            } catch (error) {
                logger.debug(`Ignoring cookie for ${url}: ${error}`);
            }
        })
    );
};

const solveInterstitial = async (html: string, url: string) => {
    const seed = /var i = (\d+);/.exec(html);
    const powParts = /Number\("(\d+)" \+ "(\d+)"\)/.exec(html);
    const token = /"bm-verify": "([^"]+)"/.exec(html);

    if (!seed || !powParts || !token) {
        throw new Error(`Unrecognized anti-bot challenge on ${url}`);
    }

    const response = await ofetch.raw<{ location?: string }>(`${new URL(url).origin}/_sec/verify?provider=interstitial`, {
        method: 'POST',
        headers: { cookie: await cookieJar.getCookieString(url) },
        body: {
            'bm-verify': token[1],
            pow: Number(seed[1]) + Number(powParts[1] + powParts[2]),
        },
        ignoreResponseError: true,
    });
    await saveCookies(response.headers, url);

    // The response either allows the current URL (`reload`) or redirects to another one; both are
    // handled by requesting the page again afterwards.
};

/**
 * Official releases come from four different CMS stacks, and the FBI redirects most press
 * releases to justice.gov, so the parser follows the host of the final page.
 */
export const parseArticle = (pageUrl: string, html: string): ParsedArticle => {
    const $ = load(html);

    switch (new URL(pageUrl).hostname.replace(/^www\./, '')) {
        case 'justice.gov':
            return parseJusticeArticle($, pageUrl);
        case 'fbi.gov':
            return parseFbiArticle($, pageUrl);
        case 'dhs.gov':
            return parseDhsArticle($, pageUrl);
        case 'cia.gov':
            return parseCiaArticle($, pageUrl);
        default:
            throw new Error(`No article parser for ${pageUrl}`);
    }
};

const parseJusticeArticle = ($: CheerioAPI, pageUrl: string): ParsedArticle => {
    const body = $('.field_body').first();
    if (!body.length) {
        throw new Error(`No article body found on ${pageUrl}`);
    }

    const subtitle = $('.field_subtitle').first().text().trim();

    return {
        title: $('h1.page-title').first().text().trim(),
        pubDate: parseOfficialDate($('.node-date time').first().attr('datetime') ?? $('.node-date time').first().text()),
        description: renderBody(`${subtitle ? toParagraph(subtitle) : ''}${body.html() ?? ''}`, pageUrl),
        author: $('.node-component .field__item a').first().text().trim() || undefined,
        category: collectCategories($, $('.node-type, .node-topics .field__item')),
    };
};

const parseFbiArticle = ($: CheerioAPI, pageUrl: string): ParsedArticle => {
    // FBI releases are assembled from movable content tiles; only the rich text and raw HTML
    // tiles hold the body, the others carry location, contacts, sharing buttons and dates.
    const bodyHtml = $('#main-content .mosaic-tile')
        .toArray()
        .filter((element) => BODY_TILE_PATTERN.test($(element).attr('class') ?? ''))
        .map((element) => $(element).find('.mosaic-tile-content').first().html() ?? '')
        .join('\n')
        .trim();

    if (!bodyHtml) {
        throw new Error(`No article body found on ${pageUrl}`);
    }

    return {
        title: $('h1').first().text().trim(),
        pubDate: parseOfficialDate($('.press-release-date').first().text()),
        description: renderBody(bodyHtml, pageUrl),
        author: $('.press-release-creator .mosaic-tile-content').first().text().trim() || undefined,
    };
};

const parseDhsArticle = ($: CheerioAPI, pageUrl: string): ParsedArticle => {
    const body = $('#block-mainpagecontent .field--name-body').first();
    if (!body.length) {
        throw new Error(`No article body found on ${pageUrl}`);
    }

    return {
        title: $('h1.page-title').first().text().trim(),
        pubDate: parseOfficialDate($('.news-release-date-value').first().text()),
        description: renderBody(body.html() ?? '', pageUrl),
        category: collectCategories($, $('.news-type')),
    };
};

const parseCiaArticle = ($: CheerioAPI, pageUrl: string): ParsedArticle => {
    const body = $('.article-content').first();
    if (!body.length) {
        throw new Error(`No article body found on ${pageUrl}`);
    }

    // The banner right above the release body is a site-wide image, not article content.
    $('.article-content .basic-image-container').remove();

    return {
        title: $('h1').first().text().trim(),
        pubDate: parseOfficialDate($('.hero-content').first().text()),
        description: renderBody(body.html() ?? '', pageUrl),
        author: 'Central Intelligence Agency',
    };
};

/**
 * Official dates appear either as ISO timestamps or as "November 6, 2026" strings. A bare date
 * carries no timezone, so it is pinned to UTC to keep the official calendar day intact.
 * Missing or unparsable dates stay undefined, so a fetch time never becomes a publication time.
 */
export const parseOfficialDate = (value?: string) => {
    if (!value?.trim()) {
        return;
    }

    const officialDate = OFFICIAL_DATE_PATTERN.exec(value);
    const parsed = officialDate ? timezone(parseDate(officialDate[0], 'MMMM D, YYYY'), 0) : parseDate(value.trim());

    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

/** The same date as an ISO string, so it survives the JSON cache. */
const toIsoString = (date?: Date) => (date && !Number.isNaN(date.getTime()) ? date.toISOString() : undefined);

const collectCategories = ($: CheerioAPI, selection: Cheerio<Element>) => [
    ...new Set(
        selection
            .toArray()
            .map((element) => $(element).text().trim())
            .filter(Boolean)
    ),
];

const toParagraph = (text: string) => `<p>${text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</p>`;

/**
 * Official markup is kept as published, but relative links and lazy-loaded images need absolute
 * URLs to remain readable outside the source site.
 */
const renderBody = (html: string, baseUrl: string) => {
    if (!html.trim()) {
        return;
    }

    const $ = load(html, null, false);
    $('script, style, noscript, iframe, form').remove();

    // Gatsby and Drupal ship images as placeholders plus a lazy-load attribute.
    $('img[data-src]').each((_, element) => {
        const $element = $(element);
        $element.attr('src', $element.attr('data-src'));
        $element.removeAttr('data-src');
    });
    $('source[data-srcset]').each((_, element) => {
        const $element = $(element);
        $element.attr('srcset', $element.attr('data-srcset'));
        $element.removeAttr('data-srcset');
    });

    for (const attribute of ['href', 'src']) {
        $(`[${attribute}]`).each((_, element) => {
            const $element = $(element);
            const value = $element.attr(attribute);
            if (value) {
                $element.attr(attribute, absolutize(value, baseUrl));
            }
        });
    }

    return $.html().trim() || undefined;
};

const absolutize = (value: string, baseUrl: string) => {
    try {
        return new URL(value, baseUrl).href;
    } catch {
        return value;
    }
};

const toPlainText = (html: string) => (html ? load(html, null, false).text().replaceAll(/\s+/g, ' ').trim() : '');

/** PDF attachments are part of the official evidence, so they are also exposed as enclosures. */
const collectPdfAttachments = (html: string, baseUrl: string) => {
    if (!html) {
        return;
    }

    const $ = load(html, null, false);
    const urls = new Set<string>();

    $('a[href]').each((_, element) => {
        const href = $(element).attr('href');
        if (href && /\.pdf(?:$|\?)/i.test(href)) {
            urls.add(absolutize(href, baseUrl));
        }
    });

    if (!urls.size) {
        return;
    }

    return [...urls].map((url) => ({
        url,
        mime_type: 'application/pdf',
        title: decodeURIComponent(new URL(url).pathname.split('/').pop() ?? ''),
    }));
};
