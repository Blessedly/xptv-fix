const ROU_ORIGIN = 'https://rou.video'
const UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1'
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

/**
 * 生成允许 XPTV 播放器访问的响应头。
 *
 * @param {string} contentType 返回内容类型
 * @param {number} contentLength 响应体字节数
 * @param {string} cacheControl 缓存策略
 * @return {Headers} 跨域响应头
 */
function createResponseHeaders(contentType, contentLength = 0, cacheControl = 'no-store') {
    const headers = new Headers()
    headers.set('Access-Control-Allow-Origin', '*')
    headers.set('Access-Control-Allow-Headers', '*')
    headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
    headers.set('Cache-Control', cacheControl)
    headers.set('Content-Type', contentType)
    if (contentLength > 0) headers.set('Content-Length', String(contentLength))
    return headers
}

/**
 * 判断地址是否属于 Rou 播放接口或严格匹配其视频分片路径，避免形成任意开放代理。
 *
 * @param {string} value 待验证地址
 * @return {URL|null} 合法上游地址
 */
function parseAllowedUrl(value) {
    try {
        const url = new URL(value || '')
        if (url.protocol !== 'https:') return null
        if (url.hostname === 'rou.video' && url.pathname.startsWith('/api/hls/')) return url

        // 视频 CDN 域名会动态轮换，因此通过稳定且严格的 HLS 路径格式进行限制。
        const mediaPath = /^\/hls\/([a-z0-9]+)\/\1-\d+\/[a-z0-9._-]+\.png$/i
        return mediaPath.test(url.pathname) ? url : null
    } catch (_) {
        return null
    }
}

/**
 * 检查二进制内容是否具有标准 PNG 文件头。
 *
 * @param {ArrayBuffer} buffer 响应数据
 * @return {boolean} 是否为 PNG
 */
function isPng(buffer) {
    if (!buffer || buffer.byteLength < PNG_SIGNATURE.length) return false
    const bytes = new Uint8Array(buffer, 0, PNG_SIGNATURE.length)
    return PNG_SIGNATURE.every((value, index) => bytes[index] === value)
}

/**
 * 解压 PNG 中 roUd 数据块携带的真实清单或视频分片。
 *
 * @param {ArrayBuffer} buffer PNG 二进制内容
 * @return {Promise<ArrayBuffer>} 解包后的真实媒体内容
 */
async function unwrapRouPayload(buffer) {
    if (!isPng(buffer)) return buffer

    const view = new DataView(buffer)
    const bytes = new Uint8Array(buffer)
    let offset = PNG_SIGNATURE.length

    while (offset + 12 <= buffer.byteLength) {
        const length = view.getUint32(offset)
        const type = String.fromCharCode(
            bytes[offset + 4],
            bytes[offset + 5],
            bytes[offset + 6],
            bytes[offset + 7]
        )
        const dataOffset = offset + 8
        if (dataOffset + length > buffer.byteLength) break

        if (type === 'roUd') {
            const flags = bytes[dataOffset]
            const payload = buffer.slice(dataOffset + 1, dataOffset + length)
            if ((flags & 1) === 0) return payload

            // 网站使用 zlib 包装的 deflate，Worker 原生流可直接解压。
            const stream = new Response(payload).body.pipeThrough(new DecompressionStream('deflate'))
            return new Response(stream).arrayBuffer()
        }
        offset = dataOffset + length + 4
    }
    throw new Error('PNG 中没有找到 roUd 媒体数据块')
}

/**
 * 判断解包内容是否为 HLS 清单。
 *
 * @param {ArrayBuffer} buffer 解包后的数据
 * @return {boolean} 是否为 M3U8
 */
function isManifest(buffer) {
    if (!buffer || buffer.byteLength < 7) return false
    return new TextDecoder().decode(buffer.slice(0, 7)) === '#EXTM3U'
}

/**
 * 为清单中的上游地址生成 Worker 解包地址。
 *
 * @param {string} value 清单中的媒体地址
 * @param {string} sourceUrl 当前清单上游地址
 * @param {string} workerOrigin Worker 自身域名
 * @param {string} route Worker 路由名称
 * @return {string} Worker 代理地址
 */
function createProxyUrl(value, sourceUrl, workerOrigin, route = 'segment.ts') {
    const target = new URL(value, sourceUrl)
    if (!parseAllowedUrl(target.href)) {
        throw new Error(`清单包含不允许代理的媒体域名：${target.hostname}`)
    }
    return `${workerOrigin}/${route}?url=${encodeURIComponent(target.href)}`
}

/**
 * 重写 M3U8 中的分片、密钥及初始化片段地址，使后续请求继续经过解包。
 *
 * @param {string} manifest 原始 M3U8 文本
 * @param {string} sourceUrl 上游清单地址
 * @param {string} workerOrigin Worker 自身域名
 * @return {string} 重写后的 M3U8
 */
