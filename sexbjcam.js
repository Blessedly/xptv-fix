const cheerio = createCheerio()

const UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'

const appConfig = {
    ver: 2026090901,
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
    const { data } = await $fetch.get(url, {
        headers: {
            ...htmlHeaders,
            Referer: referer,
        },
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
    return /Just a moment|cf-chl-|challenge-platform|Enable JavaScript and cookies/i.test(value)
}

/**
 * 在 XPTV 界面展示可见错误，同时保留异常供调用方终止流程。
 *
 * @param {string} message 错误信息
 */
function showError(message) {
    const text = String(message || '未知错误')
    try {
        if (typeof $utils !== 'undefined' && $utils.toastError) $utils.toastError(text)
    } catch (_) {}
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
 * 从播放器代码提取 HLS 地址，并按播放器默认优先级排序。
 *
 * @param {string} html 播放器 HTML
 * @param {string} playerUrl 播放器页面地址
 * @return {Array<string>} 可用的 M3U8 地址
 */
function extractMediaUrls(html, playerUrl) {
    const unpacked = unpackPacker(html)
    const source = `${unpacked}\n${html}`
    const urls = []

    // recordplay 默认依次使用 hls4、hls3、hls2，保留后两条作为备用线路。
    ;['hls4', 'hls3', 'hls2'].forEach((name) => {
        const match = source.match(new RegExp(`["']${name}["']\\s*:\\s*["']([^"']+)["']`, 'i'))
        if (!match) return
        const url = absoluteUrl(match[1].replace(/\\\//g, '/'), playerUrl)
        if (url && !urls.includes(url)) urls.push(url)
    })

    if (urls.length === 0) {
        const fileMatch = source.match(/(?:file|src)\s*:\s*["']([^"']+(?:\.m3u8|\/master\.txt)[^"']*)["']/i)
        if (fileMatch) urls.push(absoluteUrl(fileMatch[1].replace(/\\\//g, '/'), playerUrl))
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
        if (isChallengePage(html)) throw new Error('SexBJCam 被 Cloudflare 拦截，请检查代理后重试')

        const cards = parseCards(html)
        if (cards.length === 0) throw new Error('SexBJCam 列表为空，页面结构可能已变化')
        return jsonify({ list: cards })
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
        if (isChallengePage(html)) throw new Error('SexBJCam 详情页被 Cloudflare 拦截')

        const $ = cheerio.load(html)
        let playerUrl =
            $('iframe[src*="recordplay"], iframe[data-src*="recordplay"], iframe[src], iframe[data-src]')
                .first()
                .attr('src') ||
            $('iframe[src*="recordplay"], iframe[data-src*="recordplay"], iframe[src], iframe[data-src]')
                .first()
                .attr('data-src') ||
            ''
        playerUrl = absoluteUrl(playerUrl, detailUrl)
        if (!playerUrl) throw new Error('详情页没有找到播放器 iframe')

        return jsonify({
            list: [
                {
                    title: '默认分组',
                    tracks: [
                        {
                            name: '播放',
                            pan: '',
                            // 播放时再解析临时地址，避免用户停留详情页后签名过期。
                            ext: { playerUrl, detailUrl },
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
 * 播放时即时解包播放器，返回主线路及备用 HLS 地址。
 */
async function getPlayinfo(ext) {
    ext = argsify(ext)
    const playerUrl = absoluteUrl(ext.playerUrl || ext.url || '')
    const detailUrl = absoluteUrl(ext.detailUrl || `${appConfig.site}/`)

    try {
        const html = await requestHtml(playerUrl, detailUrl)
        const urls = extractMediaUrls(html, playerUrl)
        if (urls.length === 0) throw new Error('播放器未解析到 M3U8 地址')

        const playerOrigin = (playerUrl.match(/^(https?:\/\/[^/]+)/i) || [])[1] || 'https://recordplay.biz'
        const playHeaders = {
            'User-Agent': UA,
            Referer: playerUrl,
            Origin: playerOrigin,
        }
        return jsonify({
            urls,
            type: 'm3u8',
            headers: urls.map(() => playHeaders),
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
        if (isChallengePage(html)) throw new Error('SexBJCam 搜索页被 Cloudflare 拦截')
        return jsonify({ list: parseCards(html) })
    } catch (error) {
        showError(String(error))
        throw error
    }
}
