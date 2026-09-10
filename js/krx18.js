const cheerio = createCheerio()
const CryptoJS = createCryptoJS()

const UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'

const htmlHeaders = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
}

// Worker 只代取播放器页面和加密接口，视频媒体始终由手机直接读取。
const PLAY_PROXY = 'https://krx18-control.blessedlymm.workers.dev'

const appConfig = {
    ver: 2026091015,
    title: 'KRX18',
    // www.krx18.com 会跳转到该主域名，统一使用跳转后的地址可避免跨域重定向。
    site: 'https://krx18.com',
    tabs: [
        { name: '全部', ui: 1, ext: { url: 'https://krx18.com/movies/' } },
        { name: '英文字幕', ui: 1, ext: { url: 'https://krx18.com/genre/eng-sub/' } },
        { name: 'X短片', ui: 1, ext: { url: 'https://krx18.com/genre/xxx/' } },
        { name: '韩国', ui: 1, ext: { url: 'https://krx18.com/genre/korea/' } },
        { name: '日本', ui: 1, ext: { url: 'https://krx18.com/genre/japan/' } },
        { name: '中国', ui: 1, ext: { url: 'https://krx18.com/genre/china/' } },
        { name: '菲律宾', ui: 1, ext: { url: 'https://krx18.com/genre/philippines/' } },
        { name: '泰国', ui: 1, ext: { url: 'https://krx18.com/genre/thailand/' } },
        { name: '美国', ui: 1, ext: { url: 'https://krx18.com/genre/usa/' } },
    ],
}

/**
 * 返回扩展配置。
 */
async function getConfig() {
    await traceRuntime('getConfig')
    return jsonify(appConfig)
}

/**
 * 向诊断代理记录 XPTV 实际调用到的脚本入口；失败时不影响正常功能。
 */
async function traceRuntime(stage, detail = '') {
    const proxy = String(PLAY_PROXY || '').replace(/\/+$/, '')
    // 永久 Worker 不保存诊断日志，避免播放过程产生多余的公网请求。
    if (!proxy || /\.workers\.dev$/i.test(proxy)) return
    try {
        await $fetch.get(
            `${proxy}/trace?stage=${encodeURIComponent(stage)}&detail=${encodeURIComponent(detail)}&t=${Date.now()}`,
            { headers: { 'User-Agent': UA, 'Cache-Control': 'no-cache' } }
        )
    } catch (_) {
        // 诊断请求不得阻断列表或播放流程。
    }
}

/**
 * 取得完整地址中的协议和主机部分。
 */
function getOrigin(url) {
    const match = String(url || '').match(/^(https?:\/\/[^/]+)/i)
    return match ? match[1] : appConfig.site
}

/**
 * 把相对地址转换为完整地址。
 */
function absoluteUrl(url, base = appConfig.site) {
    const value = String(url || '').replace(/&amp;/g, '&').trim()
    if (!value) return ''
    if (value.startsWith('//')) return `https:${value}`
    if (/^https?:\/\//i.test(value)) return value

    const origin = getOrigin(base)
    return `${origin}${value.startsWith('/') ? '' : '/'}${value}`
}

/**
 * 清理页面文字中的连续空白。
 */
function cleanText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim()
}

/**
 * 根据代理配置生成带明确 M3U8 后缀且不复用旧缓存的播放地址。
 */
function getPlayableUrl(url, referer) {
    const playlistUrl = String(url || '').trim()
    const proxy = String(PLAY_PROXY || '').replace(/\/+$/, '')
    if (!playlistUrl || !proxy) return playlistUrl
    // 明确的 .m3u8 路径帮助播放器首轮按 HLS 探测，时间戳避免复用错误的短媒体缓存。
    return `${proxy}/manifest.m3u8?url=${encodeURIComponent(playlistUrl)}&referer=${encodeURIComponent(
        referer || ''
    )}&_xptv=${Date.now()}`
}

/**
 * 本地诊断时让直连媒体先经过一次 307 记录入口，随后仍由手机访问真实地址。
 *
 * @param {string} url 真实媒体地址
 * @param {string} kind 媒体类型
 * @param {object} meta 线路诊断信息
 * @returns {string} 正式地址或本地诊断跳转地址
 */
