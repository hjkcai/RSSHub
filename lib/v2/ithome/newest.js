const got = require('@/utils/got');
const cheerio = require('cheerio');

module.exports = async (ctx) => {
    const current_url = 'https://www.ithome.com/blog/';
    const response = await got({
        method: 'get',
        url: current_url,
    });

    const $ = cheerio.load(response.data);
    const list = $('#list > div.fl > ul > li > div > h2 > a')
        .slice(0, 10)
        .map((_, item) => {
            item = $(item);
            return {
                title: item.text(),
                link: item.attr('href'),
            };
        })
        .get()
        .filter((item) => !item.link.includes('lapin.ithome.com'));

    const items = await Promise.all(
        list.map((item) =>
            ctx.cache.tryGet(item.link, async () => {
                const res = await got({ method: 'get', url: item.link });
                const content = cheerio.load(res.data);
                const post = content('#paragraph');
                post.find('img[data-original]').each((_, ele) => {
                    ele = $(ele);
                    ele.attr('src', ele.attr('data-original'));
                    ele.removeAttr('class');
                    ele.removeAttr('data-original');
                });
                item.description = post.html();
                item.pubDate = new Date(content('#pubtime_baidu').text() + ' GMT+8').toUTCString();
                return item;
            })
        )
    );

    ctx.state.data = {
        title: 'IT 之家 - 最新',
        link: current_url,
        image: 'https://img.ithome.com/m/images/logo.png',
        item: items
    };
};
