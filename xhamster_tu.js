const cheerio = createCheerio()

const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

const headers = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
}

const appConfig = {
    ver: 2026090301,
    title: 'xhamster_兔',
    site: 'https://zh.xhamster.com',
    tabs: [
        { name: '最新', ext: { href: '/newest' }, ui: 1 },
        { name: '本周最佳', ext: { href: '/best/weekly' }, ui: 1 },
        { name: '4K', ext: { href: '/4k' }, ui: 1 },
    ],
}

/**
 * 返回扩展配置。
 */
async function getConfig() {
    return jsonify(appConfig)
}

/**
 * 将秒数转换为播放器列表使用的时长文本。
 */
function formatDuration(seconds) {
    const value = Number(seconds || 0)
    if (!value) return ''
    const hours = Math.floor(value / 3600)
    const minutes = Math.floor((value % 3600) / 60)
    const secs = value % 60
    return hours
        ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
        : `${minutes}:${String(secs).padStart(2, '0')}`
}

/**
 * 从新版页面内嵌的 window.initials JSON 中读取结构化数据。
 */
function parseInitials(html) {
    const marker = 'window.initials='
    const start = String(html).indexOf(marker)
    if (start < 0) return null
    const jsonStart = start + marker.length
    const end = String(html).indexOf(';</script>', jsonStart)
    if (end < 0) return null
    try {
        return JSON.parse(String(html).slice(jsonStart, end))
    } catch (error) {
        $print(`xHamster initials 解析失败：${error}`)
        return null
    }
}

/**
 * 递归查找指定字段，适配站点频繁调整的组件嵌套层级。
 */
function findObjects(value, predicate, result = []) {
    if (!value || typeof value !== 'object') return result
    if (predicate(value)) result.push(value)
    if (Array.isArray(value)) {
        value.forEach((item) => findObjects(item, predicate, result))
    } else {
        Object.keys(value).forEach((key) => findObjects(value[key], predicate, result))
    }
    return result
}

/**
 * 从 HTML DOM 或内嵌 JSON 中提取视频卡片。
 */
function parseCards(html) {
    const cards = []
    const seen = {}
    const $ = cheerio.load(html)

    $('.thumb-list__item[data-video-id]').each((_, element) => {
        const id = $(element).attr('data-video-id')
        const imageLink = $(element).find('a.video-thumb__image-container').first()
        const href = imageLink.attr('href')
        if (!id || !href || seen[id]) return

        const image = imageLink.find('img.thumb-image-container__image').first()
        const title = image.attr('alt') || $(element).find('.video-thumb-info__name').attr('title') || ''
        const cover = image.attr('src') || image.attr('data-src') || ''
        const views = $(element).find('.video-thumb-views').text().trim()
        const duration = $(element).find('.thumb-image-container__duration').text().trim()
        seen[id] = true
        cards.push({
            vod_id: String(id),
            vod_name: title,
            vod_pic: cover,
            vod_remarks: views,
            vod_duration: duration,
            ext: { url: href },
        })
    })

    // DOM 类名变化或服务端只渲染占位符时，回退到稳定的结构化字段。
    if (!cards.length) {
        const initials = parseInitials(html)
        const models = findObjects(
            initials,
            (item) => item.id && item.pageURL && item.title && (item.thumbURL || item.imageURL),
        )
        models.forEach((item) => {
            const id = String(item.id)
            if (seen[id]) return
            seen[id] = true
            cards.push({
                vod_id: id,
                vod_name: item.title || item.titleLocalized || '',
                vod_pic: item.thumbURL || item.imageURL || '',
                vod_remarks: item.views == null ? '' : `${item.views} 观看次数`,
                vod_duration: formatDuration(item.duration),
                ext: { url: item.pageURL },
            })
        })
    }
    return cards
}

/**
 * 加载分类影片列表。
 */
async function getCards(ext) {
    ext = argsify(ext)
    const page = ext.page || 1
    const href = ext.href || '/newest'
    const url = `${appConfig.site}${href}${page > 1 ? `/${page}` : ''}`

    try {
        const { data } = await $fetch.get(url, { headers })
        return jsonify({ list: parseCards(data) })
    } catch (error) {
        $print(`xHamster 列表请求失败：${error}`)
        return jsonify({ list: [] })
    }
}

