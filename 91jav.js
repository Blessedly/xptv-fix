const cheerio = createCheerio()

const UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'

const headers = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
}

const appConfig = {
    ver: 2026090301,
    title: '91Jav',
    site: 'https://91jav.fun',
}

/**
 * 返回动态分类配置。
 */
async function getConfig() {
    const config = appConfig
    config.tabs = await getTabs()
    return jsonify(config)
}

/**
 * 从新版专题页解析分类名称和地址。
 */
async function getTabs() {
    const list = []
    try {
        const { data } = await $fetch.get(`${appConfig.site}/theme/count`, { headers })
        const $ = cheerio.load(data)

        $('#list_categories_categories_list .video-img-box').each((_, element) => {
            const link = $(element).find('a[href^="/theme/detail/"]').first()
            const href = link.attr('href')
            const name = link.find('h3').text().trim() || link.find('img').attr('alt') || ''
            if (!href || !name) return

            list.push({
                name,
                ext: { typeurl: href.replace(/\/$/, '') },
                ui: 1,
            })
        })
    } catch (error) {
        $print(`91Jav 分类解析失败：${error}`)
    }
    return list
}

/**
 * 将站内相对地址转换为完整 URL。
 */
function absoluteUrl(url) {
    if (!url) return ''
    if (url.startsWith('//')) return `https:${url}`
    if (/^https?:\/\//i.test(url)) return url
    return `${appConfig.site}${url.startsWith('/') ? '' : '/'}${url}`
}

/**
 * 从新版影片卡片中提取标题、海报、时长和详情地址。
 */
function parseCards(html) {
    const cards = []
    const seen = {}
    const $ = cheerio.load(html)

    $('.video-img-box').each((_, element) => {
        const box = $(element)
        const imageBox = box.find('.img-box.cover-md').first()
        const link = imageBox.find('a[href^="/videos/"]').first()
        const href = link.attr('href')
        if (!href || seen[href]) return

        const image = link.find('img.zximg').first()
        const title = image.attr('alt') || box.find('.detail .title a').text().trim()
        // 网站使用自定义懒加载属性，src 通常为空或只是占位图。
        const cover =
            image.attr('z-image-loader-url') ||
            image.attr('data-original') ||
            image.attr('data-src') ||
            image.attr('src') ||
            ''
        if (!title || !cover) return

        const duration = imageBox.find('.absolute-bottom-right .label').text().trim()
        const remarks = box.find('.detail .sub-title').text().replace(/\s+/g, ' ').trim()
        seen[href] = true
        cards.push({
            vod_id: href,
            vod_name: title,
            vod_pic: absoluteUrl(cover),
            vod_remarks: remarks,
            vod_duration: duration,
            ext: { url: absoluteUrl(href) },
        })
    })
    return cards
}

/**
 * 加载分类列表，新版分页直接在分类地址后追加页码。
 */
async function getCards(ext) {
    ext = argsify(ext)
    const page = ext.page || 1
    const typeurl = String(ext.typeurl || '').replace(/\/$/, '')
    if (!typeurl) return jsonify({ list: [] })
    const url = `${appConfig.site}${typeurl}${page > 1 ? `/${page}` : ''}`

    try {
        const { data } = await $fetch.get(url, { headers })
        return jsonify({ list: parseCards(data) })
    } catch (error) {
        $print(`91Jav 列表请求失败：${error}`)
        return jsonify({ list: [] })
    }
}

/**
 * 从详情页提取带时效签名的 m3u8 地址。
 */
async function getTracks(ext) {
    ext = argsify(ext)
    const pageUrl = ext.url
    try {
        const { data } = await $fetch.get(pageUrl, {
            headers: { ...headers, Referer: `${appConfig.site}/` },
        })
        const match = String(data).match(/var\s+hlsUrl\s*=\s*["']([^"']+)["']/i)
        if (!match || !match[1]) {
            $print('91Jav 详情页没有找到 hlsUrl')
            return jsonify({ list: [] })
        }

        return jsonify({
            list: [
                {
                    title: '默认分组',
                    tracks: [
                        {
                            name: '播放',
                            pan: '',
                            ext: { url: match[1], referer: pageUrl },
                        },
                    ],
                },
            ],
        })
    } catch (error) {
        $print(`91Jav 播放解析失败：${error}`)
        return jsonify({ list: [] })
    }
}

/**
 * 返回播放地址和媒体服务器可能校验的请求头。
 */
async function getPlayinfo(ext) {
    ext = argsify(ext)
    return jsonify({
        urls: [ext.url],
        headers: [{ 'User-Agent': UA, Referer: ext.referer || `${appConfig.site}/` }],
    })
}

/**
 * 搜索影片并复用统一卡片解析。
 */
async function search(ext) {
    ext = argsify(ext)
    const text = encodeURIComponent(ext.text || '')
    const page = ext.page || 1
    const pageSuffix = page > 1 ? `/page/${page}` : ''
    const url = `${appConfig.site}/search/index/keyword/${text}${pageSuffix}`

    try {
        const { data } = await $fetch.get(url, { headers })
        return jsonify({ list: parseCards(data) })
    } catch (error) {
        $print(`91Jav 搜索请求失败：${error}`)
        return jsonify({ list: [] })
    }
}
