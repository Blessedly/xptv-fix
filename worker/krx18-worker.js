const PLAY_HOST = 'play.playkrx18.site'
const UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'

/**
 * 生成允许 XPTV 调用的跨域响应头。
 */
function createCorsHeaders(contentType) {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Cache-Control': 'no-store',
        'Content-Type': contentType,
    }
}

/**
 * 验证播放器页面地址，避免 Worker 被当成开放代理。
 */
function parsePlayerUrl(value) {
    try {
        const url = new URL(value || '')
        return url.protocol === 'https:' &&
            url.hostname === PLAY_HOST &&
            url.pathname.startsWith('/play/')
            ? url
            : null
    } catch (_) {
        return null
    }
}

/**
 * 验证 KRX18 详情页来源地址。
 */
function parseDetailUrl(value) {
    try {
        const url = new URL(value || '')
        return url.protocol === 'https:' && /(^|\.)krx18\.com$/i.test(url.hostname) ? url : null
    } catch (_) {
        return null
    }
}

/**
 * 验证播放器加密 API 地址。
 */
function parsePlayApiUrl(value) {
    try {
        const url = new URL(value || '')
        return url.protocol === 'https:' &&
            url.hostname.endsWith('.playkrx18.site') &&
            url.pathname.endsWith('/playiframe')
            ? url
            : null
    } catch (_) {
        return null
    }
}

/**
 * 验证播放接口返回的 HLS 清单地址。
 */
function parsePlaylistUrl(value) {
    try {
        const url = new URL(value || '')
        return url.protocol === 'https:' &&
            url.hostname.endsWith('.playkrx18.site') &&
            url.pathname.startsWith('/m3u8/')
            ? url
            : null
    } catch (_) {
        return null
    }
}

/**
 * 将 HLS 清单中的相对媒体地址转换为手机可直连的完整地址。
 */
function absolutizePlaylist(text, sourceUrl) {
    return String(text || '')
        .split(/\r?\n/)
        .map((line) => {
            const value = line.trim()
            if (!value) return line
            if (!value.startsWith('#')) return new URL(value, sourceUrl).href

            // 密钥或初始化片段也只转换为上游绝对地址，不包装成 Worker 地址。
            return line.replace(/URI=(['"])(.*?)\1/gi, (_, quote, uri) => {
                return `URI=${quote}${new URL(uri, sourceUrl).href}${quote}`
            })
        })
        .join('\n')
}

/**
 * 代取带防盗链校验的播放器 HTML 页面。
 */
async function handlePlayerPage(requestUrl) {
    const targetUrl = parsePlayerUrl(requestUrl.searchParams.get('url'))
    const refererUrl = parseDetailUrl(requestUrl.searchParams.get('referer'))
    if (!targetUrl || !refererUrl) {
        return new Response('播放器地址或来源地址无效', { status: 400 })
    }

    // Worker 只代取小型播放器页面，不读取或转发任何视频分片。
    const upstream = await fetch(targetUrl.href, {
        headers: {
            'User-Agent': UA,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            Referer: refererUrl.href,
            Origin: refererUrl.origin,
            'Sec-Fetch-Dest': 'iframe',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'cross-site',
        },
        redirect: 'follow',
    })
    return new Response(await upstream.text(), {
        status: upstream.status,
        headers: createCorsHeaders('text/html; charset=utf-8'),
    })
}

/**
 * 代发播放器的加密接口请求。
 */
async function handlePlayApi(request, requestUrl) {
    const targetUrl = parsePlayApiUrl(requestUrl.searchParams.get('url'))
    const refererUrl = parsePlayerUrl(requestUrl.searchParams.get('referer'))
    if (!targetUrl || !refererUrl) {
        return new Response('播放 API 或来源地址无效', { status: 400 })
    }

    // 原样转发 XPTV 生成的加密表单，Worker 不解密也不保存其中的数据。
    const body = await request.arrayBuffer()
    const upstream = await fetch(targetUrl.href, {
        method: 'POST',
        headers: {
            'User-Agent': UA,
            Accept: 'application/json, text/javascript, */*; q=0.01',
            Referer: refererUrl.href,
            Origin: refererUrl.origin,
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
        },
        body,
        redirect: 'follow',
    })
    return new Response(await upstream.text(), {
        status: upstream.status,
        headers: createCorsHeaders('application/json; charset=utf-8'),
    })
}

/**
 * 代取与播放接口出口绑定的 M3U8 文本清单。
 */
async function handlePlaylist(requestUrl) {
    const targetUrl = parsePlaylistUrl(requestUrl.searchParams.get('url'))
    const refererUrl = parsePlayerUrl(requestUrl.searchParams.get('referer'))
    if (!targetUrl || !refererUrl) {
        return new Response('播放清单或来源地址无效', { status: 400 })
    }

    // 这里只读取文本清单；清单中的 MPEG-TS 视频地址仍由手机直接访问。
    const upstream = await fetch(targetUrl.href, {
        headers: {
            'User-Agent': UA,
            Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*',
            Referer: refererUrl.href,
            Origin: refererUrl.origin,
        },
        redirect: 'follow',
    })
    const text = await upstream.text()
    return new Response(upstream.ok ? absolutizePlaylist(text, targetUrl.href) : text, {
        status: upstream.status,
        headers: createCorsHeaders('application/vnd.apple.mpegurl; charset=utf-8'),
    })
}

export default {
    /**
     * Cloudflare Worker 请求入口。
     */
    async fetch(request) {
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: createCorsHeaders('text/plain; charset=utf-8'),
            })
        }

        const url = new URL(request.url)
        if (request.method === 'GET' && url.pathname === '/player-page') {
            return handlePlayerPage(url)
        }
        if (request.method === 'POST' && url.pathname === '/play-api') {
            return handlePlayApi(request, url)
        }
        if (request.method === 'GET' && url.pathname === '/playlist') {
            return handlePlaylist(url)
        }

        return Response.json({
            name: 'KRX18 control proxy',
            status: 'ok',
            mediaProxy: false,
        })
    },
}