/**
 * 把相对播放清单地址转换为完整 URL。
 */
function resolveUrl(base, url) {
    if (!url) return ''
    if (/^https?:\/\//i.test(url)) return url
    const slash = base.lastIndexOf('/')
    return `${base.slice(0, slash + 1)}${url}`
}

/**
 * 从任意对象中收集 m3u8 和 mp4 媒体地址。
 */
function collectMediaUrls(value, result = []) {
    if (typeof value === 'string') {
        if (/^https?:\/\/.*\.(?:m3u8|mp4)(?:[?#].*)?$/i.test(value)) result.push(value)
        return result
    }
    if (!value || typeof value !== 'object') return result
    if (Array.isArray(value)) value.forEach((item) => collectMediaUrls(item, result))
    else Object.keys(value).forEach((key) => collectMediaUrls(value[key], result))
    return result
}

/**
 * 从主 m3u8 中提取不同清晰度；没有子清单时保留主地址。
 */
async function expandPlaylist(url, referer) {
    try {
        const response = await $fetch.get(url, {
            headers: { ...headers, Referer: referer },
        })
        const text = String(response.data || '')
        const tracks = []
        const lines = text.split(/\r?\n/)
        for (let index = 0; index < lines.length; index += 1) {
            if (!lines[index].startsWith('#EXT-X-STREAM-INF')) continue
            const next = lines[index + 1] || ''
            if (!next || next.startsWith('#')) continue
            const resolution = (lines[index].match(/RESOLUTION=\d+x(\d+)/i) || [])[1]
            tracks.push({
                name: resolution ? `${resolution}p` : `线路${tracks.length + 1}`,
                pan: '',
                ext: { url: resolveUrl(url, next), referer },
            })
        }
        if (tracks.length) return tracks
    } catch (error) {
        $print(`xHamster 主播放清单解析失败：${error}`)
    }
    return [{ name: '播放', pan: '', ext: { url, referer } }]
}

/**
 * 兼容旧 preload 清单和新版 window.initials 播放数据。
 */
async function getTracks(ext) {
    ext = argsify(ext)
    const pageUrl = ext.url
    try {
        const { data } = await $fetch.get(pageUrl, { headers })
        const html = String(data || '')
        const $ = cheerio.load(html)
        const preload = $('link[rel="preload"][as="fetch"]').attr('href')
        let mediaUrls = []

        if (preload) mediaUrls.push(preload)
        const initials = parseInitials(html)
        mediaUrls = mediaUrls.concat(collectMediaUrls(initials))
        mediaUrls = [...new Set(mediaUrls)]

        if (!mediaUrls.length) {
            if (/"isAgeVerificationRequired":true/.test(html)) {
                $print('xHamster 当前网络地区要求完成年龄验证，页面未下发播放地址')
            } else {
                $print('xHamster 页面中未找到播放地址，播放结构可能已再次更新')
            }
            return jsonify({ list: [] })
        }

        let tracks = []
        for (const url of mediaUrls.slice(0, 8)) {
            if (/\.m3u8(?:[?#]|$)/i.test(url)) tracks = tracks.concat(await expandPlaylist(url, pageUrl))
            else tracks.push({ name: 'MP4', pan: '', ext: { url, referer: pageUrl } })
        }
        return jsonify({ list: [{ title: '默认分组', tracks }] })
    } catch (error) {
        $print(`xHamster 播放解析失败：${error}`)
        return jsonify({ list: [] })
    }
}

/**
 * 返回媒体地址和站点要求的 Referer。
 */
async function getPlayinfo(ext) {
    ext = argsify(ext)
    return jsonify({
        urls: [ext.url],
        headers: [{ 'User-Agent': UA, Referer: ext.referer || `${appConfig.site}/` }],
    })
}

/**
 * 搜索视频并复用统一卡片解析。
 */
async function search(ext) {
    ext = argsify(ext)
    const text = encodeURIComponent(ext.text || '')
    const page = ext.page || 1
    const url = `${appConfig.site}/search/${text}?page=${page}`
    try {
        const { data } = await $fetch.get(url, { headers })
        return jsonify({ list: parseCards(data) })
    } catch (error) {
        $print(`xHamster 搜索请求失败：${error}`)
        return jsonify({ list: [] })
    }
}
