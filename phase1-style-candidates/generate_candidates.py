from __future__ import annotations

import json
import math
import random
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent
RESAMPLING = Image.Resampling.LANCZOS
TAU = math.tau
RNG_SEED = 20261119

FONT_CANDIDATES = [
    Path("C:/Windows/Fonts/msyh.ttc"),
    Path("C:/Windows/Fonts/msyhbd.ttc"),
    Path("C:/Windows/Fonts/simhei.ttf"),
    Path("C:/Windows/Fonts/arial.ttf"),
]
FONT_BOLD_CANDIDATES = [
    Path("C:/Windows/Fonts/msyhbd.ttc"),
    Path("C:/Windows/Fonts/msyh.ttc"),
    Path("C:/Windows/Fonts/simhei.ttf"),
]


def get_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = FONT_BOLD_CANDIDATES if bold else FONT_CANDIDATES
    for path in candidates:
        if path.exists():
            return ImageFont.truetype(str(path), size=max(1, int(size)))
    return ImageFont.load_default()


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def mix(c1, c2, t: float):
    return tuple(int(round(lerp(c1[i], c2[i], t))) for i in range(len(c1)))


def rgba(c):
    return tuple(c) if len(c) == 4 else tuple(c) + (255,)


def multi_gradient(size, colors, horizontal=False):
    w, h = size
    length = w if horizontal else h
    strip = Image.new("RGBA", (length, 1) if horizontal else (1, length))
    draw = ImageDraw.Draw(strip)
    stops = len(colors) - 1
    for i in range(length):
        u = 0 if length <= 1 else i / (length - 1)
        pos = min(stops - 1, int(u * stops)) if stops > 1 else 0
        local = (u * stops) - pos if stops else 0
        color = mix(rgba(colors[pos]), rgba(colors[pos + 1]), local)
        if horizontal:
            draw.point((i, 0), fill=color)
        else:
            draw.point((0, i), fill=color)
    return strip.resize(size, Image.Resampling.BILINEAR)


class Art:
    def __init__(self, width: int, height: int, ss: int = 2, base: Image.Image | None = None):
        self.w = width
        self.h = height
        self.ss = ss
        if base is None:
            self.image = Image.new("RGBA", (width * ss, height * ss), (0, 0, 0, 0))
        else:
            self.image = base.convert("RGBA").resize((width * ss, height * ss), RESAMPLING)
        self.draw = ImageDraw.Draw(self.image)

    def _p(self, point):
        return tuple(int(round(v * self.ss)) for v in point)

    def _b(self, box):
        return tuple(int(round(v * self.ss)) for v in box)

    def ellipse(self, box, fill=None, outline=None, width=1):
        self.draw.ellipse(self._b(box), fill=fill, outline=outline, width=max(1, int(width * self.ss)))

    def rectangle(self, box, fill=None, outline=None, width=1):
        self.draw.rectangle(self._b(box), fill=fill, outline=outline, width=max(1, int(width * self.ss)))

    def rounded_rectangle(self, box, radius, fill=None, outline=None, width=1):
        self.draw.rounded_rectangle(
            self._b(box), radius=max(1, int(radius * self.ss)), fill=fill, outline=outline,
            width=max(1, int(width * self.ss))
        )

    def polygon(self, points, fill=None, outline=None, width=1):
        pts = [self._p(p) for p in points]
        self.draw.polygon(pts, fill=fill)
        if outline:
            self.draw.line(pts + [pts[0]], fill=outline, width=max(1, int(width * self.ss)), joint="curve")

    def line(self, points, fill, width=1, joint="curve"):
        self.draw.line([self._p(p) for p in points], fill=fill, width=max(1, int(width * self.ss)), joint=joint)

    def arc(self, box, start, end, fill, width=1):
        self.draw.arc(self._b(box), start=start, end=end, fill=fill, width=max(1, int(width * self.ss)))

    def pieslice(self, box, start, end, fill=None, outline=None, width=1):
        self.draw.pieslice(self._b(box), start=start, end=end, fill=fill, outline=outline, width=max(1, int(width * self.ss)))

    def text(self, xy, text, size, fill, anchor="la", bold=False, stroke_width=0, stroke_fill=None):
        self.draw.text(
            self._p(xy), text, font=get_font(int(size * self.ss), bold), fill=fill, anchor=anchor,
            stroke_width=int(stroke_width * self.ss), stroke_fill=stroke_fill
        )

    def composite(self, other: "Art" | Image.Image):
        image = other.image if isinstance(other, Art) else other.convert("RGBA")
        if image.size != self.image.size:
            image = image.resize(self.image.size, RESAMPLING)
        self.image = Image.alpha_composite(self.image, image)
        self.draw = ImageDraw.Draw(self.image)

    def finish(self):
        if self.ss == 1:
            return self.image.copy()
        return self.image.resize((self.w, self.h), RESAMPLING)


def add_radial_glow(art: Art, cx, cy, radius, color, strength=150):
    layer = Art(art.w, art.h, art.ss)
    steps = 22
    for i in range(steps, 0, -1):
        r = radius * i / steps
        a = int(strength * (1 - i / (steps + 1)) ** 1.7)
        layer.ellipse((cx - r, cy - r, cx + r, cy + r), fill=tuple(color[:3]) + (a,))
    layer.image = layer.image.filter(ImageFilter.GaussianBlur(max(1, int(radius * art.ss * 0.04))))
    art.composite(layer)


def add_stars(art: Art, seed, count, area, colors, size_range=(2, 7), alpha=220):
    rng = random.Random(seed)
    x0, y0, x1, y1 = area
    for _ in range(count):
        x, y = rng.uniform(x0, x1), rng.uniform(y0, y1)
        r = rng.uniform(*size_range)
        color = rng.choice(colors)
        draw_star(art, x, y, r, tuple(color[:3]) + (alpha,), points=rng.choice([4, 5, 6]))


def draw_star(art: Art, cx, cy, r, fill, points=5, rotation=-math.pi / 2):
    coords = []
    for i in range(points * 2):
        rr = r if i % 2 == 0 else r * 0.42
        angle = rotation + i * math.pi / points
        coords.append((cx + math.cos(angle) * rr, cy + math.sin(angle) * rr))
    art.polygon(coords, fill=fill)


def draw_paw(art: Art, x, y, s, color, outline=None):
    art.ellipse((x - 0.48*s, y - 0.18*s, x + 0.48*s, y + 0.55*s), fill=color, outline=outline, width=max(1, s*0.08))
    for dx, dy, rr in [(-0.48, -0.48, .23), (-.16, -.64, .22), (.19, -.64, .22), (.5, -.45, .21)]:
        art.ellipse((x+(dx-rr)*s, y+(dy-rr)*s, x+(dx+rr)*s, y+(dy+rr)*s), fill=color, outline=outline, width=max(1, s*0.07))


def draw_bow(art: Art, x, y, s, color, center):
    art.polygon([(x, y), (x-1.15*s, y-.72*s), (x-1.0*s, y+.72*s)], fill=color)
    art.polygon([(x, y), (x+1.15*s, y-.72*s), (x+1.0*s, y+.72*s)], fill=color)
    art.ellipse((x-.35*s, y-.35*s, x+.35*s, y+.35*s), fill=center)


def draw_fish(art: Art, x, y, s, color, accent):
    art.ellipse((x-s, y-.52*s, x+.52*s, y+.52*s), fill=color)
    art.polygon([(x+.42*s, y), (x+1.18*s, y-.62*s), (x+1.18*s, y+.62*s)], fill=accent)
    art.ellipse((x-.55*s, y-.15*s, x-.35*s, y+.05*s), fill=(30,35,50,230))


def draw_coin(art: Art, x, y, s, color=(255,205,70,255), accent=(255,244,175,255)):
    art.ellipse((x-s, y-s, x+s, y+s), fill=color, outline=accent, width=max(1, s*.18))
    draw_paw(art, x, y+.05*s, s*.62, accent)


def draw_lantern(art: Art, x, y, s, color=(226,54,48,255), gold=(255,205,75,255)):
    art.line([(x, y-1.45*s), (x, y-1.0*s)], fill=gold, width=.16*s)
    art.rounded_rectangle((x-.72*s,y-1.0*s,x+.72*s,y+.78*s), .28*s, fill=color, outline=gold, width=.12*s)
    art.line([(x-.65*s,y-.2*s),(x+.65*s,y-.2*s)], fill=gold, width=.1*s)
    art.line([(x,y+.78*s),(x,y+1.25*s)], fill=gold, width=.13*s)
    art.line([(x-.3*s,y+1.25*s),(x,y+.85*s),(x+.3*s,y+1.25*s)], fill=gold, width=.1*s)


