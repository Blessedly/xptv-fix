const cheerio = createCheerio()

const UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'

const appConfig = {
    ver: 2026091008,
    title: '123AV-修改',
    site: 'https://123av.com',
    tabs: [
        { name: '热门', ui: 1, ext: { url: 'https://123av.com/cn/hot' } },
        { name: '最新', ui: 1, ext: { url: 'https://123av.com/cn/new' } },
        { name: '最近', ui: 1, ext: { url: 'https://123av.com/cn/recent' } },
        { name: '有码', ui: 1, ext: { url: 'https://123av.com/cn/censored' } },
        { name: '无码', ui: 1, ext: { url: 'https://123av.com/cn/uncensored' } },
    ],
}

// 正式脚本保持空值；本地诊断服务只在返回脚本时注入日志接收地址，网站请求仍由手机直连。
const DEBUG_LOGGER = ''
// 本地诊断服务可临时注入媒体代理；正式版本保持直连，避免 Cloudflare 出口被媒体 CDN 封禁。
const MEDIA_PROXY = ''

const htmlHeaders = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const DATA_URL_KEY = 'G9zhUyphqPWZGWzZ'
const SURRIT_KEY = 'ym1eS4t0jTLakZYQ'
const SURRIT_SITE = 'https://surrit.store'

/**
 * 返回 XPTV 扩展配置。
 *
 * @return {string} 序列化后的扩展配置
 */
async function getConfig() {
    return jsonify(appConfig)
}

/**
 * 返回固定分类入口。
 *
 * @return {Array<object>} 分类列表
 */
async function getTabs() {
    return appConfig.tabs
}

/**
 * 将站内相对地址转换成完整地址。
 *
 * @param {string} url 原始地址
 * @param {string} baseUrl 地址所属页面
 * @return {string} 完整地址
 */
