#include "ws_stream.hpp"

#include <curl/curl.h>

#include <sys/select.h>

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <random>

#include "../jev_validate.hpp"

namespace jev {
namespace broker {
namespace {

const size_t kMaxMessage = 64 * 1024;
const size_t kMaxPending = 64 * 1024;
const int kMaxBackoffS = 60;
const int kAuthBackoffS = 300;  // refused credentials: do not hammer the venue

bool TokenOk(const char* v) {
    if (!v || !*v || std::strlen(v) > 128) return false;
    for (const char* c = v; *c; ++c) {
        bool ok = (*c >= 'a' && *c <= 'z') || (*c >= 'A' && *c <= 'Z') ||
                  (*c >= '0' && *c <= '9') || *c == '_' || *c == '-';
        if (!ok) return false;
    }
    return true;
}

const JVal* Get(const JVal& o, const char* k) {
    if (o.t != JVal::T::OBJ) return nullptr;
    std::u32string key;
    for (const char* p = k; *p; ++p) key.push_back((char32_t)(unsigned char)*p);
    return o.find(key);
}

bool Str(const JVal* v, std::string* out) {
    if (!v || v->t != JVal::T::STR) return false;
    *out = U32ToUtf8(v->s);
    return true;
}

bool Word(const std::string& s, size_t max) {
    if (s.empty() || s.size() > max) return false;
    for (char c : s)
        if (!((c >= 'a' && c <= 'z') || c == '_')) return false;
    return true;
}

bool Digits(const std::string& s) {
    if (s.empty() || s.size() > 12) return false;
    for (char c : s)
        if (c < '0' || c > '9') return false;
    return true;
}

}  // namespace

bool TradeStream::ToSse(const std::string& message, std::string* sse) {
    JVal root;
    std::string err;
    if (message.size() > kMaxMessage || !ParseJson(message, root, err)) return false;
    std::string stream;
    if (!Str(Get(root, "stream"), &stream) || stream != "trade_updates")
        return false;
    const JVal* data = Get(root, "data");
    std::string ev, cid, qty;
    if (!data || !Str(Get(*data, "event"), &ev) || !Word(ev, 32)) return false;
    const JVal* order = Get(*data, "order");
    if (!order || !Str(Get(*order, "client_order_id"), &cid) || cid.empty() ||
        cid.size() > 64)
        return false;
    for (char c : cid)
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
              (c >= '0' && c <= '9') || c == '_' || c == '-'))
            return false;
    std::string body = "{\"order\":{\"client_order_id\":\"" + cid + "\"";
    // Cumulative filled quantity, whole shares only; anything else leaves the
    // field out and the runner reconciles over REST.
    if (Str(Get(*order, "filled_qty"), &qty)) {
        size_t dot = qty.find('.');
        std::string whole = dot == std::string::npos ? qty : qty.substr(0, dot);
        bool frac_zero = true;
        if (dot != std::string::npos)
            for (size_t i = dot + 1; i < qty.size(); ++i)
                if (qty[i] != '0') frac_zero = false;
        if (Digits(whole) && frac_zero)
            body += ",\"filled_qty\":\"" + whole + "\"";
    }
    body += "}}";
    *sse = "event: " + ev + "\ndata: " + body + "\n\n";
    return true;
}

namespace {

std::string Base64(const unsigned char* d, size_t n) {
    static const char* t =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string o;
    for (size_t i = 0; i < n; i += 3) {
        unsigned v = d[i] << 16;
        if (i + 1 < n) v |= d[i + 1] << 8;
        if (i + 2 < n) v |= d[i + 2];
        o += t[(v >> 18) & 63];
        o += t[(v >> 12) & 63];
        o += i + 1 < n ? t[(v >> 6) & 63] : '=';
        o += i + 2 < n ? t[v & 63] : '=';
    }
    return o;
}

// Client frames are always masked (RFC 6455 5.3).
std::string BuildFrame(int opcode, const std::string& payload) {
    std::string f;
    f += (char)(0x80 | opcode);
    size_t n = payload.size();
    if (n < 126) {
        f += (char)(0x80 | n);
    } else {
        f += (char)(0x80 | 126);
        f += (char)((n >> 8) & 0xFF);
        f += (char)(n & 0xFF);
    }
    std::random_device rd;
    unsigned char mask[4];
    for (int i = 0; i < 4; ++i) mask[i] = (unsigned char)(rd() & 0xFF);
    f.append((const char*)mask, 4);
    for (size_t i = 0; i < n; ++i) f += (char)(payload[i] ^ mask[i & 3]);
    return f;
}

}  // namespace

TradeStream::TradeStream() { next_try_ = std::chrono::steady_clock::now(); }

TradeStream::~TradeStream() { Close(0); }

int TradeStream::Thunk(void* self, char* buf, int n) {
    return static_cast<TradeStream*>(self)->Read(buf, n);
}

