const cheerio = createCheerio()

const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'
const PLAY_PROXY = 'https://rou-control.blessedlymm.workers.dev'

const appConfig = {
    ver: 2026090901,
    title: '肉视频-Fix',
    site: 'https://rou.video',
    tabs: [
        { name: '國產AV', ui: 1, ext: { url: 'https://rou.video/t/國產AV' } },
        { name: '探花', ui: 1, ext: { url: 'https://rou.video/t/探花' } },
        { name: '自拍流出', ui: 1, ext: { url: 'https://rou.video/t/自拍流出' } },
        { name: 'OnlyFans', ui: 1, ext: { url: 'https://rou.video/t/OnlyFans' } },
        { name: '日本', ui: 1, ext: { url: 'https://rou.video/t/日本' } },
    ],
}

const headers = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
}

/**
 * 将相对地址补全为站内完整地址。
 *
 * @param {string} url 原始地址
 * @return {string} 完整地址
 */
function absoluteUrl(url) {
    const value = String(url || '').trim()
    if (!value) return ''
    if (/^https?:\/\//i.test(value)) return value
    if (value.startsWith('//')) return `https:${value}`
    return `${appConfig.site}${value.startsWith('/') ? '' : '/'}${value}`
}

/**
 * 请求站内 HTML，并统一携带浏览器请求头。
 *
 * @param {string} url 页面地址
 * @param {string} referer 来源页面
 * @return {Promise<string>} 页面 HTML
 */
async function requestHtml(url, referer = `${appConfig.site}/`) {
    const { data } = await $fetch.get(url, {
        headers: {
            ...headers,
            Referer: referer,
        },
    })
    return typeof data === 'string' ? data : String(data || '')
}

/**
 * 解析新版视频卡片，同时保留对旧版页面结构的兼容。
 *
 * @param {string} html 列表页 HTML
 * @return {Array<object>} XPTV 视频卡片
 */
function parseCards(html) {
    const cards = []
    const $ = cheerio.load(html)

    // 新版卡片自身就是 /v/ 链接，旧版卡片则由网格中的 div 包裹。
    const modernCards = $('a.group[href^="/v/"]')
    if (modernCards.length > 0) {
        modernCards.each((_, element) => {
            const item = $(element)
            const href = item.attr('href') || ''
            const image = item.find('img[loading="lazy"]').first()
            const fallbackImage = item.find('img').last()
            const title = item.find('h3').first().text().trim() || image.attr('alt') || fallbackImage.attr('alt') || ''
            const cover = image.attr('src') || fallbackImage.attr('src') || ''
            const duration = item.find('span.absolute[class*="bottom-"]').first().text().trim()

            if (!href) return
            cards.push({
                vod_id: href,
                vod_name: title || '未命名视频',
                vod_pic: absoluteUrl(cover),
                vod_remarks: duration,
                ext: { url: absoluteUrl(href) },
            })
        })
        return cards
    }

    // 网站临时回退旧模板时仍可继续解析。
    $('.grid.grid-cols-2.mb-6 > div').each((_, element) => {
        const item = $(element)
        const href = item.find('.relative a').attr('href') || ''
        if (!href) return

        cards.push({
            vod_id: href,
            vod_name: item.find('img').last().attr('alt') || '未命名视频',
            vod_pic: absoluteUrl(item.find('img').first().attr('src')),
            vod_remarks: item.find('.relative a > div:eq(1)').text() || item.find('.relative a > div:first').text(),
            ext: { url: absoluteUrl(href) },
        })
    })
    return cards
}

/**
 * 返回扩展配置。
 */
async function getConfig() {
    return jsonify(appConfig)
}

/**
 * 获取分类视频列表。
 */
async function getCards(ext) {
    ext = argsify(ext)
    const page = ext.page || 1
    let url = ext.url
    if (page > 1) url += `${url.includes('?') ? '&' : '?'}order=createdAt&page=${page}`

    const html = await requestHtml(url)
    return jsonify({ list: parseCards(html) })
}

/**
 * 获取详情页中的播放线路。
 */
async function getTracks(ext) {
    ext = argsify(ext)
    const detailUrl = absoluteUrl(ext.url)
    const idMatch = detailUrl.match(/\/v\/([a-z0-9]+)/i)
    if (!idMatch) throw new Error('详情地址中缺少视频 ID')

    // Worker 会解包伪装成 PNG 的 M3U8，并继续代理清单内的所有媒体分片。
    const playUrl = `${PLAY_PROXY}/hls?id=${encodeURIComponent(idMatch[1])}`
    return jsonify({
        list: [
            {
                title: '默认分组',
                tracks: [
                    {
                        name: '播放',
                        pan: '',
                        ext: { url: playUrl, type: 'm3u8' },
                    },
                ],
            },
        ],
    })
}

/**
 * 返回播放器需要的地址和防盗链请求头。
 */
async function getPlayinfo(ext) {
    ext = argsify(ext)
    return jsonify({
        urls: [ext.url],
        type: ext.type || 'm3u8',
        headers: [
            {
                'User-Agent': UA,
            },
        ],
    })
}

/**
 * 搜索视频。
 */
async function search(ext) {
    ext = argsify(ext)
    const keyword = encodeURIComponent(ext.text || ext.keyword || '')
    const page = ext.page || 1
    const url = `${appConfig.site}/search?q=${keyword}&t=&page=${page}`
    const html = await requestHtml(url)
    return jsonify({ list: parseCards(html) })
}