def draw_cloud(art: Art, x, y, s, color):
    art.ellipse((x-1.2*s,y-.4*s,x-.25*s,y+.5*s), fill=color)
    art.ellipse((x-.65*s,y-.9*s,x+.4*s,y+.5*s), fill=color)
    art.ellipse((x+.05*s,y-.55*s,x+1.1*s,y+.5*s), fill=color)
    art.rounded_rectangle((x-1.15*s,y,x+1.12*s,y+.62*s), .3*s, fill=color)


def draw_flask(art: Art, x, y, s, liquid, glass=(225,248,255,235)):
    art.line([(x-.25*s,y-1.05*s),(x-.25*s,y-.25*s),(x-.85*s,y+.92*s)], fill=glass, width=.16*s)
    art.line([(x+.25*s,y-1.05*s),(x+.25*s,y-.25*s),(x+.85*s,y+.92*s)], fill=glass, width=.16*s)
    art.line([(x-.85*s,y+.92*s),(x+.85*s,y+.92*s)], fill=glass, width=.16*s)
    art.rounded_rectangle((x-.3*s,y-1.22*s,x+.3*s,y-1.0*s), .08*s, fill=glass)
    art.pieslice((x-.72*s,y-.2*s,x+.72*s,y+1.02*s), 0, 180, fill=liquid)
    art.ellipse((x-.55*s,y+.1*s,x-.25*s,y+.4*s), fill=(255,255,255,130))


def draw_shield(art: Art, x, y, s, color, accent):
    pts = [(x,y-1.2*s),(x+.95*s,y-.82*s),(x+.78*s,y+.42*s),(x,y+1.25*s),(x-.78*s,y+.42*s),(x-.95*s,y-.82*s)]
    art.polygon(pts, fill=color, outline=accent, width=.13*s)
    draw_paw(art,x,y-.03*s,s*.46,accent)


def role_palette(role):
    return {
        "warrior": dict(fur=(236,145,74,255), light=(255,221,168,255), dark=(84,48,45,255), accent=(220,66,47,255), accent2=(255,204,74,255)),
        "magical": dict(fur=(139,120,224,255), light=(229,218,255,255), dark=(49,39,91,255), accent=(102,73,205,255), accent2=(100,224,244,255)),
        "cleric": dict(fur=(247,233,199,255), light=(255,250,233,255), dark=(84,71,75,255), accent=(46,164,154,255), accent2=(255,205,91,255)),
        "ninja": dict(fur=(78,86,119,255), light=(177,190,215,255), dark=(28,31,55,255), accent=(114,71,170,255), accent2=(67,220,224,255)),
        "alchemist": dict(fur=(182,128,89,255), light=(246,216,170,255), dark=(65,53,55,255), accent=(56,168,123,255), accent2=(180,247,108,255)),
        "executive": dict(fur=(218,160,101,255), light=(255,226,185,255), dark=(55,62,82,255), accent=(39,92,141,255), accent2=(232,181,76,255)),
        "fisher": dict(fur=(198,151,104,255), light=(251,223,177,255), dark=(64,72,72,255), accent=(48,133,145,255), accent2=(245,188,78,255)),
        "playful": dict(fur=(244,164,185,255), light=(255,232,237,255), dark=(100,67,89,255), accent=(112,180,207,255), accent2=(255,204,88,255)),
    }[role]


def draw_cat_character(art: Art, cx, cy, scale, role, bob=0, blink=False, phase=0.0):
    p = role_palette(role)
    cy += bob
    add_radial_glow(art, cx, cy-25*scale, 135*scale, p["accent2"], 70)
    # Tail and body behind the face.
    art.arc((cx+40*scale, cy+28*scale, cx+150*scale, cy+155*scale), 255, 105, fill=p["dark"], width=22*scale)
    art.ellipse((cx-68*scale,cy+20*scale,cx+72*scale,cy+177*scale), fill=p["fur"], outline=p["dark"], width=5*scale)
    art.ellipse((cx-47*scale,cy+62*scale,cx+48*scale,cy+164*scale), fill=p["light"])
    art.ellipse((cx-64*scale,cy+139*scale,cx-5*scale,cy+185*scale), fill=p["fur"], outline=p["dark"], width=4*scale)
    art.ellipse((cx+5*scale,cy+139*scale,cx+64*scale,cy+185*scale), fill=p["fur"], outline=p["dark"], width=4*scale)
    # Ears and head.
    art.polygon([(cx-74*scale,cy-53*scale),(cx-53*scale,cy-132*scale),(cx-8*scale,cy-65*scale)], fill=p["fur"], outline=p["dark"], width=5*scale)
    art.polygon([(cx+74*scale,cy-53*scale),(cx+53*scale,cy-132*scale),(cx+8*scale,cy-65*scale)], fill=p["fur"], outline=p["dark"], width=5*scale)
    art.polygon([(cx-57*scale,cy-69*scale),(cx-50*scale,cy-111*scale),(cx-25*scale,cy-72*scale)], fill=(244,156,151,255))
    art.polygon([(cx+57*scale,cy-69*scale),(cx+50*scale,cy-111*scale),(cx+25*scale,cy-72*scale)], fill=(244,156,151,255))
    art.ellipse((cx-79*scale,cy-84*scale,cx+79*scale,cy+58*scale), fill=p["fur"], outline=p["dark"], width=5*scale)
    art.ellipse((cx-36*scale,cy-5*scale,cx+36*scale,cy+55*scale), fill=p["light"])
    # Eyes and expression.
    if blink:
        art.arc((cx-48*scale,cy-36*scale,cx-14*scale,cy-5*scale), 15, 165, fill=p["dark"], width=5*scale)
        art.arc((cx+14*scale,cy-36*scale,cx+48*scale,cy-5*scale), 15, 165, fill=p["dark"], width=5*scale)
    else:
        art.ellipse((cx-47*scale,cy-39*scale,cx-17*scale,cy-4*scale), fill=p["dark"])
        art.ellipse((cx+17*scale,cy-39*scale,cx+47*scale,cy-4*scale), fill=p["dark"])
        art.ellipse((cx-38*scale,cy-32*scale,cx-28*scale,cy-20*scale), fill=(255,255,255,245))
        art.ellipse((cx+26*scale,cy-32*scale,cx+36*scale,cy-20*scale), fill=(255,255,255,245))
    art.polygon([(cx,cy+2*scale),(cx-9*scale,cy+12*scale),(cx+9*scale,cy+12*scale)], fill=(176,87,98,255))
    art.arc((cx-22*scale,cy+5*scale,cx,cy+31*scale), 0, 120, fill=p["dark"], width=3*scale)
    art.arc((cx,cy+5*scale,cx+22*scale,cy+31*scale), 60, 180, fill=p["dark"], width=3*scale)
    for side in (-1,1):
        art.line([(cx+side*20*scale,cy+18*scale),(cx+side*82*scale,cy+5*scale)], fill=p["dark"], width=2*scale)
        art.line([(cx+side*20*scale,cy+26*scale),(cx+side*84*scale,cy+31*scale)], fill=p["dark"], width=2*scale)
    # Role-specific equipment.
    if role == "warrior":
        art.pieslice((cx-82*scale,cy-118*scale,cx+82*scale,cy-28*scale),180,360,fill=(113,56,54,255),outline=p["accent2"],width=5*scale)
        art.polygon([(cx,cy-139*scale),(cx-18*scale,cy-103*scale),(cx+18*scale,cy-103*scale)],fill=p["accent"],outline=p["accent2"],width=3*scale)
        draw_shield(art,cx-91*scale,cy+85*scale,42*scale,p["accent"],p["accent2"])
        art.line([(cx+75*scale,cy+122*scale),(cx+125*scale,cy-15*scale)],fill=(223,233,241,255),width=9*scale)
        art.polygon([(cx+125*scale,cy-32*scale),(cx+112*scale,cy-3*scale),(cx+136*scale,cy+5*scale)],fill=(245,247,249,255))
    elif role == "magical":
        art.polygon([(cx-87*scale,cy-72*scale),(cx+55*scale,cy-147*scale),(cx+35*scale,cy-61*scale)],fill=p["accent"],outline=p["accent2"],width=4*scale)
        art.rounded_rectangle((cx-92*scale,cy-72*scale,cx+78*scale,cy-50*scale),10*scale,fill=p["dark"],outline=p["accent2"],width=3*scale)
        art.line([(cx+75*scale,cy+128*scale),(cx+124*scale,cy-20*scale)],fill=(105,77,75,255),width=9*scale)
        draw_star(art,cx+127*scale,cy-31*scale,24*scale,p["accent2"],6)
        for a in (phase, phase+TAU/3, phase+2*TAU/3):
            draw_star(art,cx+math.cos(a)*108*scale,cy-32*scale+math.sin(a)*65*scale,8*scale,(235,247,255,230),4)
    elif role == "cleric":
        art.ellipse((cx-62*scale,cy-138*scale,cx+62*scale,cy-112*scale),outline=p["accent2"],width=8*scale)
        art.polygon([(cx-42*scale,cy+33*scale),(cx,cy+115*scale),(cx+42*scale,cy+33*scale)],fill=(255,249,225,245),outline=p["accent2"],width=3*scale)
        draw_paw(art,cx,cy+69*scale,18*scale,p["accent"])
        art.line([(cx+82*scale,cy+137*scale),(cx+98*scale,cy-45*scale)],fill=(175,130,71,255),width=9*scale)
        art.ellipse((cx+75*scale,cy-72*scale,cx+121*scale,cy-26*scale),fill=p["accent2"],outline=(255,251,225,255),width=4*scale)
        draw_paw(art,cx+98*scale,cy-49*scale,12*scale,(255,251,225,255))
    elif role == "ninja":
        art.rounded_rectangle((cx-77*scale,cy-48*scale,cx+77*scale,cy+2*scale),18*scale,fill=p["dark"])
        art.line([(cx-63*scale,cy-38*scale),(cx+63*scale,cy-38*scale)],fill=p["accent2"],width=4*scale)
        art.polygon([(cx+72*scale,cy-43*scale),(cx+145*scale,cy-72*scale),(cx+99*scale,cy-18*scale)],fill=p["accent"])
        art.line([(cx-91*scale,cy+127*scale),(cx-121*scale,cy+14*scale)],fill=(191,212,222,255),width=8*scale)
        art.line([(cx+91*scale,cy+127*scale),(cx+121*scale,cy+14*scale)],fill=(191,212,222,255),width=8*scale)
    elif role == "alchemist":
        art.ellipse((cx-66*scale,cy-57*scale,cx-5*scale,cy+1*scale),outline=(95,70,49,255),width=8*scale)
        art.ellipse((cx+5*scale,cy-57*scale,cx+66*scale,cy+1*scale),outline=(95,70,49,255),width=8*scale)
        art.line([(cx-5*scale,cy-28*scale),(cx+5*scale,cy-28*scale)],fill=(95,70,49,255),width=7*scale)
        draw_flask(art,cx+96*scale,cy+75*scale,34*scale,p["accent2"])
        art.rounded_rectangle((cx-73*scale,cy+63*scale,cx-34*scale,cy+130*scale),8*scale,fill=(105,75,50,255),outline=p["accent2"],width=3*scale)
    elif role == "executive":
        art.polygon([(cx-55*scale,cy+35*scale),(cx,cy+112*scale),(cx+55*scale,cy+35*scale)],fill=(35,54,78,255))
        art.polygon([(cx-12*scale,cy+45*scale),(cx,cy+95*scale),(cx+12*scale,cy+45*scale)],fill=p["accent2"])
        art.rounded_rectangle((cx-110*scale,cy+100*scale,cx-65*scale,cy+145*scale),7*scale,fill=(91,59,37,255),outline=p["accent2"],width=3*scale)
    elif role == "fisher":
        art.pieslice((cx-87*scale,cy-112*scale,cx+87*scale,cy-42*scale),180,360,fill=(218,181,103,255),outline=p["dark"],width=4*scale)
        art.line([(cx+74*scale,cy+138*scale),(cx+142*scale,cy-105*scale)],fill=(102,69,45,255),width=7*scale)
        art.arc((cx+64*scale,cy-116*scale,cx+190*scale,cy+105*scale),270,74,fill=(235,238,224,220),width=2*scale)
        draw_fish(art,cx-98*scale,cy+116*scale,21*scale,(84,177,186,255),(245,194,84,255))
    elif role == "playful":
        draw_bow(art,cx,cy-91*scale,27*scale,p["accent"],p["accent2"])
        art.rounded_rectangle((cx-48*scale,cy+45*scale,cx+48*scale,cy+116*scale),18*scale,fill=(255,238,244,245),outline=p["accent"],width=3*scale)
        draw_paw(art,cx,cy+80*scale,18*scale,p["accent"])


