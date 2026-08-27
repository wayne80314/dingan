# 定案 LINE 品牌圖片

## 完稿

| 檔案 | 用途 | 規格 |
|---|---|---|
| `dingan-profile-640.png` | LINE 官方帳號基本檔案圖片 | PNG、640 × 640 px、RGB、92 KB |
| `dingan-background-1920x1080.jpg` | LINE 官方帳號背景圖片 | JPEG、1920 × 1080 px、RGB、274 KB |

色彩沿用專案試點頁：墨綠 `#1F7A4D`、暖白 `#FAF8F5`、深墨 `#24211D`。

## 生成方式

使用 Codex 內建 `image_gen` 模式生成，再以 Sharp 裁切、縮放及壓縮成上傳規格。

### 基本檔案圖片提示

```text
Use case: logo-brand
Asset type: LINE Official Account profile image for the Taiwanese interior-design decision-recording service「定案」
Primary request: Create an original, memorable symbol that combines a precise architectural floor-plan corner or drafting grid with a confident check mark, suggesting an important design decision that has been confirmed and recorded.
Style/medium: minimal flat vector-like brand mark, refined Taiwanese design-studio sensibility, clean geometric construction, strong silhouette.
Composition/framing: exact 1:1 square; one large centered emblem; all important content inside the central circular safe area with generous padding so it survives LINE's circular crop; readable at 64 px.
Color palette: deep forest green #1F7A4D, warm ivory #FAF8F5, very small optional dark ink #24211D accent only.
Constraints: no words, no Chinese characters, no letters, no LINE logo, no speech bubble, no gradients, no 3D, no mockup, no border frame, no watermark, no tiny details. Flat solid warm-ivory background. Crisp edges and balanced negative space. Original design only.
```

### 背景圖片提示

```text
Use case: ads-marketing
Asset type: wide rectangular LINE Official Account profile background image for「定案」, a Taiwanese interior-design decision-recording service
Input images: Image 1 is a strict style and color reference for the brand emblem only; do not repeat the emblem as a giant logo.
Primary request: Create a calm, premium editorial background that connects interior design work with decisions being confirmed and recorded.
Scene/backdrop: an elegant top-down arrangement on warm ivory paper: a restrained architectural floor plan, one clean decision-card shape with a small green confirmation check, a natural oak material swatch, and one muted stone sample. Use only a few large elements.
Style/medium: sophisticated flat editorial illustration with subtle tactile paper and material texture; contemporary Taiwanese interior-design studio aesthetic.
Composition/framing: clearly landscape, approximately 16:9; keep the central 55% calm and low-detail for unpredictable LINE profile overlays and responsive cropping; place visual interest toward outer left and right thirds; every essential motif must remain visible in the central 80%; generous breathing room.
Lighting/mood: soft diffused daylight, orderly, trustworthy, calm.
Color palette: deep forest green #1F7A4D, warm ivory #FAF8F5, dark ink #24211D, muted warm wood and stone neutrals. Match Image 1.
Constraints: no readable text, no Chinese characters, no letters, no numbers, no LINE logo, no chat bubbles, no people, no rulers, no pens, no hands, no gradients, no watermark, no heavy shadows, no clutter, no photorealistic mockup. Keep floor-plan lines crisp and sparse. Do not add any brand name or slogan.
```
