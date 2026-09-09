const cheerio = createCheerio()

const UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'

const appConfig = {
    ver: 2026090916,
    title: 'SexBJCam-修改',
    site: 'https://sexbjcam.com',
    tabs: [
        {
            name: 'Korean BJ',
            ui: 1,
            ext: { url: 'https://sexbjcam.com/category/korean-bj/' },
        },
        {
            name: 'Chinese Girl',
            ui: 1,
            // 源站分类路径使用了 gril 的拼写，不能改成 girl。
            ext: { url: 'https://sexbjcam.com/category/chinese-gril/' },
        },
    ],
}

const htmlHeaders = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
}

/**
 * 将相对地址转换为完整地址。
 *
 * @param {string} url 原始地址
 * @param {string} baseUrl 地址所属页面
 * @return {string} 完整地址
 */
function absoluteUrl(url, baseUrl = `${appConfig.site}/`) {
    const value = String(url || '')
        .trim()
        .replace(/&amp;/g, '&')
    if (!value) return ''
    if (/^https?:\/\//i.test(value)) return value
    if (value.startsWith('//')) return `https:${value}`

    const originMatch = String(baseUrl).match(/^(https?:\/\/[^/]+)/i)
    const origin = originMatch ? originMatch[1] : appConfig.site
    if (value.startsWith('/')) return `${origin}${value}`

    const directory = String(baseUrl).replace(/[?#].*$/, '').replace(/\/[^/]*$/, '/')
    return `${directory}${value}`
}

/**
 * 统一请求 HTML，确保详情页和播放器收到正确的防盗链来源。
 *
 * @param {string} url 请求地址
 * @param {string} referer 来源页面
 * @return {Promise<string>} HTML 文本
 */
async function requestHtml(url, referer = `${appConfig.site}/`) {
    const requestHeaders = { ...htmlHeaders }
    if (referer) requestHeaders.Referer = referer

    const { data } = await $fetch.get(url, {
        headers: requestHeaders,
        timeout: 15000,
    })
    return typeof data === 'string' ? data : String(data || '')
}

/**
 * 判断响应是否为 Cloudflare 验证页面。
 *
 * @param {string} html 响应内容
 * @return {boolean} 是否被验证页拦截
 */
function isChallengePage(html) {
    const value = String(html || '')
    const challengeTitle = /<title[^>]*>\s*Just a moment(?:\.\.\.)?\s*<\/title>/i.test(value)
    const challengeMessage = /Enable JavaScript and cookies to continue/i.test(value)
    const managedChallenge = /id=["']challenge-form["']/i.test(value) && /window\._cf_chl_opt/i.test(value)

    // 正常页面也可能引用 challenge-platform 或 Turnstile，不能仅凭脚本地址判断为拦截页。
    return challengeTitle || challengeMessage || managedChallenge
}

/**
 * 在 XPTV 界面展示可见错误，同时保留异常供调用方终止流程。
 *
 * @param {string} message 错误信息
 */
function showError(message) {
    // XPTV 对直接调用支持最稳定，不再用兼容判断吞掉提示异常。
    $utils.toastError(String(message || '未知错误'))
}

/**
 * 从列表页解析视频卡片，兼容源站常见的 WordPress 视频主题结构。
 *
 * @param {string} html 列表页 HTML
 * @return {Array<object>} XPTV 视频卡片
 */
function parseCards(html) {
    const cards = []
    const seen = {}
    const $ = cheerio.load(html)

    $('article').each((_, element) => {
        const item = $(element)
        const link = item
            .find('h1 a[href], h2 a[href], h3 a[href], .entry-title a[href], .title a[href], a[href]')
            .first()
        const href = absoluteUrl(link.attr('href') || '')
        if (!href || !/^https?:\/\/[^/]*sexbjcam\.com\/\d{4}\/\d{2}\/\d{2}\//i.test(href) || seen[href]) return

        const image = item.find('img[data-src], img[data-lazy-src], img[src]').first()
        const title =
            link.attr('title') ||
            link.text().trim() ||
            item.find('h1, h2, h3, .entry-title, .title').first().text().trim() ||
            image.attr('alt') ||
            '未命名视频'
        const cover =
            image.attr('data-src') ||
            image.attr('data-lazy-src') ||
            image.attr('data-original') ||
            image.attr('src') ||
            ''
        const duration = item
            .find('.duration, .video-duration, .time, [class*="duration"]')
            .first()
            .text()
            .trim()

        seen[href] = true
        cards.push({
            vod_id: href,
            vod_name: title,
            vod_pic: absoluteUrl(cover, href),
            vod_remarks: duration,
            vod_duration: duration,
            ext: { url: href },
        })
    })

    return cards
}

/**
 * 从详情页 iframe 中提取真正的 recordplay 地址。
 *
 * @param {string} html 详情页 HTML
 * @param {string} detailUrl 详情页地址
 * @return {string} 播放器完整地址
 */
function extractPlayerUrl(html, detailUrl) {
    const $ = cheerio.load(html)
    const attributes = ['data-link', 'data-src', 'src']
    let playerUrl = ''

    $('iframe').each((_, element) => {
        if (playerUrl) return
        const iframe = $(element)
        for (const attribute of attributes) {
            const value = String(iframe.attr(attribute) || '').trim()
            if (!value || /^javascript:/i.test(value)) continue

            const candidate = absoluteUrl(value, detailUrl)
            if (
                /^https?:\/\/(?:www\.)?recordplay\.biz\/e\//i.test(candidate) ||
                /^https?:\/\/(?:www\.)?playrecord\.biz\/embed\//i.test(candidate)
            ) {
                playerUrl = candidate
                break
            }
        }
    })

    // 部分懒加载插件会把属性保留在原始 HTML 中，使用正则作为最后兜底。
    if (!playerUrl) {
        const match = String(html || '').match(
            /(?:data-link|data-src|src)=["']((?:https?:)?\/\/(?:www\.)?(?:recordplay\.biz\/e|playrecord\.biz\/embed)\/[^"']+)["']/i
        )
        if (match) playerUrl = absoluteUrl(match[1], detailUrl)
    }

    // 再从整页脚本或内联 JSON 中寻找地址，兼容播放器不直接写在 iframe 属性中的情况。
    if (!playerUrl) {
        const normalizedHtml = String(html || '')
            .replace(/\\\//g, '/')
            .replace(/&amp;/g, '&')
            .replace(/&#0*38;/gi, '&')
        const match = normalizedHtml.match(
            /https?:\/\/(?:www\.)?(?:recordplay\.biz\/e|playrecord\.biz\/embed)\/[a-z0-9_-]+(?:\?[^\s"'<>]*)?/i
        )
        if (match) playerUrl = match[0]
    }
    return playerUrl
}

/**
 * 解码 P.A.C.K.E.R. 参数中的 JavaScript 单引号字符串。
 *
 * @param {string} value 编码字符串
 * @return {string} 解码后的文本
 */
function decodePackedString(value) {
    return String(value || '').replace(/\\(['\\])/g, '$1').replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
}

/**
 * 解开 recordplay 播放器使用的 Dean Edwards P.A.C.K.E.R. 代码。
 *
 * @param {string} source 播放器 HTML 或脚本
 * @return {string} 解包后的播放器代码
 */
function unpackPacker(source) {
    const text = String(source || '')
    const args = text.match(
        /\}\('((?:\\.|[^'])*)',(\d+),(\d+),'((?:\\.|[^'])*)'\.split\('\|'\)\)\)/
    )
    if (!args) return ''

    let payload = decodePackedString(args[1])
    const radix = Number(args[2])
    const count = Number(args[3])
    const dictionary = decodePackedString(args[4]).split('|')

    // 按原始 P.A.C.K.E.R. 算法倒序替换关键字，避免使用可能被 XPTV 禁止的 eval。
    for (let index = count - 1; index >= 0; index -= 1) {
        if (!dictionary[index]) continue
        const key = index.toString(radix)
        payload = payload.replace(new RegExp(`\\b${key}\\b`, 'g'), dictionary[index])
    }
    return payload
}

/**
 * 从播放器代码提取各条 HLS 线路，供播放页按名称选择。
 *
 * @param {string} html 播放器 HTML
 * @param {string} playerUrl 播放器页面地址
 * @return {object} 以 hls2、hls3、hls4 命名的 M3U8 地址
 */
function extractMediaUrls(html, playerUrl) {
    const unpacked = unpackPacker(html)
    const source = `${unpacked}\n${html}`
    const urls = {}

    // 保留线路名称，便于用户根据当前网络手动选择最快的 CDN。
    ;['hls2', 'hls3', 'hls4'].forEach((name) => {
        const match = source.match(new RegExp(`["']${name}["']\\s*:\\s*["']([^"']+)["']`, 'i'))
        if (!match) return
        const url = absoluteUrl(match[1].replace(/\\\//g, '/'), playerUrl)
        if (url) urls[name] = url
    })

    if (Object.keys(urls).length === 0) {
        const fileMatch = source.match(/(?:file|src)\s*:\s*["']([^"']+(?:\.m3u8|\/master\.txt)[^"']*)["']/i)
        if (fileMatch) urls.default = absoluteUrl(fileMatch[1].replace(/\\\//g, '/'), playerUrl)
    }
    return urls
}

/**
 * 返回扩展配置。
 */
async function getConfig() {
    return jsonify(appConfig)
}

/**
 * 获取 Korean BJ 或 Chinese Girl 分类列表。
 */
async function getCards(ext) {
    ext = argsify(ext)
    const page = Number(ext.page || 1)
    const baseUrl = ext.url || appConfig.tabs[0].ext.url
    const url = page > 1 ? `${baseUrl.replace(/\/$/, '')}/page/${page}/` : baseUrl

    try {
        const html = await requestHtml(url)
        const cards = parseCards(html)
        // 页面能解析出卡片时直接成功，避免正常页面中的 Cloudflare 组件造成误判。
        if (cards.length > 0) return jsonify({ list: cards })

        if (isChallengePage(html)) throw new Error('SexBJCam 返回了 Cloudflare 验证页，请检查代理后重试')
        if (cards.length === 0) throw new Error('SexBJCam 列表为空，页面结构可能已变化')
        return jsonify({ list: [] })
    } catch (error) {
        showError(String(error))
        throw error
    }
}

/**
 * 从视频详情页取得 recordplay 播放器线路。
 */
async function getTracks(ext) {
    ext = argsify(ext)
    const detailUrl = absoluteUrl(ext.url || '')

    try {
        const html = await requestHtml(detailUrl)
        const playerUrl = extractPlayerUrl(html, detailUrl)

        // 优先信任已经解析出的播放器，正常详情页可能包含 Cloudflare 的通用组件代码。
        if (!playerUrl && isChallengePage(html)) throw new Error('SexBJCam 返回了 Cloudflare 详情验证页')
        if (!playerUrl) throw new Error('详情页没有找到播放器 iframe')

        return jsonify({
            list: [
                {
                    title: '默认分组',
                    tracks: [
                        {
                            name: '高速线路',
                            pan: '',
                            // hls4 使用网页播放器常用的媒体 CDN，优先用于速度测试。
                            ext: { playerUrl, detailUrl, line: 'hls4' },
                        },
                        {
                            name: '兼容线路',
                            pan: '',
                            // hls2 使用标准 M3U8 与 TS 分片，兼容性更好但部分网络较慢。
                            ext: { playerUrl, detailUrl, line: 'hls2' },
                        },
                    ],
                },
            ],
        })
    } catch (error) {
        showError(String(error))
        throw error
    }
}

/**
 * 播放时即时解包播放器，只返回最适合 XPTV 的 HLS 线路。
 */
async function getPlayinfo(ext) {
    ext = argsify(ext)
    const playerUrl = absoluteUrl(ext.playerUrl || ext.url || '')
    const detailUrl = absoluteUrl(ext.detailUrl || `${appConfig.site}/`)
    const preferredLine = String(ext.line || 'hls4')

    try {
        // 播放器必须由手机直取，使临时 HLS 签名与原生播放器使用相同的网络出口。
        const html = await requestHtml(playerUrl, detailUrl)
        const mediaUrls = extractMediaUrls(html, playerUrl)
        const playUrl =
            mediaUrls[preferredLine] || mediaUrls.hls4 || mediaUrls.hls2 || mediaUrls.default || ''
        if (!playUrl) throw new Error('播放器未解析到 M3U8 地址')

        return jsonify({
            urls: [playUrl],
            type: 'm3u8',
            // CDN 地址已经包含签名，不需要 Referer/Origin，避免原生播放器对子请求头处理不一致。
            headers: [{ 'User-Agent': UA }],
        })
    } catch (error) {
        showError(String(error))
        throw error
    }
}

/**
 * 使用 WordPress 搜索页查找视频。
 */
async function search(ext) {
    ext = argsify(ext)
    const keyword = encodeURIComponent(ext.text || ext.keyword || '')
    const page = Number(ext.page || 1)
    const url = `${appConfig.site}/page/${page}/?s=${keyword}`

    try {
        const html = await requestHtml(url)
        const cards = parseCards(html)
        if (cards.length > 0) return jsonify({ list: cards })
        if (isChallengePage(html)) throw new Error('SexBJCam 返回了 Cloudflare 搜索验证页')
        return jsonify({ list: [] })
    } catch (error) {
        showError(String(error))
        throw error
    }
}