CHAT_SPECS = {
    "cute_cat_1": {"name":"闲趣小猫","description":"奶油薄荷色的爪印气泡，像猫咪趴在窗边说悄悄话。","palette":[(255,247,223),(92,191,166),(237,143,118)],"motif":"paw"},
    "cute_cat_2": {"name":"猫咪乐园","description":"珊瑚与晴蓝组成的游乐园气泡，缀有彩旗和毛线球。","palette":[(255,239,230),(78,170,207),(244,111,126)],"motif":"party"},
    "dark_mag_1": {"name":"暗月魔法","description":"深靛月色包裹紫晶符文，适合神秘而安静的猫咪对白。","palette":[(35,31,67),(124,80,179),(91,220,224)],"motif":"dark"},
    "kitty_1": {"name":"蝶结萌喵","description":"草莓奶霜与蝴蝶结围成软萌对话框，轻甜但保留清晰阅读区。","palette":[(255,241,246),(237,126,164),(255,196,91)],"motif":"bow"},
    "moon_1": {"name":"月之魔咒","description":"银蓝新月与云朵守在气泡边缘，营造柔和的夜间聊天氛围。","palette":[(232,241,255),(78,101,164),(247,211,111)],"motif":"moon"},
    "ninja_cat_1": {"name":"假面猫猫","description":"墨色忍装、青蓝刀光与赤红结绳构成利落的忍猫气泡。","palette":[(34,39,59),(57,191,193),(218,66,72)],"motif":"ninja"},
    "star_1": {"name":"星辉","description":"深空蓝上的金色星轨与猫爪星座，让每条消息像小小许愿。","palette":[(30,55,103),(96,122,210),(255,209,91)],"motif":"star"},
}

PROFILE_SPECS = {
    "wangzong": {"name":"王总·金牌猫掌事务所","description":"海军蓝与金色构成的猫咪事务所夜景，沉稳、可靠又保留俏皮爪印。","target":"/static/images/wangzong_profile_bg_1.png"},
    "yixiao": {"name":"微光纪念（中性抽象候选）","description":"以雾蓝、暖灰和微光轨迹表达安静纪念，不指向具体人物或事件；待产品定义后再定名与叙事。","target":"/static/images/yixiao_profile_bg_1.png","productDefinitionStatus":"待产品定义"},
    "fishing_1": {"name":"湖畔垂钓的猫咪","description":"清晨薄雾、木栈桥与守候浮漂的渔猫，传达从容闲趣。","target":"/static/images/fishing_profile_bg_1.png"},
    "night_ninja_1": {"name":"月下的浪人","description":"紫蓝屋脊、圆月与潜行忍猫组成的夜行剪影，冷静而敏捷。","target":"/static/images/night_ninja_profile_bg_1.png"},
    "cute_kitty_1": {"name":"玩耍中的小猫咪","description":"棉花糖云、积木与毛线球铺成的粉彩乐园，轻快又治愈。","target":"/static/images/cute_profile_bg_1.png"},
}

BATTLE_SPECS = {
    "warrior": {"name":"战士喵","description":"举起赤焰爪盾守住同伴的橘猫先锋，强调力量与保护。","className":"Warrior"},
    "magical": {"name":"魔法师喵","description":"操纵星轨与青蓝法辉的紫猫术士，强调奥术爆发与奇想。","className":"Magical"},
    "cleric": {"name":"牧师喵","description":"以金色爪环和薄荷治愈光守护队伍的奶油猫；现有真实素材优先。","className":"Cleric","realAssetPriority":True},
    "ninja": {"name":"杀手喵","description":"在月影中挥出青色刃光的灰蓝忍猫，强调速度与隐匿。","className":"Ninja"},
}