void TradeStream::Close(int backoff_s) {
    if (h_) {
        curl_easy_cleanup(h_);
        h_ = nullptr;
    }
    state_ = kDown;
    frag_.clear();
    rbuf_.clear();
    skip_ = 0;
    if (backoff_s > 0)
        next_try_ = std::chrono::steady_clock::now() +
                    std::chrono::seconds(backoff_s);
}

bool TradeStream::SendRaw(const std::string& bytes) {
    if (!h_) return false;
    size_t off = 0;
    for (int spins = 0; off < bytes.size() && spins < 50; ++spins) {
        size_t sent = 0;
        CURLcode rc = curl_easy_send(h_, bytes.data() + off, bytes.size() - off,
                                     &sent);
        if (rc == CURLE_OK) {
            off += sent;
        } else if (rc == CURLE_AGAIN) {
            curl_socket_t s = CURL_SOCKET_BAD;
            curl_easy_getinfo(h_, CURLINFO_ACTIVESOCKET, &s);
            if (s == CURL_SOCKET_BAD) return false;
            fd_set w;
            FD_ZERO(&w);
            FD_SET(s, &w);
            struct timeval tv = {0, 200000};
            select((int)s + 1, nullptr, &w, nullptr, &tv);
        } else {
            return false;
        }
    }
    return off == bytes.size();
}

bool TradeStream::Send(int opcode, const std::string& payload) {
    return SendRaw(BuildFrame(opcode, payload));
}

