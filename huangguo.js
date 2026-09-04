// 黄果短剧修复版
// 修复内容：分类改用站点 JSON 接口、封面在脚本内 AES 解密、搜索按真实页码请求并去重。

const CryptoJS = createCryptoJS()

const UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1'
const SITE = 'https://huangguoai.com'
const VERSION = 2026090401
const PLACEHOLDER = SITE + '/static/web/images/cover-placeholder.png'
const IMAGE_KEY = CryptoJS.enc.Utf8.parse('f5d965df75336270')
const IMAGE_IV = CryptoJS.enc.Utf8.parse('97b60394abc2fbe1')
const IMAGE_BATCH_SIZE = 4
const IMAGE_CACHE_LIMIT = 48

const HEADERS = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Referer: SITE + '/',
}

const IMAGE_HEADERS = {
    'User-Agent': UA,
    Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    Referer: SITE + '/',
}

const TABS = [
    { name: '首页', id: 'home' },
    { name: 'AI成人短剧', id: 'ai-duanju' },
    { name: 'AI成人漫剧', id: 'ai-manju' },
    { name: 'AI换脸', id: 'ai-huanlian' },
    { name: 'AI魔改', id: 'ai-mogai' },
    { name: '排行榜', id: 'ranks/hot' },
]

const imageCache = new Map()

// 把相对地址补成绝对地址。
function absoluteUrl(url) {
    const value = decodeHtml(String(url || '').trim())
    if (!value) return ''
    if (value.indexOf('//') === 0) return 'https:' + value
    if (value.indexOf('/') === 0) return SITE + value
    return value
}

// 去掉每次刷新都会改变的 CDN 临时签名，避免同一封面重复下载。
function stableImageUrl(url) {
    const value = absoluteUrl(url)
    if (value.indexOf('http') === 0) return value.replace(/\?.*$/, '')
    return value
}

