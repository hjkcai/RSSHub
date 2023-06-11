const RSSParser = require('rss-parser');
const got = require('@/utils/got');

module.exports = async (ctx) => {
    const { data } = await got({ method: 'get', url: ctx.params[0] });
    const rss = await new RSSParser().parseString(data);
    ctx.state.data = {
        title: rss.title,
        link: rss.link,
        item: rss.items.map((item) => ({
            ...item,
            content: undefined,
            description: item.content,
        })),
    };
};
