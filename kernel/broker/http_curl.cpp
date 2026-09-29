#include "http_curl.hpp"

#include <curl/curl.h>

#include <cstdlib>
#include <cstring>

namespace jev {
namespace broker {
namespace {

const char* kBase = "https://paper-api.alpaca.markets";
const long kConnectMs = 5000;
const long kTotalMs = 10000;

struct Sink {
    char* buf;
    size_t cap;
    size_t len;
    bool overflow;
};

size_t OnBody(char* p, size_t sz, size_t n, void* ud) {
    Sink* s = static_cast<Sink*>(ud);
    size_t k = sz * n;
    if (s->len + k >= s->cap) {
        s->overflow = true;
        return 0;  // aborts the transfer
    }
    std::memcpy(s->buf + s->len, p, k);
    s->len += k;
    return k;
}

bool SafePath(const char* p) {
    if (!p || std::strncmp(p, "/v2/", 4) != 0) return false;
    for (const char* c = p; *c; ++c) {
        bool ok = (*c >= 'a' && *c <= 'z') || (*c >= 'A' && *c <= 'Z') ||
                  (*c >= '0' && *c <= '9') || std::strchr("/_-.:?=&", *c);
        if (!ok) return false;
    }
    return std::strlen(p) < 512;
}

bool SafeHeaderValue(const char* v) {
    if (!v || !*v || std::strlen(v) > 256) return false;
    for (const char* c = v; *c; ++c)
        if (static_cast<unsigned char>(*c) < 0x21 ||
            static_cast<unsigned char>(*c) > 0x7e)
            return false;
    return true;
}

}  // namespace

HttpResult CurlTransport(const HttpRequest& req) {
    HttpResult out;
    out.status = 0;
    out.body[0] = '\0';
    const char* key = std::getenv("ALPACA_KEY_ID");
    const char* sec = std::getenv("ALPACA_SECRET");
    if (!req.method || !SafePath(req.path) || !SafeHeaderValue(key) ||
        !SafeHeaderValue(sec))
        return out;
    bool post = std::strcmp(req.method, "POST") == 0;
    if (!post && std::strcmp(req.method, "GET") != 0 &&
        std::strcmp(req.method, "DELETE") != 0)
        return out;

    static bool inited = (curl_global_init(CURL_GLOBAL_DEFAULT) == CURLE_OK);
    if (!inited) return out;
    CURL* h = curl_easy_init();
    if (!h) return out;

    char url[640];
    std::snprintf(url, sizeof(url), "%s%s", kBase, req.path);
    char k[320], s[320];
    std::snprintf(k, sizeof(k), "APCA-API-KEY-ID: %s", key);
    std::snprintf(s, sizeof(s), "APCA-API-SECRET-KEY: %s", sec);
    struct curl_slist* hdr = nullptr;
    hdr = curl_slist_append(hdr, k);
    hdr = curl_slist_append(hdr, s);
    hdr = curl_slist_append(hdr, "Accept: application/json");
    if (post) hdr = curl_slist_append(hdr, "Content-Type: application/json");

    Sink sink{out.body, sizeof(out.body), 0, false};
    curl_easy_setopt(h, CURLOPT_URL, url);
    curl_easy_setopt(h, CURLOPT_HTTPHEADER, hdr);
    curl_easy_setopt(h, CURLOPT_CUSTOMREQUEST, req.method);
    if (post) {
        curl_easy_setopt(h, CURLOPT_POSTFIELDS, req.body ? req.body : "");
    }
    curl_easy_setopt(h, CURLOPT_WRITEFUNCTION, OnBody);
    curl_easy_setopt(h, CURLOPT_WRITEDATA, &sink);
    curl_easy_setopt(h, CURLOPT_FOLLOWLOCATION, 0L);
    curl_easy_setopt(h, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(h, CURLOPT_SSL_VERIFYHOST, 2L);
    curl_easy_setopt(h, CURLOPT_CONNECTTIMEOUT_MS, kConnectMs);
    curl_easy_setopt(h, CURLOPT_TIMEOUT_MS, kTotalMs);
    curl_easy_setopt(h, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(h, CURLOPT_PROTOCOLS_STR, "https");

    CURLcode rc = curl_easy_perform(h);
    long code = 0;
    curl_easy_getinfo(h, CURLINFO_RESPONSE_CODE, &code);
    curl_slist_free_all(hdr);
    curl_easy_cleanup(h);
    if (rc != CURLE_OK || sink.overflow) {
        out.body[0] = '\0';
        return out;
    }
    out.body[sink.len] = '\0';
    out.status = static_cast<int>(code);
    return out;
}

}  // namespace broker
}  // namespace jev
