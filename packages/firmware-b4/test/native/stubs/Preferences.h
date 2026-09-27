// Host stub for ESP32 Preferences (NVS): an in-memory key/value store, so the
// calibration table's save/load round trip can be tested without flash.
#pragma once
#include <map>
#include <string>
#include <vector>
#include <stddef.h>
#include <string.h>

namespace nvs_stub {
inline std::map<std::string, std::vector<unsigned char>> &store() {
  static std::map<std::string, std::vector<unsigned char>> s;
  return s;
}
}  // namespace nvs_stub

class Preferences {
 public:
  bool begin(const char *ns, bool /*readOnly*/) { ns_ = ns; return true; }
  void end() {}
  size_t getBytesLength(const char *key) {
    auto it = nvs_stub::store().find(ns_ + "/" + key);
    return it == nvs_stub::store().end() ? 0 : it->second.size();
  }
  size_t getBytes(const char *key, void *buf, size_t len) {
    auto it = nvs_stub::store().find(ns_ + "/" + key);
    if (it == nvs_stub::store().end() || it->second.size() > len) return 0;
    memcpy(buf, it->second.data(), it->second.size());
    return it->second.size();
  }
  size_t putBytes(const char *key, const void *buf, size_t len) {
    const unsigned char *p = static_cast<const unsigned char *>(buf);
    nvs_stub::store()[ns_ + "/" + key] = std::vector<unsigned char>(p, p + len);
    return len;
  }

 private:
  std::string ns_;
};