// 解码页面中常见的 HTML 实体。
function decodeHtml(value) {
    return String(value || '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&#x27;/g, "'")
        .replace(/&nbsp;/g, ' ')
}

// 清理 HTML 标签并压缩多余空白。
function stripTags(value) {
    return decodeHtml(String(value || '').replace(/<[^>]*>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim()
}

// 读取网页文本，兼容返回字符串或其他可序列化数据的运行环境。
async function fetchHtml(url, referer) {
    const headers = referer ? Object.assign({}, HEADERS, { Referer: referer }) : HEADERS
    const response = await $fetch.get(url, { headers: headers, timeout: 20000 })
    const data = response && response.data
    return typeof data === 'string' ? data : data == null ? '' : JSON.stringify(data)
}

// 读取 JSON 接口，避免分类页 HTML 结构变化造成空列表。
async function fetchJson(url) {
    const response = await $fetch.get(url, {
        headers: Object.assign({}, HEADERS, { Accept: 'application/json, text/plain, */*' }),
        timeout: 20000,
    })
    const data = response && response.data
    if (data && typeof data === 'object') return data
    try {
        return JSON.parse(String(data || ''))
    } catch (e) {
        return null
    }
}

// 把二进制响应统一转成字节数组，兼容 ArrayBuffer、Uint8Array 和 Buffer JSON。
function toBytes(data) {
    if (data == null) return null
    if (data && data.type === 'Buffer' && Array.isArray(data.data)) {
        return new Uint8Array(data.data)
    }
    if (Array.isArray(data)) return new Uint8Array(data)
    if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) {
        return new Uint8Array(data)
    }
    if (
        typeof ArrayBuffer !== 'undefined' &&
        typeof ArrayBuffer.isView === 'function' &&
        ArrayBuffer.isView(data)
    ) {
        return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength)
    }
    if (typeof data === 'string') {
        const source = data.replace(/^data:[^,]*,/, '')
        if (/^[A-Za-z0-9+/\r\n]+={0,2}$/.test(source) && source.replace(/\s/g, '').length % 4 === 0) {
            try {
                return wordArrayToBytes(CryptoJS.enc.Base64.parse(source.replace(/\s/g, '')))
            } catch (e) {}
        }
        const bytes = new Uint8Array(data.length)
        for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 255
        return bytes
    }
    if (data && typeof data.length === 'number') {
        const bytes = new Uint8Array(data.length)
        for (let i = 0; i < data.length; i++) bytes[i] = Number(data[i]) & 255
        return bytes
    }
    return null
}

// 将字节数组转换为 CryptoJS WordArray。
function bytesToWordArray(bytes, length) {
    const size = length == null ? bytes.length : length
    const words = []
    for (let i = 0; i < size; i++) {
        words[i >>> 2] = (words[i >>> 2] || 0) | ((bytes[i] & 255) << (24 - (i % 4) * 8))
    }
    return CryptoJS.lib.WordArray.create(words, size)
}

// 将 CryptoJS WordArray 还原为字节数组。
function wordArrayToBytes(wordArray) {
    const words = wordArray.words || []
    const size = wordArray.sigBytes || 0
    const bytes = new Uint8Array(size)
    for (let i = 0; i < size; i++) {
        bytes[i] = (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 255
    }
    return bytes
}

// 判断二进制内容的真实图片类型。
function imageMime(bytes) {
    if (!bytes || bytes.length < 4) return ''
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
    if (
        bytes.length >= 8 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
    ) {
        return 'image/png'
    }
    if (
        bytes.length >= 12 &&
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
    ) {
        return 'image/webp'
    }
    if (
        bytes.length >= 6 &&
        bytes[0] === 0x47 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x38
    ) {
        return 'image/gif'
    }
    return ''
}

// 查找字节签名最后一次出现的位置。
function lastIndexOfBytes(bytes, signature) {
    for (let i = bytes.length - signature.length; i >= 0; i--) {
        let matched = true
        for (let j = 0; j < signature.length; j++) {
            if (bytes[i + j] !== signature[j]) {
                matched = false
                break
            }
        }
        if (matched) return i
    }
    return -1
}

// 去除 AES 填充与图片尾部多余字节，返回图片有效长度。
function cleanImageLength(bytes, mime) {
    let size = bytes.length
    const padding = bytes[size - 1]
    if (padding > 0 && padding <= 16 && padding <= size) {
        let validPadding = true
        for (let i = size - padding; i < size; i++) {
            if (bytes[i] !== padding) {
                validPadding = false
                break
            }
        }
        if (validPadding) size -= padding
    }

    const view = size === bytes.length ? bytes : bytes.subarray(0, size)
    if (mime === 'image/jpeg') {
        const end = lastIndexOfBytes(view, [0xff, 0xd9])
        if (end !== -1) size = end + 2
    } else if (mime === 'image/png') {
        const end = lastIndexOfBytes(view, [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])
        if (end !== -1) size = end + 8
    }
    return size
}

// 解密黄果 CDN 的 AES-128-CBC 密文并生成可直接显示的 Data URI。
function decryptImageData(data) {
    const encrypted = toBytes(data)
    if (!encrypted || !encrypted.length) return ''

    let plain = encrypted
    let mime = imageMime(plain)
    if (!mime && encrypted.length % 16 === 0) {
        try {
            const decrypted = CryptoJS.AES.decrypt(
                { ciphertext: bytesToWordArray(encrypted) },
                IMAGE_KEY,
                { iv: IMAGE_IV, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.NoPadding }
            )
            plain = wordArrayToBytes(decrypted)
            mime = imageMime(plain)
        } catch (e) {
            return ''
        }
    }
    if (!mime) return ''

    const size = cleanImageLength(plain, mime)
    const base64 = CryptoJS.enc.Base64.stringify(bytesToWordArray(plain, size))
    return 'data:' + mime + ';base64,' + base64
}

// 下载并解密单张封面；失败时使用站点的公开占位图，避免空白卡片。
async function decryptPoster(url) {
    const source = stableImageUrl(url)
    if (!source || source === PLACEHOLDER || source.indexOf('cover-placeholder') !== -1) return PLACEHOLDER
    if (imageCache.has(source)) return imageCache.get(source)

    const task = (async function () {
        try {
            const response = await $fetch.get(source, {
                headers: IMAGE_HEADERS,
                responseType: 'arraybuffer',
                timeout: 20000,
            })
            return decryptImageData(response && response.data) || PLACEHOLDER
        } catch (e) {
            console.error('[huangguo] 封面解密失败:', source, e)
            return PLACEHOLDER
        }
    })()

    imageCache.set(source, task)
    if (imageCache.size > IMAGE_CACHE_LIMIT) {
        const firstKey = imageCache.keys().next().value
        imageCache.delete(firstKey)
    }
    return task
}

// 分批处理封面，降低手机同时下载大量图片时的内存和连接压力。
async function hydratePosters(list) {
    for (let start = 0; start < list.length; start += IMAGE_BATCH_SIZE) {
        const batch = list.slice(start, start + IMAGE_BATCH_SIZE)
        const posters = await Promise.all(batch.map((item) => decryptPoster(item.vod_pic)))
        for (let i = 0; i < batch.length; i++) batch[i].vod_pic = posters[i]
    }
    return list
}

// 截取页面中的卡片网格；首页读取全部网格，普通列表只读取第一个网格。
function gridSlices(html, allGrids) {
    const regexp = /<div\s+class="[^"]*\bhg-card-grid\b[^"]*"[^>]*>/g
    const starts = []
    let match
    while ((match = regexp.exec(html)) !== null) starts.push(match.index + match[0].length)
    if (!starts.length) return []

    const slices = []
    const count = allGrids ? starts.length : 1
    for (let i = 0; i < count; i++) {
        const end = i + 1 < starts.length ? starts[i + 1] : html.length
        slices.push(html.slice(starts[i], end))
    }
    return slices
}

// 将一个卡片网格拆成独立卡片 HTML。
function cardBlocks(slice) {
    const regexp = /<div\s+class="[^"]*\bhg-drama-card\b[^"]*"[^>]*>/g
    const starts = []
    let match
    while ((match = regexp.exec(slice)) !== null) starts.push(match.index + match[0].length)

    const blocks = []
    for (let i = 0; i < starts.length; i++) {
        const end = i + 1 < starts.length ? starts[i + 1] : slice.length
        blocks.push(slice.slice(starts[i], end))
    }
    return blocks
}

// 解析单张 HTML 卡片。
function parseCardBlock(block) {
    const idMatch = block.match(/href="[^"]*\/detail\/(\d+)\/[^"]*"/)
    if (!idMatch) return null

    const imageMatch = block.match(/data-src="([^"]+)"/) || block.match(/src="([^"]+)"/)
    const titleMatch = block.match(/hg-drama-card__title[^>]*>([\s\S]*?)<\/a>/)
    const linkTitleMatch = block.match(/<a[^>]+href="[^"]*\/detail\/\d+\/"[^>]*>([\s\S]*?)<\/a>/)
    const title = stripTags(titleMatch ? titleMatch[1] : linkTitleMatch ? linkTitleMatch[1] : '')
    if (!title) return null

    const episodeMatch = block.match(/hg-drama-card__episode[^>]*>([\s\S]*?)<\/span>/)
    const scoreMatch = block.match(/hg-drama-card__score[^>]*>([\s\S]*?)<\/span>/)
    const episode = episodeMatch ? stripTags(episodeMatch[1]) : ''
    const score = scoreMatch ? stripTags(scoreMatch[1]) : ''

    return {
        vod_id: idMatch[1],
        vod_name: title,
        vod_pic: stableImageUrl(imageMatch ? imageMatch[1] : ''),
        vod_remarks: episode && score ? episode + ' · ' + score : episode || score,
        ext: { id: idMatch[1] },
    }
}

// 解析并按 vod_id 去重 HTML 卡片。
function parseGridCards(html, allGrids) {
    const list = []
    const seen = {}
    for (const slice of gridSlices(html || '', allGrids)) {
        for (const block of cardBlocks(slice)) {
            const item = parseCardBlock(block)
            if (!item || seen[item.vod_id]) continue
            seen[item.vod_id] = true
            list.push(item)
        }
    }
    return list
}

// 解析排行榜卡片并按 vod_id 去重。
function parseRanks(html) {
    const listMatch = String(html || '').match(/<div\s+class="[^"]*\bhg-rank-list\b[^"]*"[^>]*>/)
    if (!listMatch) return []

    const slice = html.slice(listMatch.index + listMatch[0].length)
    const regexp = /<div\s+class="[^"]*\bhg-rank-item\b[^"]*"[^>]*>/g
    const starts = []
    let match
    while ((match = regexp.exec(slice)) !== null) starts.push(match.index + match[0].length)

    const list = []
    const seen = {}
    for (let i = 0; i < starts.length; i++) {
        const end = i + 1 < starts.length ? starts[i + 1] : slice.length
        const block = slice.slice(starts[i], end)
        const idMatch = block.match(/href="[^"]*\/detail\/(\d+)\/[^"]*"/)
        if (!idMatch || seen[idMatch[1]]) continue

        const imageMatch = block.match(/data-src="([^"]+)"/) || block.match(/src="([^"]+)"/)
        const titleMatch = block.match(/hg-rank-item__title[^>]*>([\s\S]*?)<\/h2>/)
        const linkTitleMatch = block.match(/<a[^>]+href="[^"]*\/detail\/\d+\/"[^>]*>([\s\S]*?)<\/a>/)
        const title = stripTags(titleMatch ? titleMatch[1] : linkTitleMatch ? linkTitleMatch[1] : '')
        if (!title) continue

        const tagsMatch = block.match(/hg-rank-item__tags[^>]*>([\s\S]*?)<\/div>/)
        seen[idMatch[1]] = true
        list.push({
            vod_id: idMatch[1],
            vod_name: title,
            vod_pic: stableImageUrl(imageMatch ? imageMatch[1] : ''),
            vod_remarks: tagsMatch ? stripTags(tagsMatch[1]) : '',
            ext: { id: idMatch[1] },
        })
    }
    return list
}

// 将分类 JSON 项目转换为 XPTV 卡片。
function apiItemToCard(item) {
    if (!item || !item.id || !item.title) return null
    const remarks = []
    const episodeCount = parseInt(item.episode_count, 10) || 0
    if (episodeCount > 0) remarks.push((item.is_finished ? '全' : '更新至') + episodeCount + '集')
    if (item.score) remarks.push(String(item.score) + '分')
    if (Array.isArray(item.tags) && item.tags.length) remarks.push(item.tags.join('·'))
    return {
        vod_id: String(item.id),
        vod_name: String(item.title),
        vod_pic: stableImageUrl(item.cover || ''),
        vod_remarks: remarks.join(' · '),
        ext: { id: String(item.id) },
    }
}

// 读取源基本信息。
async function getLocalInfo() {
    return jsonify({ ver: VERSION, name: '黄果短剧', api: 'csp_huangguo', type: 3 })
}

// 返回分类配置。
async function getConfig() {
    return jsonify({
        ver: VERSION,
        title: '黄果短剧',
        site: SITE,
        tabs: TABS.map((tab) => ({ name: tab.name, ext: { id: tab.id } })),
    })
}

// 获取首页、分类或排行榜，并在返回前解密封面。
async function getCards(ext) {
    ext = argsify(ext)
    const id = String(ext.id || 'home').replace(/^\//, '')
    const page = Math.max(1, parseInt(ext.page, 10) || 1)
    try {
        let list = []
        if (id === 'home') {
            const html = await fetchHtml(SITE + '/')
            list = parseGridCards(html, true).slice(0, 30)
        } else if (id.indexOf('rank') !== -1) {
            const html = await fetchHtml(SITE + '/' + id + '/')
            list = parseRanks(html)
        } else {
            const json = await fetchJson(SITE + '/api/videos/category/' + encodeURIComponent(id) + '?page=' + page)
            const items = json && json.data && Array.isArray(json.data.items) ? json.data.items : []
            list = items.map(apiItemToCard).filter(Boolean)
            if (!list.length) {
                const url = SITE + '/' + id + '/' + (page > 1 ? page + '/' : '')
                list = parseGridCards(await fetchHtml(url), false)
            }
        }
        return jsonify({ list: await hydratePosters(list), page: page })
    } catch (e) {
        console.error('[huangguo] 获取列表失败:', e)
        return jsonify({ list: [], page: page })
    }
}

// 获取剧集列表。
async function getTracks(ext) {
    ext = argsify(ext)
    const id = String(ext.id || '').trim()
    if (!id) return jsonify({ list: [] })
    try {
        const html = await fetchHtml(SITE + '/detail/' + id + '/')
        const tracks = []
        const gridMatch = html.match(/<div\s+class="[^"]*\bhg-web-detail__ep-grid\b[^"]*"[^>]*>([\s\S]*?)<\/div>/)
        if (gridMatch) {
            const regexp = /<a\b[^>]*>[\s\S]*?<\/a>/g
            let match
            while ((match = regexp.exec(gridMatch[1])) !== null) {
                const tag = match[0]
                const hrefMatch = tag.match(/href="([^"]+)"/)
                if (!hrefMatch) continue
                const episodeMatch = tag.match(/data-ep-id="([^"]*)"/)
                const episode = episodeMatch ? episodeMatch[1] : ''
                tracks.push({
                    name: episode ? '第' + episode + '集' : stripTags(tag),
                    ext: { url: absoluteUrl(hrefMatch[1]), ep: episode },
                })
            }
        }
        if (!tracks.length) {
            const playMatch = html.match(/<a\b[^>]*class="[^"]*\bhg-web-detail__play\b[^"]*"[^>]*href="([^"]+)"/)
            if (playMatch) tracks.push({ name: '第1集', ext: { url: absoluteUrl(playMatch[1]), ep: '1' } })
        }
        return jsonify({ list: tracks.length ? [{ title: '黄果短剧', tracks: tracks }] : [] })
    } catch (e) {
        console.error('[huangguo] 获取剧集失败:', e)
        return jsonify({ list: [] })
    }
}

