const cheerio = createCheerio()

const UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'

const headers = {
    'User-Agent': UA,
    'Accept-Language': 'zh-CN,zh;q=0.9',
}

const appConfig = {
    ver: 2026090302,
    title: '桃花族',
    // 556862.xyz 已把所有分类重定向到首页，当前有效域名为 556863.xyz
    site: 'https://556863.xyz',
}

/**
 * 返回客户端配置及网站当前分类。
 */
async function getConfig() {
    const config = appConfig
    config.tabs = await getTabs()
    return jsonify(config)
}

/**
 * 从首页解析分类菜单。
 */
async function getTabs() {
    const list = []

    try {
        const { data } = await $fetch.get(appConfig.site, { headers })
        const $ = cheerio.load(data)

        $('.stui-pannel__menu li').each((_, element) => {
            const link = $(element).find('a')
            const href = link.attr('href')
            if (!href) return

            const span = link.find('span').text()
            list.push({
                name: link.text().replace(span, '').trim(),
                ext: { typeurl: href },
                ui: 1,
            })
        })
    } catch (error) {
        $print(`桃花族分类解析失败：${error}`)
    }

    return list
}

/**
 * 把相对地址转换为可供客户端直接访问的完整地址。
 */
function absoluteUrl(url) {
    if (!url) return ''
    if (url.startsWith('//')) return `https:${url}`
    if (/^https?:\/\//i.test(url)) return url
    return `${appConfig.site}${url.startsWith('/') ? '' : '/'}${url}`
}

/**
 * 从分类页提取影片列表和海报。
 */
async function getCards(ext) {
    ext = argsify(ext)
    const cards = []
    const { page = 1, typeurl } = ext
    const url = `${appConfig.site}${typeurl}`.replace('.html', `-${page}.html`)

    try {
        const { data } = await $fetch.get(url, { headers })
        const $ = cheerio.load(data)

        $('.stui-vodlist li').each((_, element) => {
            const thumb = $(element).find('.stui-vodlist__thumb').first()
            const href = thumb.attr('href')

            // 同时兼容旧版 /vodplay 和新版 /v5/ 播放页地址。
            if (
                !href ||
                (!href.startsWith('/vodplay') && !href.startsWith('/v5/'))
            ) {
                return
            }

            const title = thumb.attr('title') || $(element).find('h4.title a').text().trim()
            const cover = thumb.attr('data-original') || thumb.attr('data-src') || thumb.attr('src')
            const duration = $(element).find('.pic-text').text().trim()
            cards.push({
                vod_id: href,
                vod_name: title,
                vod_pic: absoluteUrl(cover),
                vod_remarks: duration,
                vod_duration: duration,
                ext: { url: absoluteUrl(href) },
            })
        })
    } catch (error) {
        $print(`桃花族列表解析失败：${error}`)
    }

    return jsonify({ list: cards })
}

/**
 * 解码播放接口返回的 Base64 地址。
 */
function decodeBase64(text) {
    // 播放地址仅包含 ASCII 字符，内置解码可避免依赖客户端 CryptoJS 版本。
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    const clean = String(text || '').replace(/[^A-Za-z0-9+/=]/g, '')
    let result = ''
    for (let index = 0; index < clean.length; index += 4) {
        const a = alphabet.indexOf(clean[index])
        const b = alphabet.indexOf(clean[index + 1])
        const c = clean[index + 2] === '=' ? -1 : alphabet.indexOf(clean[index + 2])
        const d = clean[index + 3] === '=' ? -1 : alphabet.indexOf(clean[index + 3])
        result += String.fromCharCode((a << 2) | (b >> 4))
        if (c >= 0) result += String.fromCharCode(((b & 15) << 4) | (c >> 2))
        if (d >= 0) result += String.fromCharCode(((c & 3) << 6) | d)
    }
    return result
}

/**
 * 从新版播放页提取动态参数，并调用播放地址接口。
 */
async function getTracks(ext) {
    ext = argsify(ext)
    const tracks = []
    const pageUrl = ext.url

    try {
        const { data } = await $fetch.get(pageUrl, { headers })
        const pick = (name) => {
            const match = String(data).match(new RegExp(`${name}='([^']+)'`))
            return match ? match[1] : ''
        }
        const id = pick('AID')
        const sid = pick('ASID')
        const nid = pick('ANID')
        const token = pick('AK')
        if (!id || !sid || !nid || !token) {
            throw new Error('播放页缺少 AID/ASID/ANID/AK 参数')
        }

        // 新站通过该接口返回 Base64 编码的真实 m3u8 地址。
        const response = await $fetch.post(
            `${appConfig.site}/static/count.php`,
            {
                id,
                sid,
                nid,
                tk: token,
                g: 1,
                x: 120,
                y: 300,
                dt: 6500,
                sw: 390,
                sh: 844,
                tz: -480,
                t: Date.now(),
            },
            {
                headers: {
                    ...headers,
                    Referer: pageUrl,
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'X-Requested-With': 'XMLHttpRequest',
                },
            },
        )

        let result = response.data
        if (typeof result === 'string') {
            // 优先使用标准 JSON 解析，并兼容客户端提供的 argsify。
            try {
                result = JSON.parse(result)
            } catch (_) {
                result = argsify(result)
            }
        }
        if (!result || !result.ok || !result.u) {
            throw new Error(`播放接口返回异常：${JSON.stringify(result)}`)
        }
        const playUrl = decodeBase64(result.u)
        tracks.push({
            name: '播放',
            pan: '',
            ext: { url: playUrl },
        })
    } catch (error) {
        $print(`桃花族播放解析失败：${error}`)
    }

    return jsonify({
        list: tracks.length ? [{ title: '默认分组', tracks }] : [],
    })
}

/**
 * 返回播放器最终使用的媒体地址及必要请求头。
 */
async function getPlayinfo(ext) {
    ext = argsify(ext)
    return jsonify({
        urls: [ext.url],
        headers: [{ 'User-Agent': UA, Referer: appConfig.site }],
    })
}

/**
 * 搜索影片并兼容新版 /v5/ 地址。
 */
async function search(ext) {
    ext = argsify(ext)
    const cards = []
    const text = encodeURIComponent(ext.text || '')
    const page = ext.page || 1
    const url = `${appConfig.site}/vodsearch/${text}----------${page}---.html`

    try {
        const { data } = await $fetch.get(url, { headers })
        const $ = cheerio.load(data)

        $('.stui-vodlist li').each((_, element) => {
            const thumb = $(element).find('.stui-vodlist__thumb').first()
            const href = thumb.attr('href')
            if (
                !href ||
                (!href.startsWith('/vodplay') && !href.startsWith('/v5/'))
            ) {
                return
            }

            const title = thumb.attr('title') || $(element).find('h4.title a').text().trim()
            const cover = thumb.attr('data-original') || thumb.attr('data-src') || thumb.attr('src')
            const duration = $(element).find('.pic-text').text().trim()
            cards.push({
                vod_id: href,
                vod_name: title,
                vod_pic: absoluteUrl(cover),
                vod_remarks: duration,
                vod_duration: duration,
                ext: { url: absoluteUrl(href) },
            })
        })
    } catch (error) {
        $print(`桃花族搜索失败：${error}`)
    }

    return jsonify({ list: cards })
}
