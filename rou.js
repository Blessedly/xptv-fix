const cheerio = createCheerio()

const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'

const appConfig = {
    ver: 2026090801,
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
 * 解码站点自定义的 Base64 数据。
 *
 * @param {string} value Base64 文本
 * @return {string} 解码后的文本
 */
function decodeBase64(value) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/='
    const indices = {}
    for (let index = 0; index < alphabet.length; index++) indices[alphabet[index]] = index

    const paddingIndex = value.indexOf('=')
    const padded = paddingIndex > -1
    const length = padded ? paddingIndex : value.length
    let position = -1
    let result = ''

    while (position < length) {
        const code =
            (indices[value[++position]] << 18) |
            (indices[value[++position]] << 12) |
            (indices[value[++position]] << 6) |
            indices[value[++position]]
        if (code !== 0) {
            result += String.fromCharCode((code >>> 16) & 255, (code >>> 8) & 255, code & 255)
        }
    }
    return padded ? result.slice(0, paddingIndex - value.length) : result
}

/**
 * 解码详情页 __NEXT_DATA__ 中的播放参数。
 *
 * @param {{d:string,k:number}} ev 加密播放参数
 * @return {object} 解码后的播放信息
 */
function decodeEv(ev) {
    const decoded = decodeBase64(ev.d)
        .split('')
        .map((character) => String.fromCharCode(character.charCodeAt(0) - ev.k))
        .join('')
    return JSON.parse(decoded)
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
    const html = await requestHtml(detailUrl)
    const $ = cheerio.load(html)
    const scriptContent = $('#__NEXT_DATA__').html()
    if (!scriptContent) throw new Error('详情页缺少 __NEXT_DATA__ 播放数据')

    const jsonData = JSON.parse(scriptContent)
    const ev = jsonData.props && jsonData.props.pageProps && jsonData.props.pageProps.ev
    if (!ev || !ev.d) throw new Error('详情页缺少 ev 加密播放参数')

    const decodedEv = decodeEv(ev)
    const playUrl = absoluteUrl(decodedEv.videoUrl)
    return jsonify({
        list: [
            {
                title: '默认分组',
                tracks: [
                    {
                        name: '播放',
                        pan: '',
                        ext: { url: playUrl, referer: detailUrl },
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
    const playUrl = absoluteUrl(ext.url).replace('.jpg', '.m3u8')
    return jsonify({
        urls: [playUrl],
        headers: [
            {
                'User-Agent': UA,
                Referer: ext.referer || `${appConfig.site}/`,
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
