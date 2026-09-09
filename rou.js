const cheerio = createCheerio()

const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'
const PLAY_PROXY = 'https://rou-control.blessedlymm.workers.dev'

const appConfig = {
    ver: 2026090902,
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
 * 从不同网络实现的响应头对象中读取指定字段。
 *
 * @param {object} response 网络响应或异常响应
 * @param {string} name 响应头名称
 * @return {string} 响应头内容
 */
function readResponseHeader(response, name) {
    const headers = response && response.headers
    if (!headers) return ''
    if (headers.get === 'function') return headers.get(name) || ''

    const expected = name.toLowerCase()
    const key = Object.keys(headers).find((item) => item.toLowerCase() === expected)
    const value = key ? headers[key] : ''
    return Array.isArray(value) ? value[0] || '' : String(value || '')
}

/**
 * 从 XPTV 网络响应的常见字段中读取重定向后的最终地址。
 *
 * @param {object} response 网络响应
 * @param {string} originalUrl 原始接口地址
 * @return {string} CDN 最终地址
 */
function readFinalUrl(response, originalUrl) {
    if (!response) return ''
    const candidates = [
        readResponseHeader(response, 'location'),
        response.url,
        response.responseURL,
        response.request && response.request.responseURL,
        response.request && response.request.url,
    ]

    // 某些实现会把 302 的目标地址写进简短 HTML 响应体。
    if (typeof response.data === 'string') {
        const match = response.data.match(/https:\/\/[^\s'"<>]+\/hls\/[^\s'"<>]+\.png[^\s'"<>]*/i)
        if (match) candidates.push(match[0].replace(/&amp;/g, '&'))
    }

    return (
        candidates.find(
            (value) =>
                typeof value === 'string' &&
                value !== originalUrl &&
                /^https:\/\/[^/]+\/hls\/.*\.png(?:\?|$)/i.test(value)
        ) || ''
    )
}

/**
 * 由手机端请求 Rou 接口并取得 CDN 跳转地址，绕过源站对 Worker 出口的 403。
 *
 * @param {string} id 视频 ID
 * @param {string} detailUrl 视频详情页
 * @return {Promise<string>} CDN 上的 PNG-HLS 清单地址
 */
async function resolveCdnManifest(id, detailUrl) {
    const apiUrl = `${appConfig.site}/api/hls/${id}`
    const options = {
        headers: {
            ...headers,
            Referer: detailUrl,
        },
        // 同时兼容 Fetch 风格和 Axios 风格的禁止自动跳转参数。
        redirect: 'manual',
        maxRedirects: 0,
    }

    try {
        const response = await $fetch.get(apiUrl, options)
        const finalUrl = readFinalUrl(response, apiUrl)
        if (finalUrl) return finalUrl
    } catch (error) {
        const response = error && (error.response || error)
        const finalUrl = readFinalUrl(response, apiUrl)
        if (finalUrl) return finalUrl
    }

    // 部分 XPTV 版本忽略禁止跳转参数，但会在普通响应上保留最终 responseURL。
    try {
        const response = await $fetch.get(apiUrl, {
            headers: options.headers,
            responseType: 'arraybuffer',
        })
        const finalUrl = readFinalUrl(response, apiUrl)
        if (finalUrl) return finalUrl
    } catch (error) {
        const response = error && (error.response || error)
        const finalUrl = readFinalUrl(response, apiUrl)
        if (finalUrl) return finalUrl
    }

    throw new Error('XPTV 未返回 Rou 的 CDN 跳转地址')
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

    // 先由手机取得 CDN 地址，再让 Worker 解包，避免 Rou 对 Worker 出口返回 403。
    const cdnManifest = await resolveCdnManifest(idMatch[1], detailUrl)
    const playUrl = `${PLAY_PROXY}/media?url=${encodeURIComponent(cdnManifest)}`
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
