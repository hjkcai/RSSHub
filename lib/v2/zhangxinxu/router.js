const wp = require('../../routes/blogs/wordpress');

module.exports = (router) => {
    router.get('/', async (ctx) => {
        ctx.params.domain = 'www.zhangxinxu.com/wordpress';
        await wp(ctx);

        ctx.state.data.item.forEach((item) => {
            item.author = item.author === '张 鑫旭' ? '张鑫旭' : item.author;
            item.description = item.description.split('\n').slice(3, -5).join('\n').trim();
        });
    });
};
