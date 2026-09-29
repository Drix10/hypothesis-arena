#include "http_curl.hpp"

#include <curl/curl.h>

#include <cstdlib>
#include <cstring>
#include <string>

namespace jev {
namespace broker {
namespace {

const char* kPaperBase = "https://paper-api.alpaca.markets";
const char* kDataBase = "https://data.alpaca.markets";
const long kConnectMs = 5000;
const long kTotalMs = 10000;
const size_t kRestMax = 256 * 1024;
const size_t kDataMax = 4 * 1024 * 1024;

struct Sink {
    std::string* buf;
    size_t cap;
    bool overflow;
};

size_t OnBody(char* p, size_t sz, size_t n, void* ud) {
    Sink* s = static_cast<Sink*>(ud);
    size_t k = sz * n;
    if (s->buf->size() + k >= s->cap) {
        s->overflow = true;
        return 0;  // aborts the transfer
    }
    s->buf->append(p, k);
    return k;
}

bool SafePath(const char* p, const char* prefix) {
    if (!p || std::strncmp(p, prefix, std::strlen(prefix)) != 0) return false;
    for (const char* c = p; *c; ++c) {
        bool ok = (*c >= 'a' && *c <= 'z') || (*c >= 'A' && *c <= 'Z') ||
                  (*c >= '0' && *c <= '9') || std::strchr("/_-.:?=&,%~", *c);
        if (!ok) return false;
    }
    return std::strlen(p) < 1024;
}

bool SafeHeaderValue(const char* v) {
    if (!v || !*v || std::strlen(v) > 256) return false;
    for (const char* c = v; *c; ++c)
        if (static_cast<unsigned char>(*c) < 0x21 ||
            static_cast<unsigned char>(*c) > 0x7e)
            return false;
    return true;
}

// One request to a fixed Alpaca host. Any refusal or transport error is
// false; a returned status is the HTTP code of a completed exchange.
bool Perform(const char* base, const char* prefix, const char* method,
             const char* path, const char* body, size_t max, int* status,
             std::string* out) {
    out->clear();
    *status = 0;
    const char* key = std::getenv("ALPACA_KEY_ID");
    const char* sec = std::getenv("ALPACA_SECRET");
    if (!method || !SafePath(path, prefix) || !SafeHeaderValue(key) ||
        !SafeHeaderValue(sec))
        return false;
    bool post = std::strcmp(method, "POST") == 0;
    if (!post && std::strcmp(method, "GET") != 0 &&
        std::strcmp(method, "DELETE") != 0)
        return false;

    static bool inited = (curl_global_init(CURL_GLOBAL_DEFAULT) == CURLE_OK);
    if (!inited) return false;
    CURL* h = curl_easy_init();
    if (!h) return false;

    std::string url = std::string(base) + path;
    std::string k = std::string("APCA-API-KEY-ID: ") + key;
    std::string s = std::string("APCA-API-SECRET-KEY: ") + sec;
    struct curl_slist* hdr = nullptr;
    hdr = curl_slist_append(hdr, k.c_str());
    hdr = curl_slist_append(hdr, s.c_str());
    hdr = curl_slist_append(hdr, "Accept: application/json");
    if (post) hdr = curl_slist_append(hdr, "Content-Type: application/json");

    Sink sink{out, max, false};
    curl_easy_setopt(h, CURLOPT_URL, url.c_str());
    curl_easy_setopt(h, CURLOPT_HTTPHEADER, hdr);
    curl_easy_setopt(h, CURLOPT_CUSTOMREQUEST, method);
    if (post) curl_easy_setopt(h, CURLOPT_POSTFIELDS, body ? body : "");
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
        out->clear();
        return false;
    }
    *status = static_cast<int>(code);
    return true;
}

}  // namespace

HttpResult CurlTransport(const HttpRequest& req) {
    HttpResult out;
    out.status = 0;
    out.body[0] = '\0';
    std::string body;
    int status = 0;
    if (!Perform(kPaperBase, "/v2/", req.method, req.path, req.body,
                 sizeof(out.body), &status, &body))
        return out;
    std::memcpy(out.body, body.data(), body.size());
    out.body[body.size()] = '\0';
    out.status = status;
    return out;
}

bool CurlRest(const char* method, const std::string& path,
              const std::string& body, int* status, std::string* out) {
    return Perform(kPaperBase, "/v2/", method, path.c_str(), body.c_str(),
                   kRestMax, status, out);
}

bool CurlData(const std::string& path, std::string* out) {
    int status = 0;
    return Perform(kDataBase, "/v2/stocks/", "GET", path.c_str(), "", kDataMax,
                   &status, out) &&
           status == 200;
}

}  // namespace broker
}  // namespace jev
