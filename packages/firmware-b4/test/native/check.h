// A test harness in twenty lines: no framework to install on a bench laptop.
#pragma once
#include <cstdio>
#include <cstdlib>

static int g_failures = 0;
static int g_checks = 0;

#define CHECK(cond)                                                          \
  do {                                                                       \
    ++g_checks;                                                              \
    if (!(cond)) {                                                           \
      ++g_failures;                                                          \
      std::fprintf(stderr, "  FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); \
    }                                                                        \
  } while (0)

#define TEST(name) static void name()
#define RUN(name) (std::printf("- %s\n", #name), name())

static int finish(const char *suite) {
  std::printf("%s: %d checks, %d failed\n", suite, g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
