/*
 * Spinning textured cube on the Open746I-C's 7" LCD.
 *
 * The same board bring-up as Waveshare's LCD demo (SDRAM over the FMC, LTDC at 32 MHz from
 * PLLSAI, DMA2D), then a small software renderer: a cube rotating on three axes, drawn in
 * perspective with the photo from texture.s on every face and a lambert shade per face,
 * into one of two RGB565 framebuffers in the SDRAM while the LTDC scans out the other.
 * Faces are culled by their winding; a convex cube needs no depth sorting. Texturing is
 * perspective-correct per pixel (u/w, v/w, 1/w interpolated along the scanline).
 */
#include <math.h>
#include <stdint.h>
#include <string.h>

extern "C" {
#include "stm32f7xx_hal.h"
#include "dma.h"
#include "dma2d.h"
#include "fmc.h"
#include "gpio.h"
#include "ltdc.h"
#include "usart.h"
#include "stm32746g_sdram.h"
extern const uint16_t TEXTURE[256 * 256];
extern LTDC_HandleTypeDef hltdc;
extern DMA2D_HandleTypeDef hdma2d;
extern UART_HandleTypeDef huart1;
}

static constexpr int W = 1024;
static constexpr int H = 600;
static uint16_t *const FB[2] = {reinterpret_cast<uint16_t *>(0xD0000000), reinterpret_cast<uint16_t *>(0xD0200000)};
static constexpr uint32_t BACKGROUND = 0xFF0C0A10; // the preview's near-black, as ARGB8888 for the DMA2D

struct Vec3 {
  float x, y, z;
};

static const Vec3 CUBE[8] = {{-1, -1, -1}, {1, -1, -1}, {1, 1, -1}, {-1, 1, -1}, {-1, -1, 1}, {1, -1, 1}, {1, 1, 1}, {-1, 1, 1}};
/* Vertex indices per face in texture order: top-left, top-right, bottom-right, bottom-left as seen from outside. */
static const uint8_t FACES[6][4] = {{0, 1, 2, 3}, {5, 4, 7, 6}, {4, 5, 1, 0}, {3, 2, 6, 7}, {1, 5, 6, 2}, {4, 0, 3, 7}};
static const Vec3 LIGHT = {0.3f / 1.0f, -0.5f / 1.0f, -0.8f / 1.0f}; // normalised below

struct Vertex {
  float sx, sy; // screen
  float w;      // 1/z
  float u, v;   // texture / z
};

extern "C" void SystemClock_Config(void);

/* Fill the back buffer through the DMA2D (register-to-memory, RGB565). */
static void clear(uint16_t *fb, uint32_t colour) {
  hdma2d.Init.Mode = DMA2D_R2M;
  hdma2d.Init.ColorMode = DMA2D_RGB565;
  hdma2d.Init.OutputOffset = 0;
  HAL_DMA2D_Init(&hdma2d);
  HAL_DMA2D_Start(&hdma2d, colour, reinterpret_cast<uint32_t>(fb), W, H);
  HAL_DMA2D_PollForTransfer(&hdma2d, 100);
}

static inline uint16_t shadeTexel(uint16_t t, uint32_t shade) {
  // shade is 0..256; scale the three channels in place.
  uint32_t r = ((t >> 11) * shade) >> 8;
  uint32_t g = (((t >> 5) & 0x3f) * shade) >> 8;
  uint32_t b = ((t & 0x1f) * shade) >> 8;
  return static_cast<uint16_t>((r << 11) | (g << 5) | b);
}

/* One scanline from a to b (a.sx <= b.sx), attributes interpolated in 1/z space. */
static void span(uint16_t *fb, int y, const Vertex &a, const Vertex &b, uint32_t shade) {
  if (y < 0 || y >= H) return;
  int x0 = static_cast<int>(ceilf(a.sx));
  int x1 = static_cast<int>(ceilf(b.sx)) - 1;
  if (x0 < 0) x0 = 0;
  if (x1 >= W) x1 = W - 1;
  if (x0 > x1) return;
  float len = b.sx - a.sx;
  if (len < 1e-3f) len = 1e-3f;
  float t = (x0 + 0.5f - a.sx) / len;
  float dt = 1.0f / len;
  float w = a.w + (b.w - a.w) * t, dw = (b.w - a.w) * dt;
  float u = a.u + (b.u - a.u) * t, du = (b.u - a.u) * dt;
  float v = a.v + (b.v - a.v) * t, dv = (b.v - a.v) * dt;
  uint16_t *p = fb + y * W + x0;
  for (int x = x0; x <= x1; x++) {
    float iz = 1.0f / w;
    int tu = static_cast<int>(u * iz) & 255;
    int tv = static_cast<int>(v * iz) & 255;
    *p++ = shadeTexel(TEXTURE[tv * 256 + tu], shade);
    w += dw;
    u += du;
    v += dv;
  }
}

static inline Vertex lerp(const Vertex &a, const Vertex &b, float t) {
  return {a.sx + (b.sx - a.sx) * t, a.sy + (b.sy - a.sy) * t, a.w + (b.w - a.w) * t, a.u + (b.u - a.u) * t, a.v + (b.v - a.v) * t};
}

