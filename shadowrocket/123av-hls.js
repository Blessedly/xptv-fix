const requestUrl = String($request.url || '')
const isResponse = typeof $response !== 'undefined'
const headers = { ...(isResponse ? $response.headers : $request.headers) }

/**
 * 不区分大小写设置响应头，避免同时保留两份同名字段。
 *
 * @param {object} targetHeaders 请求或响应头
 * @param {string} name 字段名称
 * @param {string} value 字段值
 */
function setHeader(targetHeaders, name, value) {
    for (const key of Object.keys(targetHeaders)) {
        if (key.toLowerCase() === name.toLowerCase()) delete targetHeaders[key]
    }
    targetHeaders[name] = value
}

if (isResponse) {
    // javplayer.cc 把 TS 分片伪装成网页静态资源，恢复类型后交给 iOS 原生播放器。
    if (/\.m3u8(?:[?#]|$)/i.test(requestUrl)) {
        setHeader(headers, 'Content-Type', 'application/vnd.apple.mpegurl')
    } else {
        setHeader(headers, 'Content-Type', 'video/mp2t')
    }
} else {
    // 确保主清单、子清单及每次分片重连都具有相同的防盗链请求头。
    setHeader(
        headers,
        'User-Agent',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
    )
    setHeader(headers, 'Referer', 'https://javplayer.cc/')
    setHeader(headers, 'Origin', 'https://javplayer.cc')
    setHeader(headers, 'Accept', /\.m3u8(?:[?#]|$)/i.test(requestUrl) ? 'application/vnd.apple.mpegurl,*/*' : '*/*')
}

$done({ headers })
