const cheerio = createCheerio()

const UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'

const headers = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
}

// 官方地址发布页列出的新线路优先，主域名作为最后回退。
const mirrorSites = [
    'https://www.uaa2610.com',
    'https://www.uaa2609.com',
    'https://www.uaa2608.com',
    'https://www.uaa.com',
]

let activeSite = mirrorSites[0]
let challengeOpened = false

const appConfig = {
    ver: 2026090402,
    title: '有爱爱',
    // 保留字面量，便于通用检测脚本直接识别当前首选域名。
    site: 'https://www.uaa2610.com',
    tabs: [
        {
            name: '国产视频',
            ui: 1,
            ext: {
                tip: 'chinese-av-porn',
                origin: 1,
            },
        },
        {
            name: '日本AV',
            ui: 1,
            ext: {
                tip: 'jav',
                origin: 1,
            },
        },
        {
            name: '无码流出',
            ui: 1,
            ext: {
                category: '无码流出',
                origin: 2,
            },
        },
        {
            name: 'H动漫',
            ui: 1,
            ext: {
                origin: 3,
            },
        },
    ],
}

/**
 * 返回扩展配置。
 */
async function getConfig() {
    return jsonify(appConfig)
}

/**
 * 取得完整地址中的协议和主机部分。
 */
function getOrigin(url) {
    const match = String(url || '').match(/^(https?:\/\/[^/]+)/i)
    return match ? match[1] : activeSite
}

/**
 * 将相对地址转换为完整地址。
 */
