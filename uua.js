const cheerio = createCheerio()

const UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'

const appConfig = {
    ver: 2026090901,
    title: '有爱爱',
    site: 'https://www.uaa2610.com',
    tabs: [
        { name: '国产视频', ui: 1, ext: { tip: 'chinese-av-porn', origin: 1 } },
        { name: '日本AV', ui: 1, ext: { tip: 'jav', origin: 1 } },
        { name: '无码流出', ui: 1, ext: { category: '无码流出', origin: 2 } },
        { name: 'H动漫', ui: 1, ext: { origin: 3 } },
    ],
}

let verificationOpened = false

/**
 * 返回扩展配置。
 */
async function getConfig() {
    return jsonify(appConfig)
}

/**
 * 返回当前站点的来源地址。
 */
function getOrigin(url) {
    const match = String(url || '').match(/^(https?:\/\/[^/]+)/i)
    return match ? match[1] : appConfig.site
}

/**
 * 把站内相对地址补全为绝对地址。
 */
function absoluteUrl(url, baseUrl = appConfig.site) {
    const value = String(url || '')
        .replace(/&amp;/g, '&')
        .replace(/\\\//g, '/')
        .trim()
    if (!value) return ''
    if (value.startsWith('//')) return `https:${value}`
    if (/^https?:\/\//i.test(value)) return value
    return `${getOrigin(baseUrl)}${value.startsWith('/') ? '' : '/'}${value}`
}

/**
 * 判断网页是否为 Cloudflare 验证或拦截页面。
 */
function isChallengePage(html) {
    const text = String(html || '')
    return (
        /<title>\s*(?:Just a moment|Attention Required|请稍候)/i.test(text) ||
        /window\._cf_chl_opt\b|id=["']challenge-form["']|cf-error-details/i.test(text)
    )
}

/**
 * 打开一次浏览器验证页；认证完成后回到 XPTV 刷新列表即可。
 */
function openVerification(url) {
    if (
        verificationOpened ||
        typeof $utils === 'undefined' ||
        typeof $utils.openSafari !== 'function'
    ) {
        return
    }

    verificationOpened = true
    $print('有爱爱需要完成一次浏览器验证，验证后请返回并刷新列表')
    $utils.openSafari(url, UA)
}

/**
 * 统一请求网页，并在 Cloudflare 拦截时触发一次浏览器认证。
 */
async function requestHtml(url, referer = appConfig.site + '/') {
    try {
        const response = await $fetch.get(url, {
            headers: {
                'User-Agent': UA,
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                Referer: referer,
                'Cache-Control': 'no-cache',
                Pragma: 'no-cache',
            },
        })
        const html = String(response.data || '')

        // 验证页不能交给列表解析器，否则只会得到空列表。
        if (isChallengePage(html)) {
            openVerification(url)
            throw new Error('NEED_BROWSER_VERIFICATION')
        }
        return html
    } catch (error) {
        const message = String(error || '')

        // 部分 XPTV 版本会直接把 403 当作异常，仍需进入同一认证流程。
        if (/403|Forbidden|Cloudflare|Just a moment/i.test(message)) {
            openVerification(url)
            throw new Error('NEED_BROWSER_VERIFICATION')
        }
        throw error
    }
}

/**
 * 构造分类列表地址，并修复原脚本中的 $sort 参数错误。
 */
function buildListUrl(ext) {
    const page = Math.max(1, Number(ext.page || 1))
    const params = []
    if (ext.category) params.push(`category=${encodeURIComponent(ext.category)}`)
    if (ext.origin) params.push(`origin=${encodeURIComponent(ext.origin)}`)
    if (page > 1) {
        params.push('sort=1')
        params.push(`page=${page}`)
    }

    const path = ext.tip ? `/${ext.tip}` : '/video/list'
    return `${appConfig.site}${path}${params.length ? `?${params.join('&')}` : ''}`
}

/**
 * 从列表 HTML 中解析视频卡片。
 */
function parseCards(html) {
    const cards = []
    const seen = {}
    const $ = cheerio.load(html)

    $('li.video_li, .video_li').each((_, element) => {
        const item = $(element)
        const link = item.find('.title a[href], .cover_box a[href], a[href]').first()
        const href = link.attr('href') || ''
        if (!href || seen[href]) return

        const title =
            item.find('.title a, .title').first().text().replace(/\s+/g, ' ').trim() ||
            link.attr('title') ||
            ''
        const image = item.find('img.cover, .cover_box img, img').first()
        const cover =
            image.attr('src') ||
            image.attr('data-cfsrc') ||
            image.attr('data-src') ||
            image.attr('data-original') ||
            ''
        if (!title) return

        const detailUrl = absoluteUrl(href)
        const pubdate = item.find('.info_box .view span, .info_box span, span').first().text().trim()
        seen[href] = true
        cards.push({
            vod_id: detailUrl,
            vod_name: title,
            vod_pic: absoluteUrl(cover),
            vod_pubdate: pubdate,
            ext: { url: detailUrl },
        })
    })
    return cards
}

/**
 * 加载分类列表。
 */
async function getCards(ext) {
    ext = argsify(ext)
    const url = buildListUrl(ext)

    try {
        const html = await requestHtml(url)
        const cards = parseCards(html)
        if (!cards.length) $print(`有爱爱列表未解析到内容：${url}`)
        return jsonify({ list: cards })
    } catch (error) {
        if (!String(error).includes('NEED_BROWSER_VERIFICATION')) {
            $print(`有爱爱列表请求失败：${error}`)
        }
        return jsonify({ list: [] })
    }
}

/**
 * 从详情页播放器节点或脚本中提取媒体地址。
 */
function extractPlayUrl(html, pageUrl) {
    const $ = cheerio.load(html)
    const player = $('#mui-player').first()
    let playUrl =
        player.attr('src') ||
        player.attr('data-src') ||
        $('video source[src]').first().attr('src') ||
        $('video[src]').first().attr('src') ||
        ''

    if (!playUrl) {
        const patterns = [
            /(?:playUrl|videoUrl|url|src)\s*[:=]\s*["']([^"']+\.(?:m3u8|mp4)(?:\?[^"']*)?)["']/i,
            /["']file["']\s*:\s*["']([^"']+)["']/i,
        ]
        for (const pattern of patterns) {
            const match = String(html).match(pattern)
            if (match && match[1]) {
                playUrl = match[1]
                break
            }
        }
    }
    return absoluteUrl(playUrl, pageUrl)
}

/**
 * 加载视频详情并生成播放线路。
 */
async function getTracks(ext) {
    ext = argsify(ext)
    const pageUrl = absoluteUrl(ext.url)

    try {
        const html = await requestHtml(pageUrl, appConfig.site + '/')
        const playUrl = extractPlayUrl(html, pageUrl)
        if (!playUrl) throw new Error('详情页没有找到 m3u8 或 mp4 地址')

        return jsonify({
            list: [
                {
                    title: '默认分组',
                    tracks: [
                        {
                            name: '播放',
                            pan: '',
                            ext: { url: playUrl, referer: pageUrl },
                        },
                    ],
                },
            ],
        })
    } catch (error) {
        if (!String(error).includes('NEED_BROWSER_VERIFICATION')) {
            $print(`有爱爱详情解析失败：${error}`)
        }
        return jsonify({ list: [] })
    }
}

/**
 * 返回媒体地址及防盗链请求头。
 */
async function getPlayinfo(ext) {
    ext = argsify(ext)
    const playUrl = absoluteUrl(ext.url, ext.referer || appConfig.site)
    const referer = ext.referer || appConfig.site + '/'

    return jsonify({
        urls: [playUrl],
        headers: [
            {
                'User-Agent': UA,
                Referer: referer,
                Origin: getOrigin(referer),
            },
        ],
    })
}

/**
 * 搜索视频并复用列表解析逻辑。
 */
async function search(ext) {
    ext = argsify(ext)
    const text = encodeURIComponent(ext.text || '')
    const page = Math.max(1, Number(ext.page || 1))
    const url = `${appConfig.site}/video/list?searchType=1&keyword=${text}&category=&origin=&tag=&sort=0&page=${page}`

    try {
        const html = await requestHtml(url)
        return jsonify({ list: parseCards(html) })
    } catch (error) {
        if (!String(error).includes('NEED_BROWSER_VERIFICATION')) {
            $print(`有爱爱搜索请求失败：${error}`)
        }
        return jsonify({ list: [] })
    }
}