STATIC_BORDER_SPECS = {
    "kitty_head_1": ("铃动猫咪","猫耳、铃铛与薄荷爪印围成的轻快头像框。","kitty",[(63,173,154),(255,204,82),(255,241,215)]),
    "bunny_1": ("可爱小兔叽","长耳与胡萝卜色花瓣组成的软萌兔猫联名框。","bunny",[(244,145,175),(255,210,111),(244,239,255)]),
    "ghostBladeNebula": ("幽冥毒刃","幽紫星云与青色刃片交错，呈现危险的猫影刀光。","blade",[(91,53,145),(67,224,205),(205,130,255)]),
    "cuteParty": ("萌宠派对","彩旗、气球与爪印撒花环绕头像，适合庆祝时刻。","party",[(244,106,135),(83,181,216),(255,205,77)]),
    "kittyRing2": ("萌铃喵喵","双层奶油铃环配上小猫耳，细腻又醒目。","bell",[(93,184,174),(255,191,94),(255,240,218)]),
    "20260203potato": ("新鲜的薯条","金黄薯条、番茄红与俏皮爪印组成的零食主题框。","fries",[(230,69,62),(255,199,70),(255,240,171)]),
    "meowQuest": ("喵将征途","翡翠罗盘、皮革盾牌与远行徽记构成冒险框。","quest",[(40,130,116),(209,159,76),(236,225,191)]),
    "privateDetective": ("私家侦探","黄铜放大镜、深棕帽檐与线索纸片环绕猫探头像。","detective",[(91,64,55),(201,153,69),(238,221,183)]),
    "catVillageOverseer_1": ("猫猫村监管者","青瓦、木牌和新叶组成的村落巡查徽框。","village1",[(55,137,121),(181,128,72),(225,235,196)]),
    "catVillageOverseer_2": ("猫猫村风气监管员","朱红印章、卷册与端正爪徽构成的监管主题框。","village2",[(164,61,59),(71,119,109),(239,207,130)]),
    "SpringFestivalLuckyCat2026": ("新春招财猫","红金灯笼、招财金币与猫爪福纹组成的新春框。","luckycat",[(211,47,44),(255,197,56),(255,235,153)]),
    "SpringFestival2026_1": ("大战年兽","火花、兽角与爆竹围成热烈的新春战斗框。","nian",[(175,38,49),(248,119,49),(255,205,65)]),
    "SpringFestival2026_LuckyHorseCat": ("马上有钱","碧玉马蹄、流苏与金币组合成轻盈的马年招财框。","horse",[(39,139,119),(245,180,56),(255,235,147)]),
    "holyPawsGospel": ("曦光福音","象牙羽翼与金色爪环释放温柔守护光。","holy",[(235,225,195),(242,190,73),(79,171,159)]),
    "emberClaw": ("铁甲征服者","玄铁外圈、熔岩爪痕与余烬火星塑造强硬战意。","ember",[(65,68,78),(218,69,43),(255,157,54)]),
}

ANIM_BORDER_SPECS = {
    "SpringFestival2026_12": ("大战年兽！","金环呼吸、爆竹火星沿边缘奔跑的新春动态候选。","nian",[(177,37,46),(248,113,42),(255,205,63)]),
    "SpringFestival2026_LuckyHorseCat2": ("马上有钱！","玉色马蹄与金币高光循环追逐的动态招财候选。","horse",[(34,136,112),(242,180,55),(255,235,143)]),
    "slumberCat": ("酣睡小猫","月云轻轻起伏、星点慢闪的静谧睡眠动态框。","sleep",[(77,91,161),(169,145,221),(232,238,255)]),
    "catMercante": ("行市猫商","铜币、价签与翡翠刻度轮转的猫商动态框。","merchant",[(33,126,119),(190,127,57),(245,210,113)]),
}

ANIM_AVATAR_SPECS = {
    "warrior": ("战士喵·炽盾跃动","盾面火光呼吸、披风轻摆的透明动态头像。",550),
    "magical": ("魔法师喵·星轨跃动","星点绕行、法杖明灭的透明动态头像。",550),
    "cleric": ("牧师喵·祈光跃动","治愈爪环脉动的透明动态头像；现有真实 cleric 素材优先。",550),
    "avatarAlchemist": ("炼金术师喵·瓶中星火","药瓶气泡上浮、护目镜反光的透明动态头像。",512),
}


def save_png(image, relative):
    path = ROOT / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG", optimize=True)


def chat_motifs(art, motif, colors):
    base, accent, accent2 = colors
    if motif == "paw":
        for x,y,s in [(92,78,18),(550,80,13),(570,225,18),(120,245,11)]: draw_paw(art,x,y,s,accent2)
        art.polygon([(65,72),(82,34),(104,74)],fill=accent)
        art.polygon([(104,74),(128,37),(139,82)],fill=accent)
    elif motif == "party":
        art.line([(95,64),(545,64)],fill=accent,width=3)
        for i,x in enumerate(range(115,546,55)):
            c = accent if i%2 else accent2
            art.polygon([(x,64),(x+18,64),(x+9,89)],fill=c)
        for x,y,c in [(95,230,accent),(548,225,accent2)]:
            art.ellipse((x-16,y-20,x+16,y+20),fill=c); art.line([(x,y+20),(x-4,y+45)],fill=c,width=2)
    elif motif == "dark":
        art.ellipse((74,48,142,116),fill=accent2)
        art.ellipse((94,38,154,103),fill=base)
        add_stars(art,101,14,(70,52,575,245),[accent,accent2,(235,221,255)],(3,8),210)
        for x,y in [(112,237),(534,84),(554,231)]: draw_star(art,x,y,12,accent2,6)
    elif motif == "bow":
        draw_bow(art,112,69,23,accent,accent2); draw_bow(art,542,231,17,accent,accent2)
        for x,y in [(75,224),(568,82)]: draw_paw(art,x,y,11,accent2)
    elif motif == "moon":
        art.ellipse((72,43,145,116),fill=accent2); art.ellipse((98,35,157,100),fill=base)
        draw_cloud(art,535,230,18,(255,255,255,190)); add_stars(art,222,10,(70,55,570,245),[accent2,(255,255,255)],(3,7),220)
    elif motif == "ninja":
        for x,y in [(100,72),(548,226)]:
            art.polygon([(x,y-18),(x+8,y-7),(x+24,y),(x+8,y+7),(x,y+22),(x-8,y+7),(x-24,y),(x-8,y-7)],fill=accent2)
        art.line([(72,236),(142,205)],fill=accent,width=7); art.line([(500,80),(570,49)],fill=accent,width=7)
    elif motif == "star":
        pts=[]
        for i,(x,y) in enumerate([(82,211),(145,92),(240,69),(347,91),(454,65),(558,132),(536,233)]):
            pts.append((x,y)); draw_star(art,x,y,8 if i%2 else 12,accent2,5)
        art.line(pts,fill=tuple(accent2)+(120,) if len(accent2)==3 else accent2,width=2)
        draw_paw(art,105,73,13,accent)


def make_chat_bubble(key, spec):
    colors = [rgba(c) for c in spec["palette"]]
    base, accent, accent2 = colors
    art = Art(640,320,2)
    shadow = Art(640,320,2)
    shadow.rounded_rectangle((53,48,590,258),45,fill=(15,22,38,130))
    shadow.polygon([(126,248),(91,292),(177,255)],fill=(15,22,38,130))
    shadow.image = shadow.image.filter(ImageFilter.GaussianBlur(12*shadow.ss))
    art.composite(shadow)
    art.polygon([(127,236),(84,285),(183,247)],fill=base,outline=accent,width=5)
    art.rounded_rectangle((42,35,598,252),48,fill=base,outline=accent,width=8)
    art.rounded_rectangle((59,51,581,236),35,fill=(255,255,255,34),outline=accent2,width=3)
    chat_motifs(art,spec["motif"],colors)
    # Small signature cat face at the upper-right edge.
    art.ellipse((520,24,590,94),fill=accent,outline=accent2,width=3)
    art.polygon([(526,38),(534,11),(550,35)],fill=accent,outline=accent2,width=2)
    art.polygon([(562,35),(579,10),(586,40)],fill=accent,outline=accent2,width=2)
    art.arc((537,49,552,66),0,180,fill=accent2,width=3)
    art.arc((559,49,574,66),0,180,fill=accent2,width=3)
    art.polygon([(555,65),(550,71),(560,71)],fill=accent2)
    return art.finish()