bool TradeStream::Connect() {
    const char* key = std::getenv("ALPACA_KEY_ID");
    const char* sec = std::getenv("ALPACA_SECRET");
    if (!TokenOk(key) || !TokenOk(sec)) return false;
    static bool inited = (curl_global_init(CURL_GLOBAL_DEFAULT) == CURLE_OK);
    if (!inited) return false;
    h_ = curl_easy_init();
    if (!h_) return false;
    std::string url = "https://paper-api.alpaca.markets/stream";
#ifdef G0_TEST_BASE
    // The test build never reaches the real host: no mock URL, no stream.
    const char* tb = std::getenv("G0_TEST_WS_BASE");
    if (!tb) {
        curl_easy_cleanup(h_);
        h_ = nullptr;
        return false;
    }
    url = tb;
    curl_easy_setopt(h_, CURLOPT_PROTOCOLS_STR, "http,https");
#else
    curl_easy_setopt(h_, CURLOPT_PROTOCOLS_STR, "https");
#endif
    curl_easy_setopt(h_, CURLOPT_URL, url.c_str());
    curl_easy_setopt(h_, CURLOPT_CONNECT_ONLY, 1L);
    curl_easy_setopt(h_, CURLOPT_CONNECTTIMEOUT_MS, 3000L);
    curl_easy_setopt(h_, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(h_, CURLOPT_SSL_VERIFYHOST, 2L);
    curl_easy_setopt(h_, CURLOPT_FOLLOWLOCATION, 0L);
    curl_easy_setopt(h_, CURLOPT_NOSIGNAL, 1L);
    if (curl_easy_perform(h_) != CURLE_OK) return false;
    size_t p = url.find("://");
    std::string rest = p == std::string::npos ? url : url.substr(p + 3);
    size_t slash = rest.find('/');
    std::string host = rest.substr(0, slash);
    std::string path = slash == std::string::npos ? "/" : rest.substr(slash);
    std::random_device rd;
    unsigned char k[16];
    for (int i = 0; i < 16; ++i) k[i] = (unsigned char)(rd() & 0xFF);
    std::string req = "GET " + path + " HTTP/1.1\r\nHost: " + host +
                      "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                      "Sec-WebSocket-Key: " + Base64(k, 16) +
                      "\r\nSec-WebSocket-Version: 13\r\n\r\n";
    state_ = kAwaitUpgrade;
    return SendRaw(req);
}

void TradeStream::OnMessage(const std::string& msg) {
    JVal root;
    std::string err, stream;
    if (msg.size() > kMaxMessage || !ParseJson(msg, root, err)) {
        ++dropped_;
        return;
    }
    if (!Str(Get(root, "stream"), &stream)) {
        ++dropped_;
        return;
    }
    if (stream == "authorization") {
        std::string status;
        const JVal* d = Get(root, "data");
        if (d && Str(Get(*d, "status"), &status) && status == "authorized" &&
            state_ == kAwaitAuth) {
            if (Send(1, "{\"action\":\"listen\",\"data\":{\"streams\":"
                        "[\"trade_updates\"]}}"))
                state_ = kAwaitListen;
            else
                Close(backoff_s_);
        } else {
            Close(kAuthBackoffS);  // refused: stop retrying quickly
        }
    } else if (stream == "listening") {
        if (state_ == kAwaitListen) {
            state_ = kLive;
            backoff_s_ = 2;
        }
    } else if (stream == "trade_updates") {
        std::string sse;
        if (state_ == kLive && ToSse(msg, &sse)) {
            if (pending_.size() + sse.size() <= kMaxPending)
                pending_ += sse;
            else
                ++dropped_;  // the runner reconciles over REST
        } else {
            ++dropped_;
        }
    }
}

// Consumes complete frames from rbuf_. False = protocol error (close).
bool TradeStream::Parse() {
    for (;;) {
        if (skip_ > 0) {
            size_t k = std::min<uint64_t>(skip_, rbuf_.size());
            rbuf_.erase(0, k);
            skip_ -= k;
            if (skip_ > 0) return true;
        }
        if (rbuf_.size() < 2) return true;
        const unsigned char* b = (const unsigned char*)rbuf_.data();
        bool fin = b[0] & 0x80;
        int op = b[0] & 0x0F;
        if (b[0] & 0x70) return false;   // reserved bits: no extensions
        if (b[1] & 0x80) return false;   // servers never mask
        uint64_t len = b[1] & 0x7F;
        size_t hdr = 2;
        if (len == 126) {
            if (rbuf_.size() < 4) return true;
            len = ((uint64_t)b[2] << 8) | b[3];
            hdr = 4;
        } else if (len == 127) {
            if (rbuf_.size() < 10) return true;
            len = 0;
            for (int i = 0; i < 8; ++i) len = (len << 8) | b[2 + i];
            hdr = 10;
        }
        bool control = op >= 8;
        if (control && (len > 125 || !fin)) return false;
        if (!control && len > kMaxMessage) {
            // Too large to keep: discard this frame's payload and its message.
            ++dropped_;
            frag_.clear();
            oversize_ = !fin;
            rbuf_.erase(0, hdr);
            skip_ = len;
            continue;
        }
        if (rbuf_.size() < hdr + len) return true;
        std::string payload = rbuf_.substr(hdr, (size_t)len);
        rbuf_.erase(0, hdr + (size_t)len);
        if (op == 8) return false;                     // close
        if (op == 9) {                                 // ping -> pong
            if (!Send(10, payload)) return false;
            continue;
        }
        if (op == 10) continue;                        // pong
        if (op != 0 && op != 1 && op != 2) return false;
        if (op != 0) {
            oversize_ = false;
            frag_.clear();
        } else if (oversize_) {
            if (fin) oversize_ = false;
            continue;
        }
        if (frag_.size() + payload.size() > kMaxMessage) {
            ++dropped_;
            frag_.clear();
            oversize_ = !fin;
            continue;
        }
        frag_ += payload;
        if (fin) {
            std::string m;
            m.swap(frag_);
            OnMessage(m);
        }
    }
}

int TradeStream::Read(char* buf, int n) {
    if (!buf || n <= 0) return 0;
    if (pending_.empty()) {
        if (state_ == kDown) {
            if (std::chrono::steady_clock::now() < next_try_) return 0;
            ++reconnects_;
            if (!Connect()) {
                Close(backoff_s_);
                backoff_s_ = std::min(backoff_s_ * 2, kMaxBackoffS);
                return 0;
            }
        }
        char chunk[4096];
        for (int i = 0; i < 64 && h_; ++i) {  // bounded per call
            size_t got = 0;
            CURLcode rc = curl_easy_recv(h_, chunk, sizeof(chunk), &got);
            if (rc == CURLE_AGAIN) break;
            if (rc != CURLE_OK || got == 0) {  // error or peer closed
                Close(backoff_s_);
                backoff_s_ = std::min(backoff_s_ * 2, kMaxBackoffS);
                break;
            }
            rbuf_.append(chunk, got);
            if (state_ == kAwaitUpgrade) {
                size_t e = rbuf_.find("\r\n\r\n");
                if (e == std::string::npos) {
                    if (rbuf_.size() > 8192) Close(backoff_s_);
                    continue;
                }
                bool ok = rbuf_.compare(0, 12, "HTTP/1.1 101") == 0;
                rbuf_.erase(0, e + 4);
                if (!ok) {
                    Close(kAuthBackoffS);
                    break;
                }
                state_ = kAwaitAuth;
                const char* key = std::getenv("ALPACA_KEY_ID");
                const char* sec = std::getenv("ALPACA_SECRET");
                if (!Send(1, std::string("{\"action\":\"auth\",\"key\":\"") +
                                 key + "\",\"secret\":\"" + sec + "\"}")) {
                    Close(backoff_s_);
                    break;
                }
            }
            if (state_ != kAwaitUpgrade && !Parse()) {
                Close(backoff_s_);
                backoff_s_ = std::min(backoff_s_ * 2, kMaxBackoffS);
                break;
            }
        }
    }
    int k = (int)std::min<size_t>((size_t)n, pending_.size());
    if (k > 0) {
        std::memcpy(buf, pending_.data(), (size_t)k);
        pending_.erase(0, (size_t)k);
    }
    return k;
}

}  // namespace broker
}  // namespace jev
