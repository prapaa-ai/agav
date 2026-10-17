#pragma once
#include <cstdint>
#if defined(_M_X64) || defined(__x86_64__)
#if defined(_MSC_VER)
#include <intrin.h>
#else
#include <cpuid.h>
#endif
#endif

namespace agav_voice {
// Pure predicate for testing every required CPU and OS state bit independently.
inline bool avx2_features(std::uint32_t leaf1_ecx, std::uint32_t leaf7_ebx,
                          std::uint64_t xcr0) {
    constexpr std::uint32_t required = (1u << 12) | (1u << 26) | (1u << 27) |
                                       (1u << 28) | (1u << 29);
    return (leaf1_ecx & required) == required && (leaf7_ebx & (1u << 5)) != 0 &&
           (xcr0 & 6) == 6;
}
inline bool supports_avx2() {
#if defined(_M_X64) || defined(__x86_64__)
    std::uint32_t ecx, ebx;
#if defined(_MSC_VER)
    int regs[4];
    __cpuidex(regs, 0, 0);
    if (regs[0] < 7) return false;
    __cpuidex(regs, 1, 0);
    ecx = static_cast<std::uint32_t>(regs[2]);
#else
    if (__get_cpuid_max(0, nullptr) < 7) return false;
    unsigned int a, b, c, d;
    __cpuid_count(1, 0, a, b, c, d);
    ecx = c;
#endif
    // XGETBV faults unless XSAVE and OSXSAVE are both present. Require all
    // leaf-1 features before executing it; no AVX instructions in this probe.
    constexpr std::uint32_t required = (1u << 12) | (1u << 26) | (1u << 27) |
                                       (1u << 28) | (1u << 29);
    if ((ecx & required) != required) return false;
    std::uint64_t xcr0;
#if defined(_MSC_VER)
    xcr0 = _xgetbv(0);
    __cpuidex(regs, 7, 0);
    ebx = static_cast<std::uint32_t>(regs[1]);
#else
    unsigned int lo, hi;
    __asm__ volatile("xgetbv" : "=a"(lo), "=d"(hi) : "c"(0));
    xcr0 = (static_cast<std::uint64_t>(hi) << 32) | lo;
    __cpuid_count(7, 0, a, b, c, d);
    ebx = b;
#endif
    return avx2_features(ecx, ebx, xcr0);
#else
    return false;
#endif
}
} // namespace agav_voice