function rewriteManifest(manifest, sourceUrl, workerOrigin) {
    const originalLines = String(manifest || '').split(/\r?\n/)
    const rewrittenLines = originalLines.map((line, index) => {
            const value = line.trim()
            if (!value) return line
            if (!value.startsWith('#')) {
                // 多码率主清单指向子清单，其余普通行均为 MPEG-TS 视频分片。
                const previous = String(originalLines[index - 1] || '').trim()
                const route = previous.startsWith('#EXT-X-STREAM-INF:') ? 'manifest.m3u8' : 'segment.ts'
                return createProxyUrl(value, sourceUrl, workerOrigin, route)
            }

            return line.replace(/URI=(['"])(.*?)\1/gi, (_, quote, uri) => {
                return `URI=${quote}${createProxyUrl(uri, sourceUrl, workerOrigin, 'resource.bin')}${quote}`
            })
        })

    // 明确标记为点播并指定起始序号，避免部分原生播放器首次把清单误判为短直播。
    const insertAt = rewrittenLines[0] === '#EXTM3U' ? 1 : 0
    if (!rewrittenLines.some((line) => line.startsWith('#EXT-X-PLAYLIST-TYPE:'))) {
        rewrittenLines.splice(insertAt, 0, '#EXT-X-PLAYLIST-TYPE:VOD')
    }
    if (!rewrittenLines.some((line) => line.startsWith('#EXT-X-MEDIA-SEQUENCE:'))) {
        rewrittenLines.splice(insertAt + 1, 0, '#EXT-X-MEDIA-SEQUENCE:0')
    }
    if (!rewrittenLines.includes('#EXT-X-ENDLIST')) rewrittenLines.push('#EXT-X-ENDLIST')
    return rewrittenLines.join('\n')
}

/**
 * 根据解包后的字节特征返回合适的媒体类型。
 *
 * @param {ArrayBuffer} buffer 媒体数据
 * @return {string} MIME 类型
 */
function detectMediaType(buffer) {
    const bytes = new Uint8Array(buffer)
    if (bytes[0] === 0x47) return 'video/mp2t'
    if (
        bytes.length >= 8 &&
        String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]) === 'ftyp'
    ) {
        return 'video/mp4'
    }
    return 'application/octet-stream'
}

/**
 * 获取上游包装资源并返回解包后的清单或视频分片。
 *
 * @param {URL} target 上游资源地址
 * @param {string} workerOrigin Worker 自身域名
 * @param {string} referer 上游来源页面
 * @return {Promise<Response>} 解包响应
 */
async function proxyAndUnwrap(target, workerOrigin, referer) {
    const upstream = await fetch(target.href, {
        headers: {
            'User-Agent': UA,
            Accept: '*/*',
            Referer: referer || `${ROU_ORIGIN}/`,
            Origin: ROU_ORIGIN,
        },
        redirect: 'follow',
    })
    if (!upstream.ok) {
        return new Response(await upstream.arrayBuffer(), {
            status: upstream.status,
            headers: createResponseHeaders('text/plain; charset=utf-8'),
        })
    }

    const decoded = await unwrapRouPayload(await upstream.arrayBuffer())
    if (isManifest(decoded)) {
        const manifest = new TextDecoder().decode(decoded)
        const rewritten = rewriteManifest(manifest, upstream.url || target.href, workerOrigin)
        const contentLength = new TextEncoder().encode(rewritten).byteLength
        return new Response(rewritten, {
            headers: createResponseHeaders(
                'application/vnd.apple.mpegurl; charset=utf-8',
                contentLength,
                'no-store'
            ),
        })
    }

    return new Response(decoded, {
        // 分片地址带时效签名且内容不可变，允许播放器短时复用已经解包的数据。
        headers: createResponseHeaders(
            detectMediaType(decoded),
            decoded.byteLength,
            'public, max-age=1800, immutable'
        ),
    })
}

/**
 * 处理首个播放清单请求。
 *
 * @param {URL} requestUrl Worker 请求地址
 * @return {Promise<Response>} 解包并重写后的 M3U8
 */
async function handleManifest(requestUrl) {
    const id = requestUrl.searchParams.get('id') || ''
    if (!/^[a-z0-9]+$/i.test(id)) {
        return new Response('视频 ID 无效', {
            status: 400,
            headers: createResponseHeaders('text/plain; charset=utf-8'),
        })
    }

    const target = new URL(`/api/hls/${id}`, ROU_ORIGIN)
    const referer = `${ROU_ORIGIN}/v/${id}`
    return proxyAndUnwrap(target, requestUrl.origin, referer)
}

/**
 * 处理清单中后续的媒体分片请求。
 *
 * @param {URL} requestUrl Worker 请求地址
 * @return {Promise<Response>} 解包后的媒体分片
 */
async function handleMedia(requestUrl) {
    const target = parseAllowedUrl(requestUrl.searchParams.get('url'))
    if (!target) {
        return new Response('媒体地址无效或域名不在允许范围内', {
            status: 400,
            headers: createResponseHeaders('text/plain; charset=utf-8'),
        })
    }
    const idMatch = target.pathname.match(/^\/hls\/([a-z0-9]+)\//i)
    const referer = idMatch ? `${ROU_ORIGIN}/v/${idMatch[1]}` : `${ROU_ORIGIN}/`
    return proxyAndUnwrap(target, requestUrl.origin, referer)
}

export default {
    /**
     * Cloudflare Worker 请求入口。
     */
    async fetch(request) {
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: createResponseHeaders('text/plain; charset=utf-8'),
            })
        }

        const requestUrl = new URL(request.url)
        try {
            if (request.method === 'GET' && requestUrl.pathname === '/hls') {
                return handleManifest(requestUrl)
            }
            if (
                request.method === 'GET' &&
                ['/media', '/manifest.m3u8', '/segment.ts', '/resource.bin'].includes(requestUrl.pathname)
            ) {
                return handleMedia(requestUrl)
            }

            return Response.json({
                name: 'Rou PNG-HLS decoder',
                status: 'ok',
                routes: ['/manifest.m3u8?url=ENCODED_URL', '/segment.ts?url=ENCODED_URL'],
            })
        } catch (error) {
            return new Response(`解包失败：${String(error && error.message ? error.message : error)}`, {
                status: 502,
                headers: createResponseHeaders('text/plain; charset=utf-8'),
            })
        }
    },
}
