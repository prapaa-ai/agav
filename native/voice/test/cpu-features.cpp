#include "../cpu-features.h"
#include <initializer_list>
#include <cstdlib>
void check(bool value) { if (!value) std::abort(); }
int main() {
    constexpr unsigned required = (1u << 12) | (1u << 26) | (1u << 27) | (1u << 28) | (1u << 29);
    check(agav_voice::avx2_features(required, 1u << 5, 6));
    for (unsigned bit : {12u, 26u, 27u, 28u, 29u})
        check(!agav_voice::avx2_features(required & ~(1u << bit), 1u << 5, 6));
    check(!agav_voice::avx2_features(required, 0, 6));
    for (unsigned state = 0; state < 6; ++state)
        check(!agav_voice::avx2_features(required, 1u << 5, state));
#if !defined(_M_X64) && !defined(__x86_64__)
    check(!agav_voice::supports_avx2());
#else
    (void)agav_voice::supports_avx2();
#endif
}
