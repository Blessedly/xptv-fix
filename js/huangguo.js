// 黄果短剧修复版
// 修复内容：分类改用站点 JSON 接口、封面转换为普通 HTTPS 图片、搜索按真实页码请求并去重。

const UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1'
const SITE = 'https://huangguoai.com'
const VERSION = 2026090403
const PLACEHOLDER = SITE + '/static/web/images/cover-placeholder.png'
const IMAGE_PROXY = 'https://images.weserv.nl/'
const IMAGE_BATCH_SIZE = 8
const IMAGE_CACHE_LIMIT = 48

const HEADERS = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
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

// 从详情页读取站点提供的明文分享海报，并包装成客户端可直接加载的 HTTPS 图片。
async function getPosterUrl(id) {
    const cacheKey = String(id || '')
    if (!cacheKey) return PLACEHOLDER
    if (imageCache.has(cacheKey)) return imageCache.get(cacheKey)

    const task = (async function () {
        try {
            const response = await $fetch.get(SITE + '/detail/' + encodeURIComponent(cacheKey) + '/', {
                headers: Object.assign({}, HEADERS, { 'User-Agent': 'Twitterbot/1.0' }),
                timeout: 20000,
            })
            const html = response && response.data == null ? '' : String(response.data)
            const first = html.match(
                /<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i
            )
            const second = html.match(
                /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image["'][^>]*>/i
            )
            const exposed = decodeHtml(first ? first[1] : second ? second[1] : '')
            if (!/^https?:\/\//i.test(exposed)) return PLACEHOLDER
            return IMAGE_PROXY + '?url=' + encodeURIComponent(exposed) + '&w=360&output=jpg&q=85'
        } catch (e) {
            console.error('[huangguo] 获取明文海报失败:', cacheKey, e)
            return PLACEHOLDER
        }
    })()

    imageCache.set(cacheKey, task)
    if (imageCache.size > IMAGE_CACHE_LIMIT) {
        const firstKey = imageCache.keys().next().value
        imageCache.delete(firstKey)
    }
    return task
}

// 分批获取明文海报地址，避免同时请求过多详情页。
async function hydratePosters(list) {
    for (let start = 0; start < list.length; start += IMAGE_BATCH_SIZE) {
        const batch = list.slice(start, start + IMAGE_BATCH_SIZE)
        const posters = await Promise.all(batch.map((item) => getPosterUrl(item.vod_id)))
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
        let pagecount = 1
        if (id === 'home') {
            // 首页没有分页，后续页必须返回空列表，否则客户端会无限追加同一批内容。
            if (page > 1) return jsonify({ list: [], page: page, pagecount: 1 })
            const html = await fetchHtml(SITE + '/')
            list = parseGridCards(html, true).slice(0, 30)
        } else if (id.indexOf('rank') !== -1) {
            // 排行榜也是单页内容，禁止重复读取第一页。
            if (page > 1) return jsonify({ list: [], page: page, pagecount: 1 })
            const html = await fetchHtml(SITE + '/' + id + '/')
            list = parseRanks(html)
        } else {
            const json = await fetchJson(SITE + '/api/videos/category/' + encodeURIComponent(id) + '?page=' + page)
            const data = json && json.data
            if (data && Array.isArray(data.items)) {
                list = data.items.map(apiItemToCard).filter(Boolean)
                const pages = parseInt(data.pagination && data.pagination.pages, 10)
                pagecount = pages > 0 ? pages : list.length ? page + 1 : page
            } else {
                // 仅当 JSON 接口确实不可用时才回退 HTML；接口正常但末页为空时不能回退。
                const url = SITE + '/' + id + '/' + (page > 1 ? page + '/' : '')
                list = parseGridCards(await fetchHtml(url), false)
                pagecount = list.length ? page + 1 : page
            }
        }
        return jsonify({ list: await hydratePosters(list), page: page, pagecount: pagecount })
    } catch (e) {
        console.error('[huangguo] 获取列表失败:', e)
        return jsonify({ list: [], page: page, pagecount: page })
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
    if (!keyword || page > 1) return jsonify({ list: [], page: page, pagecount: 1 })
    try {
        const url = SITE + '/search/video/' + encodeURIComponent(keyword) + '/'
        const list = parseGridCards(await fetchHtml(url), false)
        return jsonify({ list: await hydratePosters(list), page: page, pagecount: 1 })
    } catch (e) {
        console.error('[huangguo] 搜索失败:', e)
        return jsonify({ list: [], page: page, pagecount: 1 })
    }
}