/* Scanline-rasterise a triangle: sort by y, walk the long edge against the two short ones. */
static void triangle(uint16_t *fb, Vertex v0, Vertex v1, Vertex v2, uint32_t shade) {
  if (v1.sy < v0.sy) { Vertex t = v0; v0 = v1; v1 = t; }
  if (v2.sy < v0.sy) { Vertex t = v0; v0 = v2; v2 = t; }
  if (v2.sy < v1.sy) { Vertex t = v1; v1 = v2; v2 = t; }
  float dy = v2.sy - v0.sy;
  if (dy < 1e-3f) return;
  int yStart = static_cast<int>(ceilf(v0.sy));
  int yEnd = static_cast<int>(ceilf(v2.sy)) - 1;
  for (int y = yStart; y <= yEnd; y++) {
    float cy = y + 0.5f;
    Vertex l = lerp(v0, v2, (cy - v0.sy) / dy);
    Vertex r;
    if (cy < v1.sy) {
      float d = v1.sy - v0.sy;
      r = lerp(v0, v1, d > 1e-3f ? (cy - v0.sy) / d : 0);
    } else {
      float d = v2.sy - v1.sy;
      r = lerp(v1, v2, d > 1e-3f ? (cy - v1.sy) / d : 0);
    }
    if (l.sx <= r.sx) span(fb, y, l, r, shade);
    else span(fb, y, r, l, shade);
  }
}

static void rotate(const Vec3 &in, float ax, float ay, float az, Vec3 &out) {
  float cx = cosf(ax), sx = sinf(ax), cy = cosf(ay), sy = sinf(ay), cz = cosf(az), sz = sinf(az);
  // Rx, then Ry, then Rz — the order of the preview.
  float y1 = in.y * cx - in.z * sx, z1 = in.y * sx + in.z * cx, x1 = in.x;
  float x2 = x1 * cy + z1 * sy, z2 = -x1 * sy + z1 * cy, y2 = y1;
  out.x = x2 * cz - y2 * sz;
  out.y = x2 * sz + y2 * cz;
  out.z = z2;
}

static void drawCube(uint16_t *fb, float t) {
  static constexpr float DIST = 4.2f;
  static constexpr float FOCAL = 620.0f;
  Vec3 p[8];
  Vertex s[8];
  for (int i = 0; i < 8; i++) {
    rotate(CUBE[i], t * 0.9f, t * 1.3f, t * 0.4f, p[i]);
    p[i].z += DIST;
    float w = 1.0f / p[i].z;
    s[i] = {W / 2 + FOCAL * p[i].x * w, H / 2 + FOCAL * p[i].y * w, w, 0, 0};
  }
  float ll = sqrtf(LIGHT.x * LIGHT.x + LIGHT.y * LIGHT.y + LIGHT.z * LIGHT.z);
  for (const auto &f : FACES) {
    const Vertex &a = s[f[0]], &b = s[f[1]], &c = s[f[2]], &d = s[f[3]];
    // Winding on screen: a face seen from outside runs clockwise in y-down coordinates.
    float area = (a.sx * b.sy - b.sx * a.sy) + (b.sx * c.sy - c.sx * b.sy) + (c.sx * d.sy - d.sx * c.sy) + (d.sx * a.sy - a.sx * d.sy);
    if (area <= 0) continue;
    // Outward normal from the rotated corners, lambert against the light.
    const Vec3 &A = p[f[0]], &B = p[f[1]], &D = p[f[3]];
    Vec3 e1 = {D.x - A.x, D.y - A.y, D.z - A.z}, e2 = {B.x - A.x, B.y - A.y, B.z - A.z};
    Vec3 n = {e1.y * e2.z - e1.z * e2.y, e1.z * e2.x - e1.x * e2.z, e1.x * e2.y - e1.y * e2.x};
    float nl = sqrtf(n.x * n.x + n.y * n.y + n.z * n.z);
    float dot = (n.x * LIGHT.x + n.y * LIGHT.y + n.z * LIGHT.z) / (nl * ll);
    if (dot < 0) dot = 0;
    uint32_t shade = static_cast<uint32_t>((0.35f + 0.65f * dot) * 256.0f);
    // Texture corners in 1/z space, then two triangles.
    Vertex q[4] = {a, b, c, d};
    const float tu[4] = {0, 255.99f, 255.99f, 0}, tv[4] = {0, 0, 255.99f, 255.99f};
    for (int i = 0; i < 4; i++) {
      q[i].u = tu[i] * q[i].w;
      q[i].v = tv[i] * q[i].w;
    }
    triangle(fb, q[0], q[1], q[2], shade);
    triangle(fb, q[0], q[2], q[3], shade);
  }
}

int main(void) {
  SCB_EnableICache();
  SCB_EnableDCache();
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_DMA_Init();
  MX_DMA2D_Init();
  MX_FMC_Init();
  MX_LTDC_Init();
  MX_USART1_UART_Init();

  HAL_GPIO_WritePin(GPIOA, GPIO_PIN_3, GPIO_PIN_RESET); // backlight PWM low: full brightness
  BSP_SDRAM_Init();
  clear(FB[0], BACKGROUND);
  clear(FB[1], BACKGROUND);
  HAL_LTDC_SetAddress(&hltdc, reinterpret_cast<uint32_t>(FB[0]), 0);
  __HAL_LTDC_ENABLE(&hltdc);

  const char hello[] = "cube: spinning textured cube on the 7inch LCD\r\n";
  HAL_UART_Transmit(&huart1, (uint8_t *)hello, sizeof hello - 1, 100);

  int back = 1;
  uint32_t frames = 0;
  for (;;) {
    // The preview advances 2*pi/72 * 0.5 per 50 ms frame: 0.873 rad/s.
    float t = HAL_GetTick() * 0.000873f;
    clear(FB[back], BACKGROUND);
    drawCube(FB[back], t);
    SCB_CleanDCache(); // the LTDC reads memory, not the cache
    HAL_LTDC_SetAddress(&hltdc, reinterpret_cast<uint32_t>(FB[back]), 0);
    back ^= 1;
    frames++;
  }
}
