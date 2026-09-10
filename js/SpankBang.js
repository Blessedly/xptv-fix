const cheerio = createCheerio()

const UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1'

const appConfig = {
    ver: 2026090801,
    title: 'SpankBang-Fix',
    site: 'https://jp.spankbang.com',
    tabs: [
        {
            name: '最新',
            ui: 1,
            ext: { id: 'new_videos' },
        },
    ],
}

/**
 * 将站内相对地址转换为完整地址。
 *
 * @param {string} url 原始地址
 * @return {string} 可直接请求的完整地址
 */
function absoluteUrl(url) {
    if (!url) return ''
    if (/^https?:\/\//i.test(url)) return url
    if (url.startsWith('//')) return `https:${url}`
    return `${appConfig.site}${url.startsWith('/') ? '' : '/'}${url}`
}

/**
 * 请求网页并识别常见的反爬验证页。
 *
 * @param {string} url 页面地址
 * @return {Promise<string>} 页面 HTML
 */
async function requestPage(url) {
    const { data } = await $fetch.get(url, {
        headers: {
            'User-Agent': UA,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            Referer: `${appConfig.site}/`,
        },
    })

    const html = typeof data === 'string' ? data : String(data || '')
    if (/Just a moment|cf-chl-|Attention Required|Sorry, you have been blocked/i.test(html)) {
        // 交给系统浏览器完成站点验证，避免把验证页误解析成空列表。
        $utils.openSafari(url, UA)
        throw new Error('SpankBang 返回了反爬验证页，请先在 Safari 完成验证后重试')
    }
    return html
}

/**
 * 从列表页面解析视频卡片，同时兼容网站的新旧 DOM 结构。
 *
 * @param {string} html 列表页 HTML
 * @return {Array<object>} XPTV 视频卡片列表
 */
function parseVideoCards(html) {
    const cards = []
    const $ = cheerio.load(html)

    // 新版使用 data-testid/video-item 与 js-video-item，旧版使用 video-item。
    const videos = $('[data-testid="video-item"], .js-video-item, .video-item')
    videos.each((_, element) => {
        const item = $(element)
        const link = item.find('a[href*="/video/"], a.thumb').first()
        const image = item.find('picture img, img.cover, img').first()
        const href = link.attr('href') || ''
        const title = image.attr('alt') || link.attr('title') || ''
        const cover = absoluteUrl(
            image.attr('data-src') || image.attr('data-original') || image.attr('src') || ''
        )

        // 跳过广告卡片和缺少详情地址的无效节点。
        if (!href || !href.includes('/video/')) return

        const detailUrl = absoluteUrl(href)
        cards.push({
            vod_id: href,
            vod_name: title || '未命名视频',
            vod_pic: cover,
            ui: 1,
            ext: { url: detailUrl },
        })
    })

    return cards
}

/**
 * 返回媒体源配置。
 *
 * @return {string} JSON 格式配置
 */
async function getConfig() {
    return jsonify(appConfig)
}

/**
 * 获取分类列表内容。
 *
 * @param {string|object} ext XPTV 分类参数
 * @return {Promise<string>} JSON 格式卡片列表
 */
async function getCards(ext) {
    ext = argsify(ext)
    const page = ext.page || 1
    const id = ext.id || 'new_videos'
    const url = `${appConfig.site}/${id}/${page}/`
    const html = await requestPage(url)

    return jsonify({ list: parseVideoCards(html) })
}

/**
 * 获取视频清晰度列表。
 *
 * @param {string|object} ext XPTV 详情参数
 * @return {Promise<string>} JSON 格式播放线路
 */
async function getTracks(ext) {
    ext = argsify(ext)
    const url = absoluteUrl(ext.url)
    const tracks = []
    const data = await requestPage(url)

    // 从脚本中提取站点现有的 stream_data 播放信息。
    const streamDataMatch = data.match(/var stream_data\s*=\s*({[^;]+});/)
    if (streamDataMatch && streamDataMatch[1]) {
        try {
            const jsonString = streamDataMatch[1].replace(/'/g, '"')
            const streamData = JSON.parse(jsonString)
            const qualityOrder = ['240p', '320p', '480p', '720p', '1080p', '4k']

            qualityOrder.forEach((quality) => {
                if (!Array.isArray(streamData[quality]) || !streamData[quality][0]) return
                tracks.push({
                    name: quality.toUpperCase(),
                    pan: '',
                    ext: {
                        url: streamData[quality][0],
                        type: 'mp4',
                    },
                })
            })

            if (Array.isArray(streamData.m3u8) && streamData.m3u8[0]) {
                tracks.push({
                    name: 'M3U8（自适应）',
                    pan: '',
                    ext: {
                        url: streamData.m3u8[0],
                        type: 'm3u8',
                    },
                })
            }

            const defaultUrl =
                (Array.isArray(streamData.main) && streamData.main[0]) ||
                (tracks[0] && tracks[0].ext.url)
            if (defaultUrl) {
                tracks.unshift({
                    name: '自动',
                    pan: '',
                    ext: {
                        url: defaultUrl,
                        type: defaultUrl.includes('.m3u8') ? 'm3u8' : 'mp4',
                    },
                })
            }
        } catch (error) {
            // 播放数据格式变化时返回空线路，避免整个扩展崩溃。
        }
    }

    return jsonify({
        list: [
            {
                title: '视频质量',
                tracks,
            },
        ],
    })
}

/**
 * 返回播放器需要的直链和请求头。
 *
 * @param {string|object} ext XPTV 播放参数
 * @return {Promise<string>} JSON 格式播放信息
 */
async function getPlayinfo(ext) {
    ext = argsify(ext)
    return jsonify({
        urls: [ext.url],
        type: ext.type || 'mp4',
        headers: [
            {
                'User-Agent': UA,
                Referer: `${appConfig.site}/`,
            },
        ],
    })
}

/**
 * 搜索视频内容。
 *
 * @param {string|object} ext XPTV 搜索参数
 * @return {Promise<string>} JSON 格式搜索结果
 */
async function search(ext) {
    ext = argsify(ext)
    const keyword = ext.text || ext.keyword || ''
    const page = ext.page || 1
    const url = `${appConfig.site}/s/${encodeURIComponent(keyword)}/${page}/`
    const html = await requestPage(url)

    return jsonify({ list: parseVideoCards(html) })
}
