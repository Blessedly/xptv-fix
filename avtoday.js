const cheerio = createCheerio()

const UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'

const headers = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
}

const appConfig = {
    ver: 2026090301,
    title: 'avtoday',
    site: 'https://avtoday.io',
}

/**
 * 返回客户端配置和实时分类。
 */
async function getConfig() {
    const config = appConfig
    config.tabs = await getTabs()
    return jsonify(config)
}

/**
 * 将站内相对地址转换为完整 URL。
 */
function absoluteUrl(url) {
    const value = String(url || '').trim()
    if (!value) return ''
    if (value.startsWith('//')) return `https:${value}`
    if (/^https?:\/\//i.test(value)) return value
    return `${appConfig.site}${value.startsWith('/') ? '' : '/'}${value}`
}

/**
 * 清理页面文本中的换行、不间断空格和多余空白。
 */
function cleanText(text) {
    return String(text || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

/**
 * 从样式或 video 属性中读取海报地址。
 */
function getCover($, element) {
    const video = $(element).find('.preview-video').first()
    const style = video.attr('style') || ''
    // 当前站点把海报写在 background: url(...) 中，同时保留属性回退以兼容后续改版。
    const match = style.match(/url\(\s*(['"]?)(.*?)\1\s*\)/i)
    return absoluteUrl(
        (match && match[2]) ||
            video.attr('poster') ||
            video.attr('data-poster') ||
            video.attr('data-src') ||
            '',
    )
}

/**
 * 从分类页或搜索页统一解析影片卡片。
 */
function parseCards(html) {
    const cards = []
    const seen = {}
    const $ = cheerio.load(String(html || ''))

    $('.thumbnail').each((_, element) => {
        const titleLink = $(element).find('.video-title a').first()
        const href = titleLink.attr('href') || $(element).find('a[href*="/video/"]').first().attr('href')
        const title = cleanText(titleLink.text() || titleLink.attr('title'))

        // 广告卡片没有有效影片信息，过滤后可避免空白海报和无效播放项。
        if (
            !href ||
            !title ||
            !/\/video\//i.test(href) ||
            /\[(?:AD|廣告|广告)\]|[廣广]告/i.test(title) ||
            seen[href]
        ) {
            return
        }

        const cover = getCover($, element)
        const subTitle = cleanText($(element).find('.video-tag').first().text())
        const duration = cleanText($(element).find('.video-duration').first().text())
        const pubdate = cleanText($(element).find('.video-date').first().text())
        seen[href] = true

        cards.push({
            vod_id: href,
            vod_name: title,
            vod_pic: cover,
            vod_remarks: subTitle || duration,
            vod_duration: duration,
            vod_pubdate: pubdate,
            ext: { url: absoluteUrl(href) },
        })
    })

    return cards
}

/**
 * 从目录页解析分类，并过滤重复入口。
 */
async function getTabs() {
    const list = []
    const seen = {}

    try {
        const { data } = await $fetch.get(`${appConfig.site}/catalog`, { headers })
        const $ = cheerio.load(data)

        $('.swiper-wrapper > .swiper-slide').each((_, element) => {
            const link = $(element).find('a.btn-categories').first()
            const href = absoluteUrl(link.attr('href'))
            const name = cleanText($(element).find('.btn-categories__title').first().text())
            const info = cleanText($(element).find('.btn-categories__info').first().text()).split(' ')[0]
            if (!href || !name || seen[href]) return

            seen[href] = true
            list.push({
                name: info ? `${name} (${info})` : name,
                ext: { url: href },
                ui: 1,
            })
        })
    } catch (error) {
        $print(`avtoday 分类解析失败：${error}`)
    }

    return list
}

/**
 * 加载分类列表，并按站点现有规则追加页码。
 */
async function getCards(ext) {
    ext = argsify(ext)
    const page = Number(ext.page || 1)
    const baseUrl = absoluteUrl(ext.url)
    if (!baseUrl) return jsonify({ list: [] })

    const url = page > 1 ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}page=${page}` : baseUrl
    try {
        const { data } = await $fetch.get(url, {
            headers: { ...headers, Referer: `${appConfig.site}/catalog` },
        })
        return jsonify({ list: parseCards(data) })
    } catch (error) {
        $print(`avtoday 列表请求失败：${error}`)
        return jsonify({ list: [] })
    }
}

/**
 * 从详情页 iframe 获取播放器页，再提取真实 m3u8 地址。
 */
async function getTracks(ext) {
    ext = argsify(ext)
    const pageUrl = absoluteUrl(ext.url)
    if (!pageUrl) return jsonify({ list: [] })

    try {
        const detailResponse = await $fetch.get(pageUrl, {
            headers: { ...headers, Referer: `${appConfig.site}/chs/index.html` },
        })
        const $ = cheerio.load(detailResponse.data)
        let playerUrl = absoluteUrl($('iframe.video-frame, iframe[src*="/player?s="]').first().attr('src'))

        if (!playerUrl) {
            // 兼容旧详情结构，但必须去掉 .html，站点播放器参数不接受扩展名。
            const match = pageUrl.match(/\/video\/([^/?#]+)/i)
            const code = match && match[1] ? match[1].replace(/\.html$/i, '') : ''
            if (code) playerUrl = `${appConfig.site}/player?s=${encodeURIComponent(code)}`
        }
        if (!playerUrl) throw new Error('详情页没有找到播放器 iframe')

        const playerResponse = await $fetch.get(playerUrl, {
            headers: { ...headers, Referer: pageUrl },
        })
        const playMatch = String(playerResponse.data).match(/m3u8_url\s*=\s*['"]([^'"]+)['"]/i)
        if (!playMatch || !playMatch[1]) throw new Error('播放器页没有找到 m3u8_url')

        return jsonify({
            list: [
                {
                    title: '默认分组',
                    tracks: [
                        {
                            name: '播放',
                            pan: '',
                            ext: {
                                url: absoluteUrl(playMatch[1]),
                                playerUrl,
                            },
                        },
                    ],
                },
            ],
        })
    } catch (error) {
        $print(`avtoday 播放解析失败：${error}`)
        return jsonify({ list: [] })
    }
}

/**
 * 返回媒体清单与分片服务器要求的请求头。
 */
async function getPlayinfo(ext) {
    ext = argsify(ext)
    const url = absoluteUrl(ext.url)
    const referer = absoluteUrl(ext.playerUrl) || `${appConfig.site}/`

    return jsonify({
        urls: [url],
        headers: [
            {
                'User-Agent': UA,
                Referer: referer,
                Origin: appConfig.site,
            },
        ],
    })
}

/**
 * 搜索影片，并复用列表的海报与详情地址解析逻辑。
 */
async function search(ext) {
    ext = argsify(ext)
    const text = encodeURIComponent(ext.text || '')
    const page = Number(ext.page || 1)
    if (!text) return jsonify({ list: [] })

    const url = `${appConfig.site}/search?s=${text}&page=${page}`
    try {
        const { data } = await $fetch.get(url, {
            headers: {
                ...headers,
                Referer: `${appConfig.site}/chs/index.html`,
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'same-origin',
            },
        })
        return jsonify({ list: parseCards(data) })
    } catch (error) {
        $print(`avtoday 搜索请求失败：${error}`)
        return jsonify({ list: [] })
    }
}