def make_chat_preview(key, spec, runtime):
    p = [rgba(c) for c in spec["palette"]]
    bg = multi_gradient((800,320), [mix(p[0],(255,255,255,255),.35), mix(p[1],(23,29,48,255),.15)], True)
    art = Art(800,320,1,bg)
    # Background paw watermark pattern.
    for i in range(7):
        draw_paw(art,45+i*125,276-(i%2)*210,13,p[2][:3]+(48,))
    art.image.alpha_composite(runtime, dest=(80,0))
    art.draw = ImageDraw.Draw(art.image)
    dark = (31,38,55,255) if sum(p[0][:3]) > 430 else (247,249,255,255)
    art.rounded_rectangle((18,18,210,62),18,fill=(18,25,42,190),outline=p[2],width=2)
    art.text((32,40),spec["name"],19,(255,255,255,255),anchor="lm",bold=True)
    art.text((210,143),"今天也要元气满满，喵！",25,dark,anchor="lm",bold=True)
    art.text((210,180),"候选气泡 · Phase 1",15,tuple(dark[:3])+(170,),anchor="lm")
    return art.finish()


def draw_profile(key):
    if key == "wangzong":
        bg = multi_gradient((1200,720),[(18,39,69),(37,88,126),(232,190,105)],True)
        art=Art(1200,720,2,bg); add_radial_glow(art,900,240,290,(255,210,103),110)
        # Abstract office windows and desk.
        for x in range(0,1200,95):
            art.rectangle((x,370,x+70,720),fill=(13,32,58,205),outline=(78,128,159,160),width=2)
            for y in range(400,680,62): art.rectangle((x+12,y,x+57,y+32),fill=(244,198,96,70))
        art.rectangle((0,590,1200,720),fill=(25,37,53,235)); art.line([(0,590),(1200,590)],fill=(242,188,77,255),width=6)
        draw_cat_character(art,890,405,1.35,"executive")
        for x,y,s in [(120,120,24),(254,178,15),(1040,100,18)]: draw_paw(art,x,y,s,(246,200,100,90))
    elif key == "yixiao":
        bg=multi_gradient((1200,720),[(40,55,72),(102,117,126),(207,184,151)],True)
        art=Art(1200,720,2,bg)
        add_radial_glow(art,610,345,270,(245,220,174),120)
        # Neutral memorial abstraction: no person, no event-specific symbol.
        for i in range(7):
            r=95+i*38; art.arc((600-r,350-r,600+r,350+r),205+i*5,518-i*4,fill=(235,225,205,150-i*12),width=2+i*.35)
        art.line([(210,550),(390,420),(535,475),(700,300),(910,420),(1080,235)],fill=(231,215,184,130),width=4)
        for x,y,s in [(390,420,10),(700,300,13),(910,420,9)]: draw_paw(art,x,y,s,(245,231,199,125))
        for i in range(24):
            a=i*0.73; r=80+i*13; x=600+math.cos(a)*r; y=350+math.sin(a)*r*.55
            art.ellipse((x-4,y-4,x+4,y+4),fill=(244,229,198,max(35,170-i*5)))
        art.rectangle((0,630,1200,720),fill=(33,46,59,105))
    elif key == "fishing_1":
        bg=multi_gradient((1200,720),[(238,184,114),(117,184,185),(43,110,139)])
        art=Art(1200,720,2,bg); add_radial_glow(art,225,160,150,(255,223,139),150)
        art.ellipse((135,70,315,250),fill=(255,222,137,220))
        for y,c in [(410,(63,137,158,255)),(475,(50,119,146,255)),(545,(38,99,129,255))]: art.rectangle((0,y,1200,720),fill=c)
        for i in range(15):
            y=430+i*18; art.line([(0,y),(1200,y+7*math.sin(i))],fill=(190,225,211,55),width=3)
        art.polygon([(560,505),(1040,505),(1170,720),(430,720)],fill=(91,61,41,255),outline=(185,137,75,255),width=5)
        for x in range(510,1130,80): art.line([(x,505),(x-75,720)],fill=(45,41,37,150),width=4)
        draw_cat_character(art,810,350,1.25,"fisher")
        for x in [55,92,1120,1150]:
            art.line([(x,720),(x+10,500)],fill=(50,91,66,255),width=8)
            art.line([(x+7,585),(x+35,540)],fill=(65,122,78,255),width=5)
    elif key == "night_ninja_1":
        bg=multi_gradient((1200,720),[(16,20,52),(43,40,93),(91,63,126)])
        art=Art(1200,720,2,bg); add_radial_glow(art,830,170,180,(198,211,255),90)
        art.ellipse((700,45,960,305),fill=(220,226,247,220)); art.ellipse((760,25,985,250),fill=(39,36,83,255))
        add_stars(art,404,48,(20,20,1180,430),[(181,206,255),(108,218,220),(255,255,255)],(2,6),210)
        # Roofline.
        art.polygon([(0,535),(200,470),(375,530),(565,445),(750,525),(955,455),(1200,535),(1200,720),(0,720)],fill=(14,21,39,255))
        for x in range(80,1200,180): art.polygon([(x,490),(x+70,430),(x+145,490)],fill=(25,29,51,255))
        draw_cat_character(art,820,392,1.3,"ninja")
        art.line([(700,584),(1005,584)],fill=(69,213,215,150),width=3)
    else:
        bg=multi_gradient((1200,720),[(255,220,230),(196,228,244),(255,240,195)],True)
        art=Art(1200,720,2,bg); add_radial_glow(art,820,300,260,(255,255,255),130)
        draw_cloud(art,160,160,74,(255,255,255,205)); draw_cloud(art,1030,115,58,(255,255,255,185))
        art.rectangle((0,560,1200,720),fill=(153,214,177,255))
        for x,c in [(90,(245,130,157,255)),(210,(105,184,218,255)),(330,(255,197,75,255))]:
            art.rounded_rectangle((x,470,x+100,570),12,fill=c,outline=(255,255,255,220),width=5)
        draw_cat_character(art,820,380,1.35,"playful")
        for x,y,c in [(1030,450,(245,128,158,255)),(1080,490,(105,183,218,255)),(990,515,(255,201,82,255))]: art.ellipse((x-45,y-45,x+45,y+45),fill=c,outline=(255,255,255,220),width=5)
        art.arc((965,470,1115,615),215,495,fill=(255,255,255,170),width=4)
    return art.finish()


def make_battle_avatar(role, size=550, phase=0.0, animated=False):
    art=Art(size,size,2)
    p=role_palette("alchemist" if role=="avatarAlchemist" else role)
    pulse=.5+.5*math.sin(phase)
    add_radial_glow(art,size/2,size*.48,size*(.31+.025*pulse),p["accent2"],95+int(35*pulse))
    # Emblem rays stay translucent so the portrait remains alpha-friendly.
    for i in range(12):
        a=i*TAU/12 + (phase*.08 if animated else 0)
        r1=size*.29; r2=size*(.35+.015*(i%2))
        art.line([(size/2+math.cos(a)*r1,size*.48+math.sin(a)*r1),(size/2+math.cos(a)*r2,size*.48+math.sin(a)*r2)],fill=tuple(p["accent2"][:3])+(125,),width=5)
    bob=math.sin(phase)*5 if animated else 0
    draw_cat_character(art,size/2,size*.37,1.02*(size/550),"alchemist" if role=="avatarAlchemist" else role,bob=bob,blink=(animated and phase>5.45),phase=phase)
    return art.finish()


