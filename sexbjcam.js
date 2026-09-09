const cheerio = createCheerio()

const UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'

const appConfig = {
    ver: 2026090905,
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
 * 从播放器代码提取 HLS 地址，并优先选择可直接读取标准 TS 分片的线路。
 *
 * @param {string} html 播放器 HTML
 * @param {string} playerUrl 播放器页面地址
 * @return {Array<string>} 可用的 M3U8 地址
 */
function extractMediaUrls(html, playerUrl) {
    const unpacked = unpackPacker(html)
    const source = `${unpacked}\n${html}`
    const urls = []

    // hls4 的清单会把分片转到部分网络无法连接的 TikTok CDN；
    // hls2 使用标准 m3u8 + TS，最适合 XPTV，hls3 作为次选，最后才保留 hls4。
    ;['hls2', 'hls3', 'hls4'].forEach((name) => {
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
 * 读取 HLS 文本中的第一个有效资源地址。
 *
 * @param {string} playlist HLS 清单文本
 * @param {string} playlistUrl 当前清单地址
 * @return {string} 子清单或分片的完整地址
 */
function firstPlaylistResource(playlist, playlistUrl) {
    const line = String(playlist || '')
        .split(/\r?\n/)
        .map((item) => item.trim())
        .find((item) => item && !item.startsWith('#'))
    return line ? absoluteUrl(line, playlistUrl) : ''
}

/**
 * 在 XPTV 当前网络中逐级探测主清单、子清单和首个视频分片。
 *
 * @param {string} url 主清单地址
 * @return {Promise<boolean>} 当前线路是否能读取视频数据
 */
async function probeHls(url) {
    try {
        const requestHeaders = { 'User-Agent': UA }
        const master = await requestHtml(url, '')
        if (!/#EXTM3U/i.test(master)) return false

        const childUrl = firstPlaylistResource(master, url)
        if (!childUrl) return false
        const child = await requestHtml(childUrl, '')
        if (!/#EXTM3U/i.test(child)) return false

        const segmentUrl = firstPlaylistResource(child, childUrl)
        if (!segmentUrl) return false

        // 只读取首个分片的前 1KB，验证手机网络可用性，避免预检下载整个视频分片。
        const response = await $fetch.get(segmentUrl, {
            headers: {
                ...requestHeaders,
                Range: 'bytes=0-1023',
            },
            responseType: 'arraybuffer',
            timeout: 10000,
        })
        const data = response && response.data
        if (data == null) return false
        if (typeof data === 'string') return data.length > 0
        if (typeof data.byteLength === 'number') return data.byteLength > 0
        if (typeof data.length === 'number') return data.length > 0
        return true
    } catch (_) {
        return false
    }
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

        // 优先信任已经解析出的播放器，正常详情页可能包含 Cloudflare 的通用组件代码。
        if (!playerUrl && isChallengePage(html)) throw new Error('SexBJCam 返回了 Cloudflare 详情验证页')
        if (!playerUrl) throw new Error('详情页没有找到播放器 iframe')
        $utils.toastError('运行轨迹 stage=getTracks detail=playerReady')

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
 * 播放时即时解包播放器，只返回最适合 XPTV 的 HLS 线路。
 */
async function getPlayinfo(ext) {
    ext = argsify(ext)
    const playerUrl = absoluteUrl(ext.playerUrl || ext.url || '')
    const detailUrl = absoluteUrl(ext.detailUrl || `${appConfig.site}/`)
    $utils.toastError('运行轨迹 stage=getPlayinfo detail=start')

    try {
        const html = await requestHtml(playerUrl, detailUrl)
        $utils.toastError(`运行轨迹 stage=playerHtml detail=${html.length}`)
        const mediaUrls = extractMediaUrls(html, playerUrl)
        if (mediaUrls.length === 0) throw new Error('播放器未解析到 M3U8 地址')
        $utils.toastError(`运行轨迹 stage=mediaUrls detail=${mediaUrls.length}`)

        let playUrl = ''
        const probeResults = []
        // 必须在 XPTV 所在手机上探测，桌面端和手机代理规则可能选择不同的可用 CDN。
        for (let index = 0; index < mediaUrls.length; index += 1) {
            const candidate = mediaUrls[index]
            const available = await probeHls(candidate)
            probeResults.push(`${index + 1}:${available ? 'ok' : 'fail'}`)
            $utils.toastError(`运行轨迹 stage=probe detail=${probeResults.join(',')}`)
            if (available) {
                playUrl = candidate
                break
            }
        }
        if (!playUrl) throw new Error(`三条 HLS 线路的分片都不可用（${probeResults.join(',')}）`)

        // 调试版本临时显示手机端检测结果，用于区分脚本请求与原生播放器的网络差异。
        $utils.toastError(`播放线路检测 ${probeResults.join(',')}（1=hls2 2=hls3 3=hls4）`)

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