function absoluteUrl(url, baseUrl = `${appConfig.site}/`) {
    const value = String(url || '')
        .trim()
        .replace(/&amp;/gi, '&')
    if (!value || /^(?:javascript|data):/i.test(value)) return ''
    if (/^https?:\/\//i.test(value)) return value
    if (value.startsWith('//')) return `https:${value}`

    const originMatch = String(baseUrl).match(/^(https?:\/\/[^/]+)/i)
    const origin = originMatch ? originMatch[1] : appConfig.site
    if (value.startsWith('/')) return `${origin}${value}`

    const directory = String(baseUrl).replace(/[?#].*$/, '').replace(/\/[^/]*$/, '/')
    return `${directory}${value}`
}

/**
 * 清理页面文本中的多余空白。
 *
 * @param {string} value 原始文本
 * @return {string} 清理后的文本
 */
function cleanText(value) {
    return String(value || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

/**
 * 把异常对象转换成可读文本，避免 XPTV 只显示 [object Object]。
 *
 * @param {*} error 捕获到的异常
 * @return {string} 可展示的错误信息
 */
function formatError(error) {
    if (typeof error === 'string') return error
    if (!error) return '未知错误'

    const detail = {}
    ;['message', 'name', 'status', 'statusCode', 'code', 'url', 'data'].forEach((key) => {
        if (error[key] === undefined || error[key] === null) return
        let value
        try {
            value = typeof error[key] === 'string' ? error[key] : JSON.stringify(error[key])
        } catch (_) {
            value = String(error[key])
        }
        if (value === undefined) value = String(error[key])
        detail[key] = value.length > 800 ? `${value.slice(0, 800)}…` : value
    })
    try {
        if (Object.keys(detail).length) return JSON.stringify(detail)
        return JSON.stringify(error)
    } catch (_) {
        return error.message || '无法序列化的请求错误'
    }
}

/**
 * 将手机侧诊断信息发送到电脑，仅传日志而不代理网站请求。
 *
 * @param {string} stage 诊断阶段
 * @param {object} detail 诊断字段
 * @return {Promise<void>}
 */
async function sendDiagnosticLog(stage, detail = {}) {
    if (!DEBUG_LOGGER) return

    try {
        let payload = JSON.stringify(detail)
        if (payload.length > 1800) payload = `${payload.slice(0, 1800)}…`
        const url = `${DEBUG_LOGGER}/event?stage=${encodeURIComponent(stage)}&detail=${encodeURIComponent(payload)}`
        await $fetch.get(url, {
            headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
            timeout: 3000,
        })
    } catch (_) {
        // 日志发送失败不能影响 XPTV 的正常解析和播放。
    }
}

/**
 * 提取 XPTV 不同网络实现可能返回的状态和响应长度。
 *
 * @param {object} response 请求响应
 * @return {object} 简要响应信息
 */
function responseSummary(response) {
    const data = response ? response.data : ''
    const length = typeof data === 'string' ? data.length : data && data.byteLength ? data.byteLength : 0
    return {
        status: response ? response.status || response.statusCode || response.code || '' : '',
        length,
    }
}

/**
 * 判断返回内容是否为 Cloudflare 验证或封禁页。
 *
 * @param {string} html HTML 文本
 * @return {boolean} 是否被 Cloudflare 拦截
 */
function isChallengePage(html) {
    const value = String(html || '')
    return (
        /<title[^>]*>\s*(?:Just a moment|Attention Required!)/i.test(value) ||
        /Sorry, you have been blocked/i.test(value) ||
        (/id=["']challenge-form["']/i.test(value) && /_cf_chl_opt/i.test(value))
    )
}

/**
 * 请求 HTML，并在收到验证页时给出明确错误。
 *
 * @param {string} url 页面地址
 * @param {string} referer 来源页
 * @param {string} stage 诊断阶段
 * @return {Promise<string>} HTML 文本
 */
async function requestHtml(url, referer = `${appConfig.site}/`, stage = 'html') {
    await sendDiagnosticLog(`${stage}:start`, { url, referer })
    try {
        // 这里始终请求真实站点，由手机网络和 Shadowrocket 决定出口。
        const response = await $fetch.get(url, {
            headers: { ...htmlHeaders, Referer: referer },
            timeout: 15000,
        })
        const html = typeof response.data === 'string' ? response.data : String(response.data || '')
        const challenge = isChallengePage(html)
        await sendDiagnosticLog(`${stage}:response`, {
            url,
            ...responseSummary(response),
            challenge,
            title: cleanText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]),
        })
        if (challenge) throw new Error('123AV 返回 Cloudflare 验证页，请检查手机代理或认证 Cookie')
        return html
    } catch (error) {
        await sendDiagnosticLog(`${stage}:error`, { url, error: formatError(error) })
        throw error
    }
}

/**
 * 从 srcset 中取第一张图片。
 *
 * @param {string} srcset 响应式图片列表
 * @return {string} 第一张图片地址
 */
function firstSrcset(srcset) {
    return String(srcset || '')
        .split(',')[0]
        .trim()
        .split(/\s+/)[0]
}

/**
 * 解析新旧两种列表卡片 DOM。
 *
 * @param {string} html 列表 HTML
 * @param {string} pageUrl 当前列表地址
 * @return {Array<object>} XPTV 卡片列表
 */
function parseCards(html, pageUrl) {
    const $ = cheerio.load(String(html || ''))
    const cards = []
    const seen = {}
    const selectors = '.card, .vid-items > div.item, .video-card, article'

    $(selectors).each((_, element) => {
        const item = $(element)
        // 不能把标题与封面选择器写在同一个逗号列表后直接 first()：Cheerio 会按 DOM 顺序返回封面链接。
        let link = item.find('.card__title .card__link[href]').first()
        if (!link.length) link = item.find('.title a[href]').first()
        if (!link.length) link = item.find('a[href*="/video/"], a[href*="/v/"]').first()
        if (!link.length) link = item.find('a[href]').first()
        const href = absoluteUrl(link.attr('href'), pageUrl)
        if (!href || !/^https?:\/\/(?:www\.)?123av\.com\//i.test(href) || seen[href]) return

        // 排除分类、搜索和导航链接，避免把页面菜单误识别成影片。
        if (/\/(?:cn|en|ja)\/(?:hot|new|recent|censored|uncensored|search)\/?(?:[?#]|$)/i.test(href)) return

        const image = item
            .find('.card__image img, .card__cover img, .image img, img[data-src], img[data-lazy-src], img[src]')
            .first()
        const title = cleanText(
            link.attr('title') ||
                link.text() ||
                item.find('.card__title, .title, h2, h3').first().text() ||
                image.attr('alt'),
        )
        const cover = absoluteUrl(
                image.attr('data-src') ||
                image.attr('data-lazy-src') ||
                image.attr('data-original') ||
                firstSrcset(image.attr('srcset')) ||
                image.attr('src'),
            pageUrl,
        )
        let duration = cleanText(
            item.find('.card__dur, .card__duration, .duration, .video-duration, [class*="duration"]').first().text(),
        )
        // 新站列表暂时统一输出 0:00，这是未计算时长的占位值，不能作为卡片标题或备注展示。
        if (/^0:00$/.test(duration)) duration = ''
        if (!title || !cover) return

        seen[href] = true
        cards.push({
            vod_id: href,
            vod_name: title,
            vod_pic: cover,
            vod_duration: duration,
            vod_remarks: duration,
            ext: { url: href },
        })
    })

    return cards
}

/**
 * 读取分类影片列表。
 *
 * @param {object|string} ext XPTV 扩展参数
 * @return {string} 序列化后的列表
 */
async function getCards(ext) {
    ext = argsify(ext)
    const page = Number(ext.page || 1)
    let url = absoluteUrl(ext.url || appConfig.tabs[0].ext.url)
    if (page > 1) url += `${url.includes('?') ? '&' : '?'}page=${page}`

    try {
        const html = await requestHtml(url, `${appConfig.site}/cn/`, 'list')
        const list = parseCards(html, url)
        await sendDiagnosticLog('list:parsed', {
            count: list.length,
            firstTitle: list.length ? list[0].vod_name : '',
            firstUrl: list.length ? list[0].vod_id : '',
        })
        if (!list.length) throw new Error('123AV 列表 DOM 未匹配，请反馈“列表 DOM 未匹配”')
        return jsonify({ list })
    } catch (error) {
        await sendDiagnosticLog('list:error', { url, error: formatError(error) })
        $utils.toastError(formatError(error))
        return jsonify({ list: [] })
    }
}

/**
 * Base64 解码为二进制字符串，避免依赖原生加密随机数模块。
 *
 * @param {string} input Base64 文本
 * @return {string} 二进制字符串
 */
function base64Decode(input) {
    const value = String(input || '').replace(/[^A-Za-z0-9+/=]/g, '')
    let output = ''
    for (let index = 0; index < value.length; index += 4) {
        const a = BASE64_ALPHABET.indexOf(value[index])
        const b = BASE64_ALPHABET.indexOf(value[index + 1])
        const c = value[index + 2] === '=' || !value[index + 2] ? -1 : BASE64_ALPHABET.indexOf(value[index + 2])
        const d = value[index + 3] === '=' || !value[index + 3] ? -1 : BASE64_ALPHABET.indexOf(value[index + 3])
        if (a < 0 || b < 0) continue

        output += String.fromCharCode((a << 2) | (b >> 4))
        if (c >= 0) output += String.fromCharCode(((b & 15) << 4) | (c >> 2))
        if (d >= 0) output += String.fromCharCode(((c & 3) << 6) | d)
    }
    return output
}

/**
 * 将字节数组编码成 Base64。
 *
 * @param {Array<number>} bytes 字节数组
 * @return {string} Base64 文本
 */
function base64Encode(bytes) {
    let output = ''
    for (let index = 0; index < bytes.length; index += 3) {
        const a = bytes[index]
        const hasB = index + 1 < bytes.length
        const hasC = index + 2 < bytes.length
        const b = hasB ? bytes[index + 1] : 0
        const c = hasC ? bytes[index + 2] : 0

        output += BASE64_ALPHABET[a >> 2]
        output += BASE64_ALPHABET[((a & 3) << 4) | (b >> 4)]
        output += hasB ? BASE64_ALPHABET[((b & 15) << 2) | (c >> 6)] : '='
        output += hasC ? BASE64_ALPHABET[c & 63] : '='
    }
    return output
}

/**
 * 使用站点固定密钥解码异或加密文本。
 *
 * @param {string} value Base64 密文
 * @param {string} key 异或密钥
 * @return {string} 解密后的文本
 */
function xorDecode(value, key) {
    const source = base64Decode(value)
    let output = ''
    for (let index = 0; index < source.length; index++) {
        output += String.fromCharCode(source.charCodeAt(index) ^ key.charCodeAt(index % key.length))
    }

    try {
        return decodeURIComponent(output)
    } catch (_) {
        return output
    }
}

/**
 * 使用站点固定密钥生成 surrit.store 查询令牌。
 *
 * @param {string} value 视频文件标识
 * @return {string} Base64 令牌
 */
function xorEncode(value) {
    const bytes = []
    for (let index = 0; index < value.length; index++) {
        bytes.push(value.charCodeAt(index) ^ SURRIT_KEY.charCodeAt(index % SURRIT_KEY.length))
    }
    return base64Encode(bytes)
}

/**
 * 清理页面脚本中的转义媒体地址。
 *
 * @param {string} value 原始媒体地址
 * @param {string} baseUrl 地址所属页面
 * @return {string} 可请求的媒体地址
 */
function normalizeMediaUrl(value, baseUrl) {
    return absoluteUrl(
        String(value || '')
            .replace(/\\u0026/gi, '&')
            .replace(/\\\//g, '/')
            .replace(/&amp;/gi, '&'),
        baseUrl,
    )
}

/**
 * 为 HLS 地址增加单次播放标识，避免原生播放器复用网络中断后的失败缓存。
 *
 * @param {string} playUrl 原始播放地址
 * @return {string} 带单次播放标识的地址
 */
function freshPlaybackUrl(playUrl) {
    if (!/\.m3u8(?:[?#]|$)/i.test(playUrl)) return playUrl
    const separator = playUrl.includes('?') ? '&' : '?'
    return `${playUrl}${separator}_xptv=${Date.now()}`
}

/**
 * 调试时把媒体交给本地兼容代理，正式脚本未配置代理时保持直连。
 *
 * @param {string} playUrl 原始媒体地址
 * @param {string} referer 播放器来源页
 * @return {string} 实际播放地址
 */
function compatiblePlaybackUrl(playUrl, referer) {
    if (!MEDIA_PROXY || !/\/blah4\//i.test(playUrl)) return playUrl
    return `${MEDIA_PROXY}/media?url=${encodeURIComponent(playUrl)}&referer=${encodeURIComponent(referer)}`
}

/**
 * 从 video、source 或内联脚本中提取直链媒体。
 *
 * @param {string} html 播放页 HTML
 * @param {string} baseUrl 播放页地址
 * @return {string} MP4 或 M3U8 地址
 */
function extractDirectMedia(html, baseUrl) {
    const source = String(html || '')
    const $ = cheerio.load(source)
    let mediaUrl = ''

    $('video[src], video source[src], source[src], [data-video], [data-file]').each((_, element) => {
        if (mediaUrl) return
        const item = $(element)
        const candidate = normalizeMediaUrl(
            item.attr('src') || item.attr('data-video') || item.attr('data-file'),
            baseUrl,
        )
        if (/\.(?:m3u8|mp4)(?:[?#]|$)/i.test(candidate)) mediaUrl = candidate
    })
    if (mediaUrl) return mediaUrl

    const match = source.match(
        /(?:file|src|source|video_url|videoUrl|hlsUrl)\s*[:=]\s*["']([^"']+\.(?:m3u8|mp4)(?:\?[^"']*)?)["']/i,
    )
    return match ? normalizeMediaUrl(match[1], baseUrl) : ''
}

/**
 * 解码详情页 player(JSON.parse('...')) 中嵌套的 JavaScript 字符串。
 *
 * @param {string} value JavaScript 字符串内容
 * @return {string} 可交给 JSON.parse 的 JSON 文本
 */
function decodePlayerJson(value) {
    const source = String(value || '')

    try {
        // 外层 JSON.parse 负责还原 \u0022 与双重斜杠，结果才是实际的线路 JSON。
        return JSON.parse(`"${source.replace(/"/g, '\\"')}"`)
    } catch (_) {
        // 保留手工解码回退，兼容站点偶尔输出未双重转义的内容。
        return source
            .replace(/\\u([0-9a-f]{4})/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
            .replace(/\\\//g, '/')
    }
}

/**
 * 从新版详情页提取全部 javplayer.cc 播放线路。
 *
 * @param {string} html 详情页 HTML
 * @return {Array<object>} 播放线路
 */
function extractPlayerEpisodes(html) {
    const source = String(html || '')
    const match = source.match(/player\s*\(\s*JSON\.parse\(\s*'((?:\\.|[^'])*)'\s*\)/i)
    if (!match) return []

    try {
        const episodes = JSON.parse(decodePlayerJson(match[1]))
        if (!Array.isArray(episodes)) return []

        return episodes
            .map((episode, index) => ({
                name: cleanText(episode.name) || `线路${index + 1}`,
                url: normalizeMediaUrl(episode.url, appConfig.site),
            }))
            .filter((episode) => /^https?:\/\/(?:www\.)?javplayer\.cc\//i.test(episode.url))
    } catch (error) {
        $print(`123AV 播放线路 JSON 解析失败：${error}`)
        return []
    }
}

/**
 * 调用新版 javplayer.cc stream 接口取得真实媒体地址。
 *
 * @param {string} playerUrl javplayer.cc 嵌入页地址
 * @return {Promise<object>} 播放地址、字幕和防盗链来源
 */
async function resolveJavPlayer(playerUrl) {
    const idMatch = String(playerUrl).match(/\/e\/([a-z0-9_]+)/i)
    const originMatch = String(playerUrl).match(/^(https?:\/\/[^/]+)/i)
    if (!idMatch || !originMatch) throw new Error('javplayer.cc 播放地址格式无效')

    const origin = originMatch[1]
    const queryIndex = playerUrl.indexOf('?')
    const oldQuery = queryIndex >= 0 ? playerUrl.slice(queryIndex + 1) : ''
    const streamUrl = `${origin}/stream?${oldQuery ? `${oldQuery}&` : ''}id=${encodeURIComponent(idMatch[1])}`
    await sendDiagnosticLog('stream-api:start', { playerUrl, streamUrl, id: idMatch[1] })
    try {
        const response = await $fetch.get(streamUrl, {
            headers: {
                'User-Agent': UA,
                Accept: 'application/json',
                Referer: playerUrl,
                Origin: origin,
                'Cache-Control': 'no-cache',
                Pragma: 'no-cache',
            },
            timeout: 15000,
        })
        const payload = typeof response.data === 'string' ? JSON.parse(response.data) : response.data
        const media = payload && payload.media ? payload.media : null
        const playUrl = media ? normalizeMediaUrl(media.stream, origin) : ''
        await sendDiagnosticLog('stream-api:response', {
            ...responseSummary(response),
            apiStatus: payload && payload.status ? payload.status : '',
            hasMedia: Boolean(playUrl),
            mediaUrl: playUrl,
        })
        if (!playUrl) throw new Error('javplayer.cc stream 接口未返回媒体地址')

        return {
            playUrl,
            subtitle: normalizeMediaUrl(media.vtt, origin),
            referer: playerUrl,
        }
    } catch (error) {
        await sendDiagnosticLog('stream-api:error', { streamUrl, error: formatError(error) })
        throw error
    }
}

/**
 * 通过原站保留的 surrit.store 加密接口解析一个播放源。
 *
 * @param {string} encryptedUrl data-url 密文
 * @param {string} detailUrl 详情页地址
 * @return {Promise<object>} 播放地址和字幕
 */
async function resolveSurritSource(encryptedUrl, detailUrl) {
    const decodedUrl = xorDecode(encryptedUrl, DATA_URL_KEY)
    const sourceUrl = normalizeMediaUrl(decodedUrl, detailUrl)
    const fileName = sourceUrl.split('/').pop().split('?')[0]
    if (!fileName) throw new Error('123AV 播放源缺少文件标识')

    // 保持原接口的路径令牌格式，不对 Base64 中的字符重复编码。
    const token = xorEncode(fileName)
    const surritUrl = `${SURRIT_SITE}/${token}`
    const response = await $fetch.get(surritUrl, {
        headers: { ...htmlHeaders, Referer: detailUrl, Origin: appConfig.site },
        timeout: 15000,
    })
    const payload = typeof response.data === 'string' ? JSON.parse(response.data) : response.data
    const encryptedMedia = payload && payload.result ? payload.result.media : ''
    if (!encryptedMedia) throw new Error('surrit.store 未返回媒体数据')

    const media = JSON.parse(xorDecode(encryptedMedia, SURRIT_KEY))
    const playUrl = normalizeMediaUrl(media.stream, SURRIT_SITE)
    if (!playUrl) throw new Error('surrit.store 媒体数据缺少 stream')
    return { playUrl, subtitle: normalizeMediaUrl(media.vtt, SURRIT_SITE) }
}

/**
 * 解析详情页中的全部播放源。
 *
 * @param {object|string} ext XPTV 扩展参数
 * @return {string} 序列化后的播放分组
 */
async function getTracks(ext) {
    ext = argsify(ext)
    const detailUrl = absoluteUrl(ext.url)

    try {
        const html = await requestHtml(detailUrl, `${appConfig.site}/cn/`, 'detail')
        const tracks = []
        const directUrl = extractDirectMedia(html, detailUrl)
        if (directUrl) {
            tracks.push({ name: '直连', pan: '', ext: { playUrl: directUrl, referer: detailUrl } })
        }

        const $ = cheerio.load(html)
        const episodes = extractPlayerEpisodes(html)
        await sendDiagnosticLog('detail:parsed', {
            detailUrl,
            episodes: episodes.length,
            firstPlayerUrl: episodes.length ? episodes[0].url : '',
            directMedia: Boolean(directUrl),
        })
        for (let index = 0; index < episodes.length; index++) {
            // 详情阶段只保存播放器入口；真正点击播放时再获取媒体，避免 XPTV 缓存过期 M3U8。
            tracks.push({
                name: episodes[index].name,
                pan: '',
                ext: {
                    playerUrl: episodes[index].url,
                    detailUrl,
                },
            })
        }

        // 保留旧 surrit.store 解密线路作为过渡兼容，只有旧详情页仍存在 data-url 时才会执行。
        const encryptedSources = []
        $('#video-files [data-url], #video-files div[data-url], [data-url]').each((_, element) => {
            const value = String($(element).attr('data-url') || '').trim()
            if (!value || encryptedSources.some((item) => item.value === value)) return
            encryptedSources.push({
                value,
                name: cleanText($(element).attr('data-name') || $(element).text()) || `线路${encryptedSources.length + 1}`,
            })
        })

        for (let index = 0; index < encryptedSources.length; index++) {
            try {
                const result = await resolveSurritSource(encryptedSources[index].value, detailUrl)
                tracks.push({
                    name: encryptedSources[index].name,
                    pan: '',
                    ext: {
                        playUrl: result.playUrl,
                        subtitle: result.subtitle,
                        referer: `${SURRIT_SITE}/`,
                    },
                })
            } catch (error) {
                $print(`123AV 第 ${index + 1} 条加密线路解析失败：${error}`)
            }
        }

        // 部分页面把真实 video 放在同域播放器 iframe 中，再补抓一次 iframe HTML。
        if (!tracks.length) {
            const frameUrl = absoluteUrl($('iframe[src*="player"], iframe[src*="embed"], iframe[src]').first().attr('src'), detailUrl)
            if (frameUrl) {
                const frameHtml = await requestHtml(frameUrl, detailUrl, 'iframe')
                const frameMedia = extractDirectMedia(frameHtml, frameUrl)
                if (frameMedia) tracks.push({ name: '播放器', pan: '', ext: { playUrl: frameMedia, referer: frameUrl } })
            }
        }

        if (!tracks.length) throw new Error('123AV 详情页未找到可用播放器，请反馈“播放器 DOM 未匹配”')
        return jsonify({ list: [{ title: '默认分组', tracks }] })
    } catch (error) {
        await sendDiagnosticLog('detail:error', { detailUrl, error: formatError(error) })
        $utils.toastError(formatError(error))
        return jsonify({ list: [] })
    }
}

/**
 * 返回播放器所需的媒体地址和防盗链请求头。
 *
 * @param {object|string} ext 播放参数
 * @return {string} 序列化后的播放信息
 */
async function getPlayinfo(ext) {
    ext = argsify(ext)
    await sendDiagnosticLog('getPlayinfo:start', {
        hasPlayerUrl: Boolean(ext.playerUrl),
        hasPlayUrl: Boolean(ext.playUrl),
        playerUrl: ext.playerUrl || '',
    })
    try {
        let playUrl = normalizeMediaUrl(ext.playUrl, appConfig.site)
        let referer = ext.referer || (/surrit\.store/i.test(playUrl) ? `${SURRIT_SITE}/` : `${appConfig.site}/`)

        if (ext.playerUrl) {
            // 每次点击播放都重新调用 stream 接口，防止复用已经失效的媒体签名。
            const result = await resolveJavPlayer(normalizeMediaUrl(ext.playerUrl, appConfig.site))
            playUrl = result.playUrl
            referer = result.referer
        }
        if (!playUrl) throw new Error('123AV 缺少播放地址')

        const type = /\.m3u8(?:[?#]|$)/i.test(playUrl) ? 'm3u8' : 'mp4'
        const mediaHeaders = {
            'User-Agent': UA,
            Referer: referer,
            Origin: /^https?:\/\/[^/]+/i.test(referer)
                ? referer.match(/^https?:\/\/[^/]+/i)[0]
                : appConfig.site,
        }
        const finalPlayUrl = compatiblePlaybackUrl(freshPlaybackUrl(playUrl), referer)
        await sendDiagnosticLog('getPlayinfo:resolved', { type, playUrl, finalPlayUrl, referer })

        // 不提前请求媒体清单或分片，确保原生播放器拿到的是首次访问状态。
        return jsonify({
            urls: [finalPlayUrl],
            type,
            headers: [mediaHeaders],
        })
    } catch (error) {
        await sendDiagnosticLog('getPlayinfo:error', { error: formatError(error) })
        $utils.toastError(formatError(error))
        throw error
    }
}

/**
 * 搜索影片，兼容新版无尾斜杠的搜索地址。
 *
 * @param {object|string} ext 搜索参数
 * @return {string} 序列化后的搜索结果
 */
async function search(ext) {
    ext = argsify(ext)
    const keyword = String(ext.keyword || ext.text || '').trim()
    const page = Number(ext.page || 1)
    if (!keyword) return jsonify({ list: [] })

    const url = `${appConfig.site}/cn/search?keyword=${encodeURIComponent(keyword)}&page=${page}`
    try {
        const html = await requestHtml(url, `${appConfig.site}/cn/`, 'search')
        const list = parseCards(html, url)
        await sendDiagnosticLog('search:parsed', { keyword, page, count: list.length })
        if (!list.length) throw new Error('123AV 搜索 DOM 未匹配或没有结果')
        return jsonify({ list })
    } catch (error) {
        $utils.toastError(formatError(error))
        return jsonify({ list: [] })
    }
}