def make_battle_scene(role):
    palettes={
        "warrior":[(52,29,35),(142,54,46),(239,139,58)],
        "magical":[(25,26,74),(70,57,139),(68,179,189)],
        "cleric":[(55,91,91),(164,166,119),(243,211,133)],
        "ninja":[(14,24,48),(47,50,94),(72,126,145)],
    }
    cols=palettes[role]; bg=multi_gradient((1152,864),cols,True); art=Art(1152,864,2,bg)
    p=role_palette(role); add_radial_glow(art,850,320,280,p["accent2"],95)
    # UI-safe left panel is atmospheric and intentionally low-detail.
    art.rounded_rectangle((55,90,515,765),42,fill=(11,18,31,72),outline=tuple(p["accent2"][:3])+(75,),width=3)
    if role=="warrior":
        art.rectangle((0,650,1152,864),fill=(50,36,38,255))
        for x in [80,250,980]:
            art.rectangle((x,310,x+110,650),fill=(71,47,48,255)); art.polygon([(x-35,310),(x+55,225),(x+145,310)],fill=(97,51,46,255))
        for x in range(90,1100,170):
            art.line([(x,650),(x+25,535)],fill=(245,126,48,190),width=9); draw_star(art,x+25,525,13,(255,205,72,230),6)
    elif role=="magical":
        add_stars(art,707,70,(20,20,1130,620),[(126,220,238),(214,190,255),(255,255,255)],(2,8),220)
        for r in [95,155,220]: art.arc((850-r,300-r,850+r,300+r),190,505,fill=tuple(p["accent2"][:3])+(110,),width=3)
        art.polygon([(0,690),(250,580),(470,680),(710,550),(930,675),(1152,590),(1152,864),(0,864)],fill=(22,26,66,255))
    elif role=="cleric":
        art.rectangle((0,620,1152,864),fill=(69,111,94,255))
        for x in range(40,1150,150):
            art.line([(x,620),(x+55,360)],fill=(237,221,167,130),width=10)
            art.ellipse((x+30,320,x+80,370),fill=(247,222,140,150))
        for x in range(40,1150,90):
            art.ellipse((x,700+(x%180)//3,x+14,714+(x%180)//3),fill=(239,230,177,180))
    else:
        add_stars(art,808,32,(20,20,1130,430),[(117,190,206),(184,194,238)],(2,6),190)
        art.ellipse((790,70,1010,290),fill=(195,212,229,180)); art.ellipse((835,45,1040,245),fill=(37,45,83,255))
        art.polygon([(0,650),(170,540),(330,635),(520,510),(730,630),(930,500),(1152,610),(1152,864),(0,864)],fill=(12,23,42,255))
        for x in range(80,1100,210): art.polygon([(x,585),(x+62,515),(x+135,585)],fill=(24,34,59,255))
    draw_cat_character(art,860,445,1.48,role,phase=.5)
    # Class emblem in safe panel, not text.
    if role=="warrior": draw_shield(art,285,365,92,p["accent"],p["accent2"])
    elif role=="magical": draw_star(art,285,365,112,p["accent2"],6)
    elif role=="cleric": draw_paw(art,285,365,82,p["accent2"],p["accent"])
    else:
        for a in range(0,360,90):
            rad=math.radians(a); x=285+math.cos(rad)*50; y=365+math.sin(rad)*50
            art.polygon([(x,y-60),(x+13,y-13),(x+60,y),(x+13,y+13),(x,y+60),(x-13,y+13),(x-60,y),(x-13,y-13)],fill=p["accent2"])
    return art.finish()


def border_motif(art,motif,x,y,s,cols,index=0):
    c1,c2,c3=cols
    if motif in ("kitty","bell"):
        draw_paw(art,x,y,s*.6,c2)
        if index%3==0:
            art.ellipse((x-s*.36,y+s*.4,x+s*.36,y+s*1.1),fill=c3,outline=c1,width=2)
    elif motif=="bunny":
        art.ellipse((x-s*.55,y-s*1.2,x-s*.05,y+s*.15),fill=c3,outline=c1,width=2)
        art.ellipse((x+s*.05,y-s*1.2,x+s*.55,y+s*.15),fill=c3,outline=c1,width=2)
        art.ellipse((x-s*.55,y-s*.3,x+s*.55,y+s*.65),fill=c2)
    elif motif=="blade":
        art.polygon([(x,y-s*1.2),(x+s*.33,y-s*.18),(x,y+s*.78),(x-s*.33,y-s*.18)],fill=c2,outline=c3,width=2)
    elif motif=="party":
        if index%2: draw_star(art,x,y,s,c3,5)
        else:
            art.ellipse((x-s*.55,y-s*.8,x+s*.55,y+s*.55),fill=c2); art.line([(x,y+s*.55),(x-s*.2,y+s*1.15)],fill=c3,width=2)
    elif motif=="fries":
        for dx in (-.35,0,.35): art.rounded_rectangle((x+(dx-.13)*s,y-.9*s,x+(dx+.13)*s,y+.25*s),.08*s,fill=c2)
        art.polygon([(x-.72*s,y),(x+.72*s,y),(x+.5*s,y+.9*s),(x-.5*s,y+.9*s)],fill=c1,outline=c3,width=2)
    elif motif=="quest":
        draw_shield(art,x,y,s*.58,c1,c3)
    elif motif=="detective":
        art.ellipse((x-.65*s,y-.65*s,x+.45*s,y+.45*s),outline=c2,width=s*.18)
        art.line([(x+.3*s,y+.3*s),(x+1.0*s,y+1.0*s)],fill=c3,width=s*.22)
    elif motif in ("village1","village2"):
        art.polygon([(x-s,y),(x,y-s*.85),(x+s,y)],fill=c1,outline=c3,width=2)
        art.rectangle((x-.65*s,y,x+.65*s,y+.72*s),fill=c2,outline=c3,width=2)
        draw_paw(art,x,y+.35*s,s*.3,c3)
    elif motif=="luckycat":
        if index%2: draw_coin(art,x,y,s*.65,c2,c3)
        else: draw_lantern(art,x,y,s*.58,c1,c3)
    elif motif=="nian":
        art.polygon([(x-s,y+s*.55),(x-.42*s,y-s*.72),(x,y-s*.2),(x+.42*s,y-s*.72),(x+s,y+s*.55)],fill=c1,outline=c2,width=2)
        draw_star(art,x,y,s*.46,c3,6)
    elif motif=="horse":
        art.arc((x-s,y-s,x+s,y+s),15,345,fill=c2,width=s*.26)
        for dx in (-.55,.55): art.ellipse((x+dx*s-.11*s,y+.58*s-.11*s,x+dx*s+.11*s,y+.58*s+.11*s),fill=c3)
    elif motif=="holy":
        art.polygon([(x,y),(x-s*1.05,y-s*.6),(x-s*.65,y+s*.5)],fill=c3)
        art.polygon([(x,y),(x+s*1.05,y-s*.6),(x+s*.65,y+s*.5)],fill=c3)
        draw_paw(art,x,y,s*.42,c2)
    elif motif=="ember":
        art.polygon([(x,y+s),(x-.72*s,y+.2*s),(x-.25*s,y-s),(x+.05*s,y-.3*s),(x+.55*s,y-.82*s),(x+.72*s,y+.2*s)],fill=c2,outline=c3,width=2)
    elif motif=="sleep":
        if index%2: draw_star(art,x,y,s*.75,c3,5)
        else: draw_cloud(art,x,y,s*.47,c2)
    elif motif=="merchant":
        if index%2: draw_coin(art,x,y,s*.65,c2,c3)
        else:
            art.polygon([(x-s*.8,y-s*.45),(x+s*.5,y-s*.45),(x+s*.8,y),(x+s*.5,y+s*.45),(x-s*.8,y+s*.45)],fill=c1,outline=c3,width=2)
            draw_paw(art,x,y,s*.28,c3)


def make_border(key,spec,phase=0.0,animated=False):
    name,desc,motif,palette=spec
    cols=[rgba(c) for c in palette]
    c1,c2,c3=cols
    art=Art(320,320,3)
    pulse=(math.sin(phase)+1)/2 if animated else .45
    add_radial_glow(art,160,160,154,c2,55+int(35*pulse))
    art.ellipse((22,22,298,298),outline=tuple(c1[:3])+(215,),width=12)
    art.ellipse((36,36,284,284),outline=tuple(c2[:3])+(235,),width=10)
    art.ellipse((48,48,272,272),outline=tuple(c3[:3])+(200,),width=4)
    # Cat-ear crown makes every frame recognizably feline.
    art.polygon([(81,58),(92,8),(124,48)],fill=c1,outline=c3,width=3)
    art.polygon([(196,48),(228,8),(239,58)],fill=c1,outline=c3,width=3)
    for i in range(8):
        a=i*TAU/8-math.pi/2 + (phase*.10 if animated else 0)
        radius=132
        x=160+math.cos(a)*radius; y=160+math.sin(a)*radius
        border_motif(art,motif,x,y,15+(i%2)*2,cols,i)
    if animated:
        # Orbiting highlights guarantee perceptible, reviewable motion.
        for j in range(3):
            a=phase+j*TAU/3
            x=160+math.cos(a)*142; y=160+math.sin(a)*142
            draw_star(art,x,y,8+j*2,(255,255,255,220),5)
    out=art.finish()
    # Guarantee a circular transparent aperture >58% diameter.
    clear=Image.new("RGBA",out.size,(0,0,0,0))
    mask=Image.new("L",out.size,0); md=ImageDraw.Draw(mask); md.ellipse((62,62,258,258),fill=255)
    out.paste(clear,(0,0),mask)
    return out


def prepare_gif_frame(frame):
    frame=frame.convert("RGBA")
    alpha=frame.getchannel("A")
    matte=Image.new("RGB",frame.size,(32,35,45)); matte.paste(frame.convert("RGB"),mask=alpha)
    pal=matte.quantize(colors=255,method=Image.Quantize.MEDIANCUT,dither=Image.Dither.FLOYDSTEINBERG)
    shifted=pal.point([min(255,i+1) for i in range(256)])
    palette=pal.getpalette() or [0]*768
    shifted.putpalette([0,0,0]+palette[:765])
    transparent_mask=alpha.point(lambda a: 255 if a < 48 else 0)
    shifted.paste(0,mask=transparent_mask)
    shifted.info["transparency"]=0
    shifted.info["disposal"]=2
    return shifted


def save_gif(frames,relative,duration=100):
    path=ROOT/relative; path.parent.mkdir(parents=True,exist_ok=True)
    prepared=[prepare_gif_frame(f) for f in frames]
    prepared[0].save(path,format="GIF",save_all=True,append_images=prepared[1:],duration=duration,loop=0,transparency=0,disposal=2,optimize=False)


def checkerboard(size,cell=18):
    img=Image.new("RGBA",size,(244,246,250,255)); d=ImageDraw.Draw(img)
    for y in range(0,size[1],cell):
        for x in range(0,size[0],cell):
            if (x//cell+y//cell)%2: d.rectangle((x,y,x+cell-1,y+cell-1),fill=(222,226,234,255))
    return img


def first_frame(path):
    with Image.open(path) as im:
        im.seek(0)
        return im.convert("RGBA")


def fit_image(image,size,pad=0):
    box=(max(1,size[0]-2*pad),max(1,size[1]-2*pad))
    copy=image.copy(); copy.thumbnail(box,RESAMPLING)
    canvas=checkerboard(size,20)
    x=(size[0]-copy.width)//2; y=(size[1]-copy.height)//2
    canvas.alpha_composite(copy,(x,y)); return canvas


def contact_sheet(entries,columns,cell_size,thumb_size,title,output):
    rows=math.ceil(len(entries)/columns); margin=32; header=82
    width=margin*2+columns*cell_size[0]; height=header+margin+rows*cell_size[1]
    bg=multi_gradient((width,height),[(24,31,48),(46,58,78)],True); art=Art(width,height,1,bg)
    art.text((margin,42),title,32,(255,255,255,255),anchor="lm",bold=True)
    art.text((width-margin,42),"程序绘制原创候选 · 未接线运行时",15,(192,205,225,255),anchor="rm")
    for idx,(key,name,path) in enumerate(entries):
        col=idx%columns; row=idx//columns
        x=margin+col*cell_size[0]; y=header+row*cell_size[1]
        art.rounded_rectangle((x+8,y+8,x+cell_size[0]-10,y+cell_size[1]-12),20,fill=(255,255,255,235),outline=(106,128,162,180),width=2)
        im=first_frame(ROOT/path)
        thumb=fit_image(im,thumb_size,8)
        tx=x+(cell_size[0]-thumb_size[0])//2; ty=y+18
        art.image.alpha_composite(thumb,dest=(tx,ty)); art.draw=ImageDraw.Draw(art.image)
        art.text((x+24,y+thumb_size[1]+36),name,20,(31,39,57,255),anchor="lm",bold=True)
        art.text((x+cell_size[0]-24,y+thumb_size[1]+36),key,13,(85,100,126,255),anchor="rm")
    save_png(art.finish(),output)
    return (width,height)


def build_assets():
    files=[]
    # Chat bubbles: runtime + shop/review preview.
    for key,spec in CHAT_SPECS.items():
        runtime=make_chat_bubble(key,spec)
        rpath=f"chat-bubbles/runtime/{key}.png"; save_png(runtime,rpath)
        preview=make_chat_preview(key,spec,runtime)
        ppath=f"chat-bubbles/preview/{key}.png"; save_png(preview,ppath)
        files += [
            asset_record(key,"chatBubble","runtime",spec["name"],spec["description"],rpath,[640,320],"PNG",True,f"assets/png/{key}.png"),
            asset_record(key,"chatBubble","preview",spec["name"],spec["description"],ppath,[800,320],"PNG",True,f"/static/images/preview/chatBubble_{key}.png"),
        ]
    # Profile backgrounds.
    for key,spec in PROFILE_SPECS.items():
        path=f"profile-backgrounds/{key}.png"; save_png(draw_profile(key),path)
        extra={"productDefinitionStatus":spec["productDefinitionStatus"]} if "productDefinitionStatus" in spec else {}
        files.append(asset_record(key,"profileBackground","runtime-candidate",spec["name"],spec["description"],path,[1200,720],"PNG",False,spec["target"],**extra))
    # Battle avatars and scenes.
    for role,spec in BATTLE_SPECS.items():
        apath=f"battle/avatars/{role}.png"; save_png(make_battle_avatar(role),apath)
        spath=f"battle/scenes/{role}.png"; save_png(make_battle_scene(role),spath)
        priority={"realAssetPriority":True,"doNotOverwriteExisting":True} if spec.get("realAssetPriority") else {}
        files.append(asset_record(role,"battleStyle","transparent-avatar",spec["name"],spec["description"],apath,[550,550],"PNG",True,f"assets/png/avatarBattleUnitCard_{spec['className']}.png",**priority))
        files.append(asset_record(role,"battleStyle","scene",spec["name"],spec["description"],spath,[1152,864],"PNG",False,f"assets/png/battleUnitCard_{role}.png",**priority))
    # Static avatar borders.
    static_target_names={"kittyRing2":"kitty_ring_2.png"}
    for key,spec in STATIC_BORDER_SPECS.items():
        path=f"avatar-borders/static/{key}.png"; save_png(make_border(key,spec),path)
        target=static_target_names.get(key,f"{key}.png")
        files.append(asset_record(key,"avatarBorder","static",spec[0],spec[1],path,[320,320],"PNG",True,f"assets/png/{target}",centralClearance={"shape":"circle","minimumDiameterPercent":58}))
    # Animated border review GIFs.
    for key,spec in ANIM_BORDER_SPECS.items():
        frames=[make_border(key,spec,i*TAU/12,True) for i in range(12)]
        path=f"avatar-borders/animated/{key}.gif"; save_gif(frames,path,95)
        targets={
            "SpringFestival2026_12":"assets/webm/t_avatarBorder_SpringFestival2026_12.webm",
            "SpringFestival2026_LuckyHorseCat2":"assets/webm/SpringFestival2026_LuckyHorseCat.webm",
            "slumberCat":"assets/webm/slumberCat.webm",
            "catMercante":"assets/webm/catMercante.webm",
        }
        files.append(asset_record(key,"avatarBorder","animated-review-gif",spec[0],spec[1],path,[320,320],"GIF",True,targets[key],frames=12,centralClearance={"shape":"circle","minimumDiameterPercent":58},conversionAfterApproval="alpha VP9 WebM"))
    # Animated battle / avatar candidates.
    for key,(name,desc,size) in ANIM_AVATAR_SPECS.items():
        role="alchemist" if key=="avatarAlchemist" else key
        frames=[make_battle_avatar(key,size,i*TAU/10,True) for i in range(10)]
        path=f"animated-avatars/{key}.gif"; save_gif(frames,path,105)
        target="assets/gif/avatarAlchemist.gif" if key=="avatarAlchemist" else f"assets/gif/avatarBattleUnitCard_{BATTLE_SPECS[key]['className']}Anim.gif"
        extra={"realAssetPriority":True,"doNotOverwriteExisting":True} if key=="cleric" else {}
        files.append(asset_record(key,"animatedAvatar","animated-review-gif",name,desc,path,[size,size],"GIF",True,target,frames=10,conversionAfterApproval="alpha VP9 WebM",**extra))
    return files


def asset_record(key,category,variant,name,description,path,dimensions,fmt,alpha,target,**extra):
    rec={
        "key":key,"category":category,"variant":variant,"nameZh":name,"descriptionZh":description,
        "candidatePath":path,"spec":{"width":dimensions[0],"height":dimensions[1],"format":fmt,"alphaRequired":alpha},
        "targetLogicalPath":target,"status":"candidate-only","runtimeConnected":False,"source":"programmatic-original-cat-theme",
    }
    rec.update(extra); return rec


def build_contact_sheets():
    sheets=[]
    chat_entries=[(k,v["name"],f"chat-bubbles/preview/{k}.png") for k,v in CHAT_SPECS.items()]
    dims=contact_sheet(chat_entries,2,(760,365),(700,280),"01 · 聊天气泡候选（预览图）","contact-sheets/01-chat-bubbles.png")
    sheets.append(contact_sheet_record("contact-sheets/01-chat-bubbles.png",dims,"7 套气泡 preview"))
    profile_entries=[(k,v["name"],f"profile-backgrounds/{k}.png") for k,v in PROFILE_SPECS.items()]
    dims=contact_sheet(profile_entries,2,(750,500),(690,414),"02 · Profile 背景候选","contact-sheets/02-profile-backgrounds.png")
    sheets.append(contact_sheet_record("contact-sheets/02-profile-backgrounds.png",dims,"5 套 1200×720 背景"))
    battle_entries=[]
    for k,v in BATTLE_SPECS.items():
        battle_entries.append((f"{k} scene",v["name"]+" · 场景",f"battle/scenes/{k}.png"))
        battle_entries.append((f"{k} avatar",v["name"]+" · 透明头像",f"battle/avatars/{k}.png"))
    dims=contact_sheet(battle_entries,2,(760,560),(700,460),"03 · 四职业 Battle 候选","contact-sheets/03-battle-styles.png")
    sheets.append(contact_sheet_record("contact-sheets/03-battle-styles.png",dims,"4 头像 + 4 场景"))
    border_entries=[(k,v[0],f"avatar-borders/static/{k}.png") for k,v in STATIC_BORDER_SPECS.items()]
    dims=contact_sheet(border_entries,5,(310,370),(260,260),"04 · 静态头像框候选","contact-sheets/04-static-avatar-borders.png")
    sheets.append(contact_sheet_record("contact-sheets/04-static-avatar-borders.png",dims,"15 套静态透明头像框"))
    anim_entries=[(k,v[0],f"avatar-borders/animated/{k}.gif") for k,v in ANIM_BORDER_SPECS.items()]
    anim_entries += [(k,v[0],f"animated-avatars/{k}.gif") for k,v in ANIM_AVATAR_SPECS.items()]
    dims=contact_sheet(anim_entries,4,(380,430),(320,320),"05 · 动画候选首帧","contact-sheets/05-animations-first-frames.png")
    sheets.append(contact_sheet_record("contact-sheets/05-animations-first-frames.png",dims,"4 动态框 + 4 动态头像（首帧）"))
    return sheets


def contact_sheet_record_path(path):
    return str(path).replace("\\","/")


def contact_sheet_size(path):
    with Image.open(ROOT/path) as im: return list(im.size)


def contact_sheet_entries():
    return []


def contact_sheet_names():
    return []


def contact_sheet_record_unused():
    return None


def contact_sheet_dimensions(path):
    return contact_sheet_size(path)


def contact_sheet_label(path):
    return path


def contact_sheet_meta(path):
    return {"path":path}


def contact_sheet_index():
    return []


def contact_sheet_manifest():
    return []


def contact_sheet_stub():
    pass


def contact_sheet_record(path,dims,contents):
    return {"path":path,"spec":{"width":dims[0],"height":dims[1],"format":"PNG"},"contents":contents,"animationPolicy":"GIF 仅取首帧"}


def write_manifests(files,sheets):
    manifest={
        "schemaVersion":1,
        "phase":"Phase 1 Style candidates",
        "generatedAt":datetime.now(timezone.utc).isoformat(),
        "scope":"candidate review package only",
        "runtimeConnected":False,
        "originality":"全部图像由 Pillow 程序绘制，无外部图片素材。",
        "notices":[
            "候选稿未接线运行时，不应直接复制覆盖生产素材。",
            "已有真实 cleric、axeEnhanceMaster1、mageKitty1 素材优先，严禁覆盖。",
            "所有动画 GIF 仅供确认；确认后转换为带 alpha 的 VP9 WebM，再按目标逻辑路径接入。",
            "yixiao 当前采用中性纪念抽象方向，名称、叙事与最终视觉均待产品定义。",
        ],
        "reviewRules":{"animationReview":"查看 GIF 循环；联系表只展示首帧","approvalNextStep":"冻结 key 与构图后，由产品另开运行时接线任务","forbidOverwrite":["cleric","axeEnhanceMaster1","mageKitty1"]},
        "expectedAssetCount":50,
        "assets":files,
        "contactSheets":sheets,
    }
    (ROOT/"manifest.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    lines=[
        "# Phase 1 Style 候选清单","",
        "> **状态：仅供确认，未接线运行时。** 全部图像由 Pillow 程序绘制，无外部图片素材。","",
        "> **保护规则：已有真实 `cleric` / `axeEnhanceMaster1` / `mageKitty1` 素材优先且不得覆盖。** 动画确认后转为带 alpha 的 VP9 WebM。","",
        "## 资产映射","",
        "| 类别 | key | 变体 | 中文名称 | 候选文件 | 规格 | 目标逻辑路径 | 状态 |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for a in files:
        spec=a["spec"]; size=f"{spec['width']}×{spec['height']} {spec['format']}" + (f" / {a['frames']} 帧" if "frames" in a else "")
        notes=[]
        if a.get("realAssetPriority"): notes.append("真实素材优先")
        if a.get("productDefinitionStatus"): notes.append(a["productDefinitionStatus"])
        if a.get("conversionAfterApproval"): notes.append("确认后转 alpha VP9 WebM")
        state="；".join(notes) if notes else "候选，未接线"
        lines.append(f"| {a['category']} | `{a['key']}` | {a['variant']} | {a['nameZh']} | `{a['candidatePath']}` | {size} | `{a['targetLogicalPath']}` | {state} |")
    lines += ["","## 中文文案"," "]
    seen=set()
    for a in files:
        token=(a["category"],a["key"])
        if token in seen: continue
        seen.add(token)
        lines.append(f"- **{a['nameZh']}** (`{a['key']}`)：{a['descriptionZh']}")
    lines += ["","## 联系表"," "]
    for s in sheets: lines.append(f"- `{s['path']}`：{s['contents']}；{s['animationPolicy']}。")
    (ROOT/"manifest.md").write_text("\n".join(lines)+"\n",encoding="utf-8")
    readme="""# Phase 1 Style Candidates

本目录是 **Style 缺失素材的产品确认包**，不是运行时资源目录。

## 使用边界

- 所有图片均由 `generate_candidates.py` 使用 Pillow 程序绘制，未使用外部图片素材。
- 候选稿 **未接线运行时**；本阶段不修改业务代码、不替换生产资源。
- 已有真实 `cleric`、`axeEnhanceMaster1`、`mageKitty1` 素材优先，任何后续任务都不得覆盖它们。
- `yixiao` 是中性纪念抽象候选，尚 **待产品定义**；确认前不得赋予具体人物、事件或纪念对象。
- GIF 是评审格式。动画确认后应转换为 **带 alpha 的 VP9 WebM**，再另行接入目标逻辑路径。

## 目录

- `chat-bubbles/runtime/`：7 张 640×320 RGBA 气泡。
- `chat-bubbles/preview/`：7 张 800×320 RGBA 商店/评审预览。
- `profile-backgrounds/`：5 张 1200×720 背景。
- `battle/avatars/`：4 张 550×550 透明职业头像。
- `battle/scenes/`：4 张 1152×864 职业场景。
- `avatar-borders/static/`：15 张 320×320 透明静态框。
- `avatar-borders/animated/`：4 张 320×320 透明动画 GIF。
- `animated-avatars/`：3 张 550×550 与 1 张 512×512 透明动画 GIF。
- `contact-sheets/`：5 张联系表；动画表仅展示首帧。
- `manifest.json` / `manifest.md`：key、规格、中文名称、描述和目标逻辑路径。
- `validate.py` / `validation-report.json`：可重复执行的完整性验证与结果。

## 评审建议

1. 先看五张联系表确认整体区分度与配色。
2. 单独打开 GIF 检查循环节奏；联系表只代表首帧。
3. 对照 `manifest.md` 确认中文名称、description 和目标逻辑路径。
4. 对 `yixiao` 明确产品定义后再定稿。
5. 通过后冻结 key，另开任务完成 alpha VP9 WebM 转码与运行时接线。

## 复验

使用本会话 `load_workspace_dependencies` 返回的 Python（含 Pillow）运行：

```powershell
& <bundled-python> .\\phase1-style-candidates\\validate.py
```

通过标准：解码、尺寸、格式、alpha 声明、GIF 帧数，以及头像框中央直径 58% 圆形净空全部通过。
"""
    (ROOT/"README.md").write_text(readme,encoding="utf-8")


def main():
    files=build_assets()
    sheets=build_contact_sheets()
    write_manifests(files,sheets)
    print(json.dumps({"root":str(ROOT),"assets":len(files),"contactSheets":len(sheets)},ensure_ascii=False))


if __name__=="__main__":
    main()
