const UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'

// 删除大小写不同的旧 User-Agent，避免同一个请求出现两个值导致签名校验失败。
const headers = { ...$request.headers }
Object.keys(headers).forEach((name) => {
    if (name.toLowerCase() === 'user-agent') delete headers[name]
})
headers['User-Agent'] = UA

$done({ headers })
