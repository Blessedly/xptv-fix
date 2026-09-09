const PLAYER_HOST = 'recordplay.biz'
const UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'

/**
 * 生成允许 XPTV 调用且禁止缓存的响应头。
 *
 * @param {string} contentType 响应内容类型
 * @return {object} Worker 响应头
 */
function createHeaders(contentType) {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Cache-Control': 'no-store',
        'Content-Type': contentType,
    }
}

/**
 * 校验 recordplay 播放器地址，避免 Worker 成为开放代理。
 *
 * @param {string} value 待校验地址
 * @return {URL|null} 合法播放器地址
 */
function parsePlayerUrl(value) {
    try {
        const url = new URL(value || '')
        return url.protocol === 'https:' &&
            url.hostname === PLAYER_HOST &&
            url.pathname.startsWith('/e/')
            ? url
            : null
    } catch (_) {
        return null
    }
}

/**
 * 校验 SexBJCam 详情页地址。
 *
 * @param {string} value 待校验地址
 * @return {URL|null} 合法详情页地址
 */
function parseDetailUrl(value) {
    try {
        const url = new URL(value || '')
        return url.protocol === 'https:' && /(^|\.)sexbjcam\.com$/i.test(url.hostname) ? url : null
    } catch (_) {
        return null
    }
}

/**
 * 代取 XPTV 直接访问时会卡住的播放器 HTML。
 *
 * @param {URL} requestUrl Worker 请求地址
 * @return {Promise<Response>} 播放器页面响应
 */
async function handlePlayerPage(requestUrl) {
    const targetUrl = parsePlayerUrl(requestUrl.searchParams.get('url'))
    const refererUrl = parseDetailUrl(requestUrl.searchParams.get('referer'))
    if (!targetUrl || !refererUrl) {
        return new Response('播放器地址或来源地址无效', {
            status: 400,
            headers: createHeaders('text/plain; charset=utf-8'),
        })
    }

    // 模拟详情页中的跨站 iframe；只获取小型 HTML，不中转 M3U8 或视频分片。
    const upstream = await fetch(targetUrl.href, {
        headers: {
            'User-Agent': UA,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
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
        headers: createHeaders('text/html; charset=utf-8'),
    })
}

export default {
    /**
     * Cloudflare Worker 请求入口。
     *
     * @param {Request} request 客户端请求
     * @return {Promise<Response>} Worker 响应
     */
    async fetch(request) {
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: createHeaders('text/plain; charset=utf-8'),
            })
        }

        const url = new URL(request.url)
        if (request.method === 'GET' && url.pathname === '/player-page') {
            return handlePlayerPage(url)
        }

        return Response.json({
            name: 'SexBJCam player proxy',
            status: 'ok',
            mediaProxy: false,
        })
    },
}