// 从播放页内嵌 JSON 提取 m3u8 地址。
async function getPlayinfo(ext) {
    ext = argsify(ext)
    const url = String(ext.url || '')
    const episode = String(ext.ep || '1')
    if (!url) return jsonify({ urls: [] })
    try {
        const html = await fetchHtml(url, SITE + '/')
        const initialDataMatch = html.match(/id="videoInitialData"[^>]*>([\s\S]*?)<\/script>/)
        let playUrl = ''
        if (initialDataMatch) {
            try {
                const data = JSON.parse(decodeHtml(initialDataMatch[1]))
                const sources = (data && data.epPlaySrcs) || {}
                playUrl = sources[episode] || (data && data.videoSrc) || ''
            } catch (e) {}
        }
        playUrl = String(playUrl || '').replace(/\\u0026/g, '&')
        if (playUrl && playUrl.indexOf('http') !== 0) {
            const urlMatch = playUrl.match(/(https?:\/\/[^\s"']+)/)
            playUrl = urlMatch ? urlMatch[1] : ''
        }
        return jsonify({
            urls: playUrl ? [playUrl] : [],
            headers: playUrl ? [{ 'User-Agent': UA, Referer: SITE + '/', Origin: SITE }] : [],
        })
    } catch (e) {
        console.error('[huangguo] 获取播放地址失败:', e)
        return jsonify({ urls: [] })
    }
}

// 搜索必须携带页码；第二页为空时直接返回空列表，防止客户端重复追加第一页。
async function search(ext) {
    ext = argsify(ext)
    const keyword = String(ext.text || ext.wd || ext.keyword || '').trim()
    const page = Math.max(1, parseInt(ext.page, 10) || 1)
    if (!keyword) return jsonify({ list: [], page: page })
    try {
        const suffix = page > 1 ? page + '/' : ''
        const url = SITE + '/search/video/' + encodeURIComponent(keyword) + '/' + suffix
        const list = parseGridCards(await fetchHtml(url), false)
        return jsonify({ list: await hydratePosters(list), page: page })
    } catch (e) {
        console.error('[huangguo] 搜索失败:', e)
        return jsonify({ list: [], page: page })
    }
}