function getDiagnosticMediaUrl(url, kind, meta = {}) {
    const mediaUrl = String(url || '').trim()
    const proxy = String(PLAY_PROXY || '').replace(/\/+$/, '')
    if (!mediaUrl || !proxy || /\.workers\.dev$/i.test(proxy)) return mediaUrl

    // 只在本地诊断脚本生效，不改变 GitHub 正式脚本的直连行为。
    const suffix = kind === 'm3u8' ? 'm3u8' : kind === 'mp4' ? 'mp4' : 'bin'
    return `${proxy}/direct.${suffix}?url=${encodeURIComponent(mediaUrl)}&line=${encodeURIComponent(
        meta.number || ''
    )}&name=${encodeURIComponent(meta.name || '')}&kind=${encodeURIComponent(kind || 'unknown')}`
}

/**
 * 判断响应是否为 Cloudflare 人机验证页面。
 * 正常页面也可能加载 challenge-platform 监测脚本，因此只匹配验证页的明确标志。
 */
function isChallengePage(html) {
    const text = String(html || '')
    return (
        /<title>\s*(?:Just a moment|Attention Required|请稍候)/i.test(text) ||
        /window\._cf_chl_opt\b|id=["']challenge-form["']|cf-error-details/i.test(text)
    )
}

/**
 * 请求 KRX18 页面；遇到验证页时只记录错误，不自动打开内置浏览器。
 */
async function requestSite(url, referer = appConfig.site) {
    const target = absoluteUrl(url)
    const options = {
        headers: {
            ...htmlHeaders,
            Referer: referer,
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'same-origin',
        },
    }

    const response = await $fetch.get(target, options)
    if (isChallengePage(response.data)) {
        throw new Error('网站返回 Cloudflare 验证页，已禁止自动打开内置浏览器')
    }
    return response
}

/**
 * 读取图片节点中第一个有效的真实图片地址。
 */
function readImageUrl(image) {
    const names = ['data-src', 'data-lazy-src', 'data-original', 'data-cfsrc', 'src']
    for (const name of names) {
        const value = image.attr(name)
        if (value && !/^data:image\/svg/i.test(value)) return value
    }
    return ''
}

/**
 * 从列表或搜索 HTML 中解析影片卡片并去重。
 */
function parseCards(html, pageUrl) {
    const $ = cheerio.load(String(html || ''))
    const cards = []
    const seen = {}

    $('article.item').each((_, element) => {
        const item = $(element)
        if (item.hasClass('dp-ad-item')) return

        const link = item
            .find('.poster a[href*="/movies/"], .image a[href*="/movies/"], a[href*="/movies/"]')
            .first()
        const detailUrl = absoluteUrl(link.attr('href'), pageUrl)
        if (!detailUrl || seen[detailUrl]) return

        const image = item.find('.poster img, .image img, img').first()
        const title = cleanText(
            item.find('.data h3, h3.title, h3 a').first().text() || image.attr('alt')
        )
        if (!title) return

        const year = cleanText(item.find('.data span, .year').first().text())
        const cover = absoluteUrl(readImageUrl(image), pageUrl)
        seen[detailUrl] = true
        cards.push({
            vod_id: detailUrl,
            vod_name: title,
            vod_pic: cover,
            vod_remarks: year,
            vod_pubdate: year,
            ext: { url: detailUrl },
        })
    })

    return cards
}

/**
 * 从分页节点中取得总页数，防止客户端在末页无限重复加载。
 */
function parsePageCount(html, currentPage) {
    const $ = cheerio.load(String(html || ''))
    let pageCount = Number(currentPage || 1)
    const summary = cleanText($('.pagination span').first().text())
    const summaryMatch = summary.match(/(?:of|\/|共)\s*(\d+)/i)
    if (summaryMatch) pageCount = Math.max(pageCount, Number(summaryMatch[1]))

    $('.pagination a[href], .resppages a[href]').each((_, element) => {
        const href = $(element).attr('href') || ''
        const match = href.match(/\/page\/(\d+)/i)
        if (match) pageCount = Math.max(pageCount, Number(match[1]))
    })
    return pageCount
}

/**
 * 根据分类地址生成 WordPress 分页地址。
 */
function buildPageUrl(url, page) {
    const currentPage = Math.max(1, Number(page || 1))
    const clean = absoluteUrl(url)
        .replace(/[?#].*$/, '')
        .replace(/\/page\/\d+\/?$/i, '/')
        .replace(/\/?$/, '/')
    return currentPage > 1 ? `${clean}page/${currentPage}/` : clean
}

/**
 * 加载分类影片列表。
 */
async function getCards(ext) {
    ext = argsify(ext)
    const page = Math.max(1, Number(ext.page || 1))
    const url = buildPageUrl(ext.url || `${appConfig.site}/movies/`, page)

    try {
        const { data } = await requestSite(url)
        return jsonify({
            list: parseCards(data, url),
            page,
            pagecount: parsePageCount(data, page),
        })
    } catch (error) {
        $print(`KRX18 列表请求失败：${error}`)
        return jsonify({ list: [], page, pagecount: page })
    }
}

/**
 * 把接口响应兼容转换为普通对象。
 */
function parseJsonData(data) {
    if (data && typeof data === 'object') return data
    try {
        return JSON.parse(String(data || ''))
    } catch (_) {
        return argsify(data)
    }
}

/**
 * 调用 Dooplay 接口取得指定服务器的嵌入页地址。
 */
async function requestEmbedUrl(option, detailUrl) {
    const apiUrl = `${appConfig.site}/wp-json/dooplayer/v2/${option.post}/${option.type}/${option.number}`
    const { data } = await $fetch.get(apiUrl, {
        headers: {
            ...htmlHeaders,
            Accept: 'application/json, text/javascript, */*; q=0.01',
            Referer: detailUrl,
            'X-Requested-With': 'XMLHttpRequest',
        },
    })
    const result = parseJsonData(data)
    return absoluteUrl(result && result.embed_url ? result.embed_url : '', apiUrl)
}

const playKrx18Keys = {
    idFile: 'jcLycoRJT6OWjoWspgLMOZwS3aSS0lEn',
    idUser: 'PZZ3J3LDbLT0GY7qSA5wW5vchqgpO36O',
    request: 'vlVbUQhkOhoSfyteyzGeeDzU0BHoeTyZ',
    response: 'oJwmvmVBajMaRCTklxbfjavpQO7SZpsL',
    signature: 'KRWN3AdgmxEMcd2vLN1ju9qKe8Feco5h',
}

/**
 * 解密播放器使用的 OpenSSL Salted__ 十六进制密文。
 */
function decryptOpenSslHex(cipherHex, password) {
    const bytes = CryptoJS.enc.Hex.parse(String(cipherHex || ''))
    const base64 = CryptoJS.enc.Base64.stringify(bytes)
    return CryptoJS.AES.decrypt(base64, password).toString(CryptoJS.enc.Utf8)
}

/**
 * 按播放器规则生成 OpenSSL Salted__ 十六进制密文。
 */
function encryptOpenSslHex(text, password) {
    const plainText = String(text || '')
    // XPTV 沙箱没有原生随机模块，使用请求内容和时间生成每次不同的 8 字节盐。
    const saltDigest = CryptoJS.MD5(`${Date.now()}:${plainText}:${password}`)
    const salt = CryptoJS.lib.WordArray.create(saltDigest.words.slice(0, 2), 8)
    const derived = CryptoJS.kdf.OpenSSL.execute(password, 8, 4, salt)
    const encrypted = CryptoJS.AES.encrypt(plainText, derived.key, {
        iv: derived.iv,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7,
    })

    // CryptoJS 密码模式的输出格式为 Salted__ + 8 字节盐 + AES 密文。
    return CryptoJS.enc.Hex.parse('53616c7465645f5f')
        .concat(salt)
        .concat(encrypted.ciphertext)
        .toString(CryptoJS.enc.Hex)
}

/**
 * 通过 play.playkrx18.site 的站内播放接口取得真实 HLS 地址。
 */
async function resolvePlayKrx18(embedUrl, detailUrl) {
    const playOrigin = getOrigin(embedUrl)
    const proxy = String(PLAY_PROXY || '').replace(/\/+$/, '')
    const playerPageUrl = proxy
        ? `${proxy}/player-page?url=${encodeURIComponent(embedUrl)}&referer=${encodeURIComponent(detailUrl)}`
        : embedUrl
    await traceRuntime('resolveStart', playOrigin)
    const { data } = await $fetch.get(playerPageUrl, {
        headers: {
            ...htmlHeaders,
            Referer: detailUrl,
            Origin: getOrigin(detailUrl),
            'Sec-Fetch-Dest': 'iframe',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'cross-site',
        },
    })
    const html = String(data || '')
    await traceRuntime('playPageLoaded', `${html.length}`)
    const readConstant = (name) => {
        const match = html.match(new RegExp(`const\\s+${name}\\s*=\\s*["']([^"']+)["']`))
        return match ? match[1] : ''
    }
    const idFileEncrypted = readConstant('idfile_enc')
    const idUserEncrypted = readConstant('idUser_enc')
    const apiBase = readConstant('DOMAIN_API')
    if (!idFileEncrypted || !idUserEncrypted || !apiBase) {
        throw new Error('播放页缺少加密参数，可能被防盗链拦截')
    }
    await traceRuntime('playConstantsReady', getOrigin(apiBase))

    const requestBody = {
        idfile: decryptOpenSslHex(idFileEncrypted, playKrx18Keys.idFile),
        iduser: decryptOpenSslHex(idUserEncrypted, playKrx18Keys.idUser),
        domain_play: getOrigin(detailUrl),
        platform: 'iPhone',
        hlsSupport: false,
        jwplayer: {},
    }
    if (!requestBody.idfile || !requestBody.iduser) {
        throw new Error('播放页 ID 解密失败')
    }
    await traceRuntime('playIdsReady', `${requestBody.idfile.length}/${requestBody.iduser.length}`)

    const encrypted = encryptOpenSslHex(JSON.stringify(requestBody), playKrx18Keys.request)
    const signature = CryptoJS.MD5(`${encrypted}${playKrx18Keys.signature}`).toString()
    const apiUrl = `${String(apiBase).replace(/\/$/, '')}/playiframe`
    const requestApiUrl = proxy
        ? `${proxy}/play-api?url=${encodeURIComponent(apiUrl)}&referer=${encodeURIComponent(embedUrl)}`
        : apiUrl
    const response = await $fetch.post(
        requestApiUrl,
        { data: `${encrypted}|${signature}` },
        {
            headers: {
                ...htmlHeaders,
                Accept: 'application/json, text/javascript, */*; q=0.01',
                Referer: embedUrl,
                Origin: playOrigin,
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest',
            },
        }
    )
    const result = parseJsonData(response.data)
    await traceRuntime('playApiResponse', `${result && result.status}/${result && result.type}`)
    if (!result || Number(result.status) !== 1 || !result.data) {
        throw new Error(`播放接口返回异常：${result && result.status ? result.status : '无状态'}`)
    }

    const playlist = decryptOpenSslHex(result.data, playKrx18Keys.response)
    if (!/^https?:\/\//i.test(playlist)) throw new Error('HLS 地址解密失败')
    await traceRuntime('playlistReady', getOrigin(playlist))
    return {
        url: playlist,
        referer: embedUrl,
        origin: playOrigin,
    }
}

/**
 * 使用站点播放器相同的 AES-CTR 规则解密 Abyss 媒体配置。
 */
function decryptAbyssMedia(payload) {
    const seed = `${payload.user_id}:${payload.slug}:${payload.md5_id}`
    const digest = CryptoJS.MD5(seed).toString(CryptoJS.enc.Hex)
    const key = CryptoJS.enc.Utf8.parse(digest)
    const counter = CryptoJS.enc.Utf8.parse(digest.slice(0, 16))
    const ciphertext = CryptoJS.enc.Latin1.parse(payload.media)
    const decrypted = CryptoJS.AES.decrypt(
        { ciphertext },
        key,
        {
            iv: counter,
            mode: CryptoJS.mode.CTR,
            padding: CryptoJS.pad.NoPadding,
        }
    ).toString(CryptoJS.enc.Utf8)
    return JSON.parse(decrypted)
}

/**
 * 解析 Abyss 播放页，并只保留完整文件而排除仅含首段的分片地址。
 */
async function resolveAbyssSources(embedUrl) {
    const { data } = await $fetch.get(embedUrl, {
        headers: {
            ...htmlHeaders,
            Referer: appConfig.site,
            'Sec-Fetch-Dest': 'iframe',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'cross-site',
        },
    })
    const match = String(data || '').match(/const\s+datas\s*=\s*["']([^"']+)["']/)
    if (!match) throw new Error('Abyss 页面缺少 datas 参数')

    // 必须按 Latin1 还原 atob 的二进制字符串，否则密文中的高位字节会损坏。
    const payloadText = CryptoJS.enc.Base64.parse(match[1]).toString(CryptoJS.enc.Latin1)
    const payload = JSON.parse(payloadText)
    const media = decryptAbyssMedia(payload)
    const mp4 = media && media.mp4 ? media.mp4 : {}
    const sources = Array.isArray(mp4.sources) ? mp4.sources : []
    const directSources = []

    sources.forEach((source) => {
        const size = Number(source.size || 0)
        const partSize = Number(source.partSize || 0)
        let url = ''

        if (source.file && /^https?:\/\//i.test(source.file)) {
            url = source.file
        } else if (source.url && source.path && (!partSize || partSize >= size)) {
            // path 存在但 partSize 小于 size 时只是首个分片，不能交给播放器当完整视频。
            url = `${String(source.url).replace(/\/$/, '')}/${String(source.path).replace(/^\//, '')}`
        }
        if (!url) return

        directSources.push({
            name: cleanText(source.label || `${source.res_id || ''}P`) || '播放',
            url,
            size,
        })
    })

    // 默认把较高清晰度放在前面。
    return directSources.sort((left, right) => right.size - left.size)
}

/**
 * 从常见外部播放器 HTML 中提取未混淆的 HLS 或 MP4 地址。
 *
 * @param {string} html 播放器页面源码
 * @param {string} embedUrl 播放器页面地址
 * @returns {Array<{url: string, type: string}>} 去重后的媒体候选
 */
function extractExternalMediaUrls(html, embedUrl) {
    const normalized = String(html || '')
        .replace(/\\u002f/gi, '/')
        .replace(/\\\//g, '/')
        .replace(/&amp;/gi, '&')
    const candidates = []
    const seen = {}
    const patterns = [
        /https?:\/\/[^"'<>\s]+?\.m3u8(?:\?[^"'<>\s]*)?/gi,
        /https?:\/\/[^"'<>\s]+?\.mp4(?:\?[^"'<>\s]*)?/gi,
        /(?:file|src|source)\s*[:=]\s*["']([^"']+\.(?:m3u8|mp4)(?:\?[^"']*)?)["']/gi,
    ]

    patterns.forEach((pattern) => {
        let match
        while ((match = pattern.exec(normalized))) {
            try {
                const url = absoluteUrl(match[1] || match[0], embedUrl)
                if (!/^https?:\/\//i.test(url) || seen[url]) continue
                seen[url] = true
                candidates.push({
                    url,
                    type: /\.m3u8(?:[?#]|$)/i.test(url) ? 'm3u8' : 'mp4',
                })
            } catch (_) {
                // 单个候选格式错误时继续检查页面中的其他地址。
            }
        }
    })
    return candidates
}

/**
 * 由手机读取外部播放器页面，并记录页面特征与可见媒体候选。
 *
 * @param {string} embedUrl 外部播放器地址
 * @param {string} detailUrl KRX18 详情页地址
 * @param {object} meta 线路诊断信息
 * @returns {Promise<{url: string, type: string, referer: string}>} 可播放媒体信息
 */
async function resolveExternalMedia(embedUrl, detailUrl, meta = {}) {
    const { data } = await $fetch.get(embedUrl, {
        headers: {
            ...htmlHeaders,
            Referer: detailUrl,
            'Sec-Fetch-Dest': 'iframe',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'cross-site',
        },
    })
    const html = String(data || '')
    const candidates = extractExternalMediaUrls(html, embedUrl)
    await traceRuntime(
        'externalPage',
        `line=${meta.number || ''}|name=${meta.name || ''}|host=${getOrigin(embedUrl)}|bytes=${html.length}|candidates=${
            candidates.length
        }|packed=${/eval\s*\(\s*function\s*\(p,a,c,k,e/i.test(html)}|cf=${/Just a moment|cf-chl|challenge-platform/i.test(
            html
        )}|urls=${candidates.map((item) => item.url).join(',')}`.slice(0, 900)
    )
    if (!candidates.length) throw new Error(`外部播放器 ${getOrigin(embedUrl)} 未发现明文媒体地址`)
    return { ...candidates[0], referer: embedUrl }
}

/**
 * 加载详情页、解析服务器，并生成可直接播放的 HLS 或完整媒体线路。
 */
async function getTracks(ext) {
    ext = argsify(ext)
    await traceRuntime('getTracks', ext.url || '')
    const detailUrl = absoluteUrl(ext.url)
    const tracks = []
    const seen = {}

    try {
        const { data } = await requestSite(detailUrl)
        const $ = cheerio.load(String(data || ''))
        const options = []

        $('li.dooplay_player_option[data-post][data-nume]').each((_, element) => {
            const item = $(element)
            const post = item.attr('data-post')
            const number = item.attr('data-nume')
            const type = item.attr('data-type') || 'movie'
            if (!post || !number) return

            options.push({
                post,
                number,
                type,
                name: cleanText(item.find('.title').text() || `Server ${number}`),
                server: cleanText(item.find('.server').text()),
            })
        })
        await traceRuntime(
            'trackOptions',
            options.map((item) => `${item.number}:${item.name || item.server || 'unknown'}`).join(',').slice(0, 500)
        )

        for (const option of options) {
            try {
                const embedUrl = await requestEmbedUrl(option, detailUrl)
                await traceRuntime(
                    'trackEmbed',
                    `line=${option.number}|name=${option.name || option.server || ''}|url=${embedUrl || 'empty'}`.slice(0, 500)
                )
                if (!embedUrl) continue

                if (/\.(?:m3u8|mp4)(?:[?#]|$)/i.test(embedUrl)) {
                    if (!seen[embedUrl]) {
                        seen[embedUrl] = true
                        tracks.push({
                            name: option.name,
                            pan: '',
                            ext: {
                                resolver: 'direct',
                                url: embedUrl,
                                referer: detailUrl,
                                number: option.number,
                                serverName: option.name,
                            },
                        })
                    }
                    continue
                }

                if (/play\.playkrx18\.site\/play\//i.test(embedUrl)) {
                    // 先返回线路，避免预解析失败时整个播放器入口消失。
                    const trackKey = `playkrx18:${embedUrl}`
                    if (seen[trackKey]) continue
                    seen[trackKey] = true
                    tracks.push({
                        name: option.name || 'Server 1',
                        pan: '',
                        ext: {
                            resolver: 'playkrx18',
                            embedUrl,
                            detailUrl,
                            number: option.number,
                            serverName: option.name,
                        },
                    })
                    continue
                }

                if (/mov18plus\.cloud|abyss/i.test(embedUrl)) {
                    const trackKey = `abyss:${embedUrl}`
                    if (!seen[trackKey]) {
                        seen[trackKey] = true
                        tracks.push({
                            name: option.name,
                            pan: '',
                            ext: {
                                resolver: 'abyss',
                                embedUrl,
                                detailUrl,
                                number: option.number,
                                serverName: option.name,
                            },
                        })
                    }
                    continue
                }

                // 其他外部播放器先保留为可点击线路，点击后由手机抓取页面并记录解析特征。
                const trackKey = `external:${embedUrl}`
                if (!seen[trackKey]) {
                    seen[trackKey] = true
                    tracks.push({
                        name: option.name,
                        pan: '',
                        ext: {
                            resolver: 'external',
                            embedUrl,
                            detailUrl,
                            number: option.number,
                            serverName: option.name,
                        },
                    })
                }
            } catch (error) {
                // 单条服务器失效时继续尝试其余服务器，避免整个详情页无结果。
                await traceRuntime(
                    'trackResolveError',
                    `line=${option.number}|name=${option.name || ''}|error=${String(error)}`.slice(0, 500)
                )
                $print(`KRX18 ${option.name} 解析失败：${error}`)
            }
        }

        if (!tracks.length) {
            throw new Error('没有找到可直接播放的完整媒体文件')
        }
    } catch (error) {
        $print(`KRX18 播放解析失败：${error}`)
    }

    return jsonify({
        list: tracks.length ? [{ title: '默认分组', tracks }] : [],
    })
}

/**
 * 返回播放器最终使用的媒体地址及防盗链请求头。
 */
async function getPlayinfo(ext) {
    ext = argsify(ext)
    await traceRuntime(
        'getPlayinfo',
        `resolver=${ext.resolver || 'unknown'}|line=${ext.number || ''}|name=${ext.serverName || ''}|url=${
            ext.embedUrl || ext.url || 'empty'
        }`.slice(0, 500)
    )
    if (ext.resolver === 'playkrx18') {
        try {
            // 点击线路后再调用播放接口，此时即使解析失败也不会影响线路页面展示。
            const embedUrl =
                ext.embedUrl ||
                (await requestEmbedUrl(
                    {
                        post: ext.post,
                        number: ext.number,
                        type: ext.type || 'movie',
                    },
                    ext.detailUrl
                ))
            await traceRuntime(
                'embedUrlReady',
                `line=${ext.number || ''}|name=${ext.serverName || ''}|url=${embedUrl}`.slice(0, 500)
            )
            if (!/play\.playkrx18\.site\/play\//i.test(embedUrl)) {
                throw new Error('当前线路未返回 play.playkrx18.site 播放页')
            }
            const source = await resolvePlayKrx18(embedUrl, ext.detailUrl)
            // Worker 只代取与出口绑定的 M3U8 文本；清单中的视频分片保持上游地址，
            // 由手机直接读取，不经过电脑或 Worker。
            const playableUrl = getPlayableUrl(source.url, source.referer)
            await traceRuntime('getPlayinfoReturn', getOrigin(playableUrl))
            return jsonify({
                urls: [playableUrl],
                type: 'm3u8',
                headers: [
                    {
                        'User-Agent': UA,
                        Referer: source.referer,
                        Origin: source.origin,
                    },
                ],
            })
        } catch (error) {
            await traceRuntime('getPlayinfoError', String(error).slice(0, 300))
            throw error
        }
    }

    if (ext.resolver === 'abyss') {
        try {
            const sources = await resolveAbyssSources(ext.embedUrl)
            await traceRuntime(
                'abyssSources',
                `line=${ext.number || ''}|name=${ext.serverName || ''}|count=${sources.length}|urls=${sources
                    .map((item) => `${item.name}:${item.url}`)
                    .join(',')}`.slice(0, 900)
            )
            if (!sources.length) throw new Error('Abyss 没有返回可作为完整文件播放的地址')
            const source = sources[0]
            return jsonify({
                urls: [getDiagnosticMediaUrl(source.url, 'mp4', { number: ext.number, name: ext.serverName })],
                type: 'mp4',
                headers: [{ 'User-Agent': UA, Referer: ext.embedUrl }],
            })
        } catch (error) {
            await traceRuntime('abyssError', String(error).slice(0, 500))
            throw error
        }
    }

    if (ext.resolver === 'external') {
        try {
            const source = await resolveExternalMedia(ext.embedUrl, ext.detailUrl, {
                number: ext.number,
                name: ext.serverName,
            })
            return jsonify({
                urls: [getDiagnosticMediaUrl(source.url, source.type, { number: ext.number, name: ext.serverName })],
                type: source.type,
                headers: [{ 'User-Agent': UA, Referer: source.referer }],
            })
        } catch (error) {
            await traceRuntime('externalError', String(error).slice(0, 500))
            throw error
        }
    }

    const directUrl = String(ext.url || '')
    const directType = /\.m3u8(?:[?#]|$)/i.test(directUrl)
        ? 'm3u8'
        : /\.mp4(?:[?#]|$)/i.test(directUrl)
          ? 'mp4'
          : 'unknown'
    const diagnosticUrl = getDiagnosticMediaUrl(directUrl, directType, {
        number: ext.number,
        name: ext.serverName,
    })
    await traceRuntime(
        'getPlayinfoDirect',
        `line=${ext.number || ''}|name=${ext.serverName || ''}|type=${directType}|url=${directUrl}`.slice(0, 500)
    )
    return jsonify({
        urls: [diagnosticUrl],
        ...(directType !== 'unknown' ? { type: directType } : {}),
        headers: [
            {
                'User-Agent': UA,
                Referer: ext.referer || appConfig.site,
                Origin: ext.origin || getOrigin(ext.referer || appConfig.site),
            },
        ],
    })
}

/**
 * 搜索影片并支持 WordPress 搜索结果分页。
 */
async function search(ext) {
    ext = argsify(ext)
    const text = cleanText(ext.text || ext.keyword)
    const page = Math.max(1, Number(ext.page || 1))
    if (!text) return jsonify({ list: [], page, pagecount: page })

    const query = encodeURIComponent(text)
    const url =
        page > 1
            ? `${appConfig.site}/page/${page}/?s=${query}`
            : `${appConfig.site}/?s=${query}`

    try {
        const { data } = await requestSite(url)
        return jsonify({
            list: parseCards(data, url),
            page,
            pagecount: parsePageCount(data, page),
        })
    } catch (error) {
        $print(`KRX18 搜索失败：${error}`)
        return jsonify({ list: [], page, pagecount: page })
    }
}
