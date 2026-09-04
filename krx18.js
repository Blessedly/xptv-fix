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

const appConfig = {
    ver: 2026090401,
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

let challengeOpened = false

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
 * 判断响应是否为 Cloudflare 人机验证页面。
 */
function isChallengePage(html) {
    const text = String(html || '')
    return (
        /<title>\s*(?:Just a moment|Attention Required|请稍候)/i.test(text) ||
        /challenge-platform|cf-chl-|cf-mitigated|Performing security verification/i.test(text)
    )
}

/**
 * 仅在确认遇到验证页时打开一次内置浏览器。
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
 * 请求 KRX18 页面，并兼容客户端提供的 Cloudflare 请求方法。
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

    try {
        // 新版客户端若提供专用方法，则由它处理验证 Cookie；旧版继续使用普通请求。
        const response =
            typeof requestWithCloudflare === 'function'
                ? await requestWithCloudflare(target, options)
                : await $fetch.get(target, options)
        if (isChallengePage(response.data)) {
            openChallengePage(target)
            throw new Error('网站返回 Cloudflare 验证页，完成验证后请重新加载')
        }
        return response
    } catch (error) {
        if (/403|Forbidden|Cloudflare|Just a moment|验证/i.test(String(error || ''))) {
            openChallengePage(target)
        }
        throw error
    }
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
 * 加载详情页、解析服务器，并生成可直接播放的完整 MP4 线路。
 */
async function getTracks(ext) {
    ext = argsify(ext)
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

        for (const option of options) {
            try {
                const embedUrl = await requestEmbedUrl(option, detailUrl)
                if (!embedUrl) continue

                if (/\.(?:m3u8|mp4)(?:[?#]|$)/i.test(embedUrl)) {
                    if (!seen[embedUrl]) {
                        seen[embedUrl] = true
                        tracks.push({
                            name: option.name,
                            pan: '',
                            ext: { url: embedUrl, referer: detailUrl },
                        })
                    }
                    continue
                }

                if (/mov18plus\.cloud|abyss/i.test(embedUrl)) {
                    const sources = await resolveAbyssSources(embedUrl)
                    sources.forEach((source) => {
                        if (seen[source.url]) return
                        seen[source.url] = true
                        tracks.push({
                            name: `${option.name} · ${source.name}`,
                            pan: '',
                            ext: {
                                url: source.url,
                                referer: embedUrl,
                                origin: getOrigin(embedUrl),
                            },
                        })
                    })
                }
            } catch (error) {
                // 单条服务器失效时继续尝试其余服务器，避免整个详情页无结果。
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
    return jsonify({
        urls: [ext.url],
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
