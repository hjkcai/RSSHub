const got = require('@/utils/got');
const config = require('@/config').value;
const utils = require('./utils');
const { parseDate } = require('@/utils/parse-date');

module.exports = async (ctx) => {
    const cookie = config.zhihu.cookies;
    if (cookie === undefined) {
        throw Error('缺少知乎用户登录后的 Cookie 值');
    }

    const response = await got({
        method: 'get',
        url: `https://www.zhihu.com/api/v3/moments?desktop=true`,
        headers: {
            Cookie: cookie,
        },
    });
    const feeds = response.data.data;

    const urlBase = 'https://zhihu.com';
    const buildLink = (e) => {
        if (!e || !e.target || !e.target.type) {
            return '';
        }
        const id = e.target.id;
        switch (e.target.type) {
            case 'answer': {
                const questionId = e.target.question.id;
                return `${urlBase}/question/${questionId}/answer/${id}`;
            }
            case 'article':
                return e.target.url;
            case 'question':
                return `${urlBase}/question/${id}`;
        }
        return '';
    };

    /**
     * Returns one non-undefined/null element from a list of items
     * make sure there exists at least one element that is non-undefined
     *
     * @param {Array} list a list of items to be filtered
     */
    const getOne = (list) => list.filter((e) => e !== undefined && e !== null)[0];

    const buildItem = (e) => {
        if (!e || !e.target) {
            return {};
        }
        return {
            title: getOne([e.target.title, e.target.question ? e.target.question.title : '']),
            description: utils.ProcessImage(getOne([e.target.content, e.target.detail, e.target.excerpt, ''])),
            pubDate: parseDate(e.updated_time * 1000),
            link: buildLink(e),
            author: e.target.author ? e.target.author.name : '',
            guid: this.link,
        };
    };

    const out = feeds
        .filter((e) => e && e.type && e.type !== 'feed_advert')
        .flatMap((e) => {
            if (e && e.type && e.type === 'feed_group') {
                return e.list.map(buildItem);
            }
            return [buildItem(e)];
        });

    ctx.state.data = {
        title: `知乎关注动态`,
        link: `https://www.zhihu.com/follow`,
        item: out,
    };
};