function absoluteUrl(url, site = activeSite) {
    const value = String(url || '').replace(/&amp;/g, '&').trim()
    if (!value) return ''
    if (value.startsWith('//')) return `https:${value}`
    if (/^https?:\/\//i.test(value)) return value
    return `${site}${value.startsWith('/') ? '' : '/'}${value}`
}

/**
 * 判断响应内容是否为 Cloudflare 人机验证页。
 */
function isChallengePage(html) {
    const text = String(html || '')
    return (
        /<title>\s*(?:Just a moment|请稍候)/i.test(text) ||
        /challenge-platform|cf-chl-|Performing security verification/i.test(text)
    )
}

/**
 * 只打开一次内置浏览器，让用户完成 Cloudflare 验证。
 */
function openChallengePage(url) {
    if (
        challengeOpened ||
        typeof $utils === 'undefined' ||
        typeof $utils.openSafari !== 'function'
    ) {
        return
    }

    challengeOpened = true
    $utils.openSafari(url, UA)
}

/**
 * 为站内地址生成镜像候选，保留原路径和查询参数。
 */
function buildCandidateUrls(target) {
    const value = String(target || '').trim()
    const path = /^https?:\/\//i.test(value)
        ? value.replace(/^https?:\/\/(?:www\.)?uaa\d*\.com/i, '')
        : value
    const candidates = []
    const preferredSites = [activeSite, ...mirrorSites]

    preferredSites.forEach((site) => {
        const url = absoluteUrl(path, site)
        if (candidates.indexOf(url) < 0) candidates.push(url)
    })
    return candidates
}

/**
 * 请求站内 HTML；当前线路异常或遇到验证页时自动尝试其他官方镜像。
 */
async function requestHtml(target, refererPath = '/') {
    const candidates = buildCandidateUrls(target)
    let lastError = null
    let challengeUrl = ''

    for (const url of candidates) {
        const site = getOrigin(url)
        try {
            const { data } = await $fetch.get(url, {
                headers: {
                    ...headers,
                    Referer: absoluteUrl(refererPath, site),
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'same-origin',
                },
            })
            if (isChallengePage(data)) {
                if (!challengeUrl) challengeUrl = url
                lastError = new Error(`${site} 返回 Cloudflare 验证页`)
                continue
            }

            activeSite = site
            appConfig.site = site
            return { data, url, site }
        } catch (error) {
            // 某些运行环境会直接把 403 当成异常，因此同时检查错误文字。
            if (!challengeUrl && /403|Forbidden|Cloudflare|Just a moment/i.test(String(error || ''))) {
                challengeUrl = url
            }
            lastError = error
        }
    }

    // 所有镜像都失败后再打开验证页，避免切换线路时连续弹出多个网页。
    if (challengeUrl) openChallengePage(challengeUrl)
    throw lastError || new Error('全部官方线路均无法访问')
}

/**
 * 解析视频列表卡片并补全详情和海报地址。
 */
function parseCards(html, pageUrl) {
    const cards = []
    const seen = {}
    const site = getOrigin(pageUrl)
    const $ = cheerio.load(html)

    $('li.video_li').each((_, element) => {
        const item = $(element)
        const link = item.find('.title a[href], .cover_box a[href]').first()
        const href = link.attr('href') || item.find('.cover_box a[href]').first().attr('href')
        if (!href || seen[href]) return

        const title = item.find('.title a').first().text().replace(/\s+/g, ' ').trim()
        const image = item.find('img.cover').first()
        const cover =
            image.attr('src') ||
            image.attr('data-cfsrc') ||
            image.attr('data-src') ||
            image.attr('data-original') ||
            ''
        if (!title) return

        const pubdate = item.find('.info_box .view span').first().text().trim()
        const detailUrl = absoluteUrl(href, site)
        seen[href] = true
        cards.push({
            vod_id: detailUrl,
            vod_name: title,
            vod_pic: absoluteUrl(cover, site),
            vod_pubdate: pubdate,
            ext: { url: detailUrl },
        })
    })
    return cards
}

/**
 * 构造分类分页路径，修复旧脚本误写的 $sort 参数。
 */
function buildListPath(ext) {
    const page = Number(ext.page || 1)
    const params = []

    if (ext.origin) params.push(`origin=${encodeURIComponent(ext.origin)}`)
    if (ext.category) params.push(`category=${encodeURIComponent(ext.category)}`)
    if (page > 1) {
        params.push('sort=1')
        params.push(`page=${page}`)
    }

    if (ext.tip) {
        return `/${ext.tip}${params.length ? `?${params.join('&')}` : ''}`
    }
    return `/video/list${params.length ? `?${params.join('&')}` : ''}`
}

/**
 * 加载分类列表。
 */
async function getCards(ext) {
    ext = argsify(ext)
    try {
        const response = await requestHtml(buildListPath(ext), '/video/list')
        return jsonify({ list: parseCards(response.data, response.url) })
    } catch (error) {
        $print(`有爱爱列表请求失败：${error}`)
        return jsonify({ list: [] })
    }
}

/**
 * 从详情页播放器节点或内联脚本中提取媒体地址。
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
        const match = String(html).match(
            /(?:src|url|playUrl|videoUrl)\s*[:=]\s*['"]([^'"]+\.(?:m3u8|mp4)(?:\?[^'"]*)?)['"]/i
        )
        playUrl = match && match[1] ? match[1] : ''
    }
    return absoluteUrl(playUrl, getOrigin(pageUrl))
}

/**
 * 加载详情页并生成播放线路。
 */
async function getTracks(ext) {
    ext = argsify(ext)
    try {
        const response = await requestHtml(ext.url, '/video/list')
        const playUrl = extractPlayUrl(response.data, response.url)
        if (!playUrl) throw new Error('详情页没有找到 m3u8 或 mp4 地址')

        return jsonify({
            list: [
                {
                    title: '默认分组',
                    tracks: [
                        {
                            name: '播放',
                            pan: '',
                            ext: {
                                url: playUrl,
                                referer: response.url,
                            },
                        },
                    ],
                },
            ],
        })
    } catch (error) {
        $print(`有爱爱播放解析失败：${error}`)
        return jsonify({ list: [] })
    }
}

/**
 * 返回播放器需要的媒体地址和来源请求头。
 */
async function getPlayinfo(ext) {
    ext = argsify(ext)
    return jsonify({
        urls: [ext.url],
        headers: [
            {
                'User-Agent': UA,
                Referer: ext.referer || `${activeSite}/`,
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
    const page = Number(ext.page || 1)
    const path = `/video/list?searchType=1&keyword=${text}&category=&origin=&tag=&sort=0&page=${page}`

    try {
        const response = await requestHtml(path, '/video/list')
        return jsonify({ list: parseCards(response.data, response.url) })
    } catch (error) {
        $print(`有爱爱搜索请求失败：${error}`)
        return jsonify({ list: [] })
    }
}
