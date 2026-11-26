"""生成 GitHub Social preview 图（1280x640）—— 修正版：网格改用带 alpha 的叠加层。"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 1280, 640
TEXT = (230, 237, 243)
MUTED = (139, 148, 158)
ACCENT = (88, 166, 255)
GREEN = (63, 185, 80)
CHIP_BG = (28, 37, 50)

# ── 背景：竖直渐变 ──
base = Image.new("RGB", (W, H), (13, 17, 23))
d = ImageDraw.Draw(base)
for y in range(H):
    k = y / H
    d.line([(0, y), (W, y)], fill=(int(13 + 12 * k), int(17 + 16 * k), int(23 + 22 * k)))

# ── 两处柔光（高斯模糊后叠加）──
glow = Image.new("RGB", (W, H), (0, 0, 0))
gd = ImageDraw.Draw(glow)
gd.ellipse([-300, -260, 460, 360], fill=(30, 58, 96))
gd.ellipse([820, 300, 1560, 980], fill=(16, 62, 58))
glow = glow.filter(ImageFilter.GaussianBlur(120))
base = Image.blend(base, Image.new("RGB", (W, H), (0, 0, 0)), 0.0)
from PIL import ImageChops
base = ImageChops.add(base, glow.point(lambda v: int(v * 0.55)))

# ── 网格：RGBA 叠加，alpha 只有 12 ──
grid = Image.new("RGBA", (W, H), (0, 0, 0, 0))
gr = ImageDraw.Draw(grid)
for x in range(0, W + 1, 40):
    gr.line([(x, 0), (x, H)], fill=(255, 255, 255, 12))
for y in range(0, H + 1, 40):
    gr.line([(0, y), (W, y)], fill=(255, 255, 255, 12))
img = Image.alpha_composite(base.convert("RGBA"), grid).convert("RGB")
d = ImageDraw.Draw(img)

F = "C:/Windows/Fonts/"
f_kicker = ImageFont.truetype(F + "seguisb.ttf", 21)
f_title = ImageFont.truetype(F + "msyhbd.ttc", 72)
f_latin = ImageFont.truetype(F + "segoeuib.ttf", 30)
f_sub = ImageFont.truetype(F + "msyh.ttc", 28)
f_point = ImageFont.truetype(F + "msyhbd.ttc", 26)
f_pointsub = ImageFont.truetype(F + "msyh.ttc", 22)
f_chip = ImageFont.truetype(F + "segoeui.ttf", 22)
f_mono = ImageFont.truetype(F + "consola.ttf", 20)
f_badge = ImageFont.truetype(F + "seguisb.ttf", 24)

# 顶部 kicker
d.text((72, 70), "DEEPSEEK HARNESS  ·  PLUGIN", font=f_kicker, fill=ACCENT)

# 主标题 + 英文
d.text((68, 104), "配置备份与同步", font=f_title, fill=TEXT)
d.text((72, 196), "Config Backup & Sync", font=f_latin, fill=(150, 160, 175))

# 流程线
d.text((72, 244), "本机  →  仓库  →  云端  →  另一台机器", font=f_sub, fill=(203, 213, 225))

# 分隔线
d.line([(72, 312), (1208, 312)], fill=(45, 55, 72), width=2)

# 三条卖点
points = [
    ("12 组内容", "profile · 提示词 · Skills · 预设 · 插件数据 · 会话"),
    ("Git 或 WebDAV", "自有远端；配置与技能只有一份，机器身份在 machines/"),
    ("退出后执行", "覆盖前先留底；浏览器剖面与凭据库三处硬拦"),
]
y = 344
for title, sub in points:
    d.ellipse([76, y + 10, 90, y + 24], fill=GREEN)
    d.text((106, y), title, font=f_point, fill=TEXT)
    tx = 106 + int(d.textlength(title, font=f_point)) + 20
    d.text((tx, y + 5), sub, font=f_pointsub, fill=MUTED)
    y += 50

# 底部 chip
chips = ["Windows", "macOS", "Linux", "PowerShell", "Node engine"]
x = 72
cy = 552
for c in chips:
    w = int(d.textlength(c, font=f_chip)) + 32
    d.rounded_rectangle([x, cy, x + w, cy + 40], radius=20, fill=CHIP_BG, outline=(50, 62, 82), width=1)
    d.text((x + 16, cy + 9), c, font=f_chip, fill=(201, 209, 217))
    x += w + 12

# 右上角版本徽标
badge = "v0.6.40"
bw = int(d.textlength(badge, font=f_badge)) + 34
d.rounded_rectangle([W - 72 - bw, 66, W - 72, 112], radius=23, fill=(20, 44, 30), outline=(46, 160, 67), width=2)
d.text((W - 72 - bw + 17, 76), badge, font=f_badge, fill=(126, 231, 135))

# 右下角仓库地址
repo = "github.com/huanyu-a/dsh-profile-config-sync"
rw = int(d.textlength(repo, font=f_mono))
d.text((W - 72 - rw, H - 66), repo, font=f_mono, fill=(120, 128, 140))

out = "C:/Users/WIN11/AppData/Local/Temp/social-preview.png"
img.save(out, "PNG", optimize=True)
print(out, img.size)

