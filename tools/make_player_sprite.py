#!/usr/bin/env python3
"""Generate a directional walk-cycle sprite GRID for Smoke Alarm Rush.

Draws a flat-style character (a Black male character) as a grid:
  rows = views  -> front (toward you), side (faces right), back (away)
  cols = frames -> col 0 idle, cols 1..N-1 walk cycle
Output: public/assets/sprites/player.png  (the game mirrors the side row
for leftward movement, giving a pseudo-3D look from 4 directions).
"""
import math, os
from PIL import Image, ImageDraw

# ---- config -----------------------------------------------------------------
COLS = 6              # frame 0 idle + 5 walk frames
VIEWS = ["front", "side", "back"]
ROWS = len(VIEWS)
FW, FH = 64, 84       # final per-frame size (px)
SS = 4                # supersample factor for smooth (anti-aliased) edges
OUT = os.path.join(os.path.dirname(__file__), "..", "public", "assets", "sprites", "player.png")

# ---- palette ----------------------------------------------------------------
SKIN      = (124, 78, 45)
SKIN_SH   = (96, 58, 32)     # shaded skin / outline
HAIR      = (26, 22, 20)
SHIRT     = (38, 132, 122)   # teal tee
SHIRT_SH  = (28, 100, 92)
PANTS     = (52, 60, 78)     # slate jeans
PANTS_SH  = (38, 45, 60)
SHOE      = (242, 244, 247)  # white sneakers
EYE       = (250, 250, 252)
PUPIL     = (24, 20, 18)
OUTLINE   = (18, 16, 16)


def draw_character(d, cx, foot_y, t, moving, view):
    """Draw one frame into supersampled space."""
    s = SS
    swing = math.sin(t * 2 * math.pi) if moving else 0.0
    bob = (abs(math.sin(t * 2 * math.pi)) * 1.5) if moving else 0.0

    cx *= s
    foot_y = (foot_y - bob) * s

    head_r = 13
    head_cy = foot_y - 60 * s
    torso_top = head_cy + 12 * s
    torso_bot = foot_y - 26 * s
    hip_y = torso_bot
    ow = max(1, s)

    def E(x0, y0, x1, y1, fill, outline=None, w=0):
        d.ellipse([x0, y0, x1, y1], fill=fill, outline=outline, width=w)

    # ---- legs (behind torso) ----
    leg_dx = 9 * s * swing
    legw = 9 * s
    for sgn, dx in ((1, leg_dx), (-1, -leg_dx)):
        hipx = cx + sgn * 6 * s
        footx = hipx + dx
        shade = PANTS if sgn * swing >= 0 else PANTS_SH
        d.line([(hipx, hip_y), (footx, foot_y)], fill=shade, width=legw)
        E(footx - 7 * s, foot_y - 4 * s, footx + 9 * s, foot_y + 5 * s, SHOE, OUTLINE, ow)

    # ---- torso ----
    tw = (13 if view == "side" else 17) * s
    d.rounded_rectangle([cx - tw, torso_top, cx + tw, torso_bot],
                        radius=7 * s, fill=SHIRT, outline=OUTLINE, width=ow)
    if view == "front":
        d.rounded_rectangle([cx + tw - 6 * s, torso_top + 2 * s, cx + tw, torso_bot],
                            radius=5 * s, fill=SHIRT_SH)
    elif view == "back":
        # collar line so the back reads as a back
        d.arc([cx - 8 * s, torso_top - 4 * s, cx + 8 * s, torso_top + 8 * s],
              0, 180, fill=SHIRT_SH, width=2 * s)

    # ---- arms ----
    arm_dx = 8 * s * swing
    shoulder_y = torso_top + 4 * s
    armw = 7 * s
    for sgn, dx in ((1, -arm_dx), (-1, arm_dx)):
        sx = cx + sgn * tw
        hx = sx + dx
        hy = torso_bot - 2 * s
        d.line([(sx, shoulder_y), (hx, hy)], fill=SHIRT_SH, width=armw)
        E(hx - 4 * s, hy - 4 * s, hx + 4 * s, hy + 4 * s, SKIN)

    # ---- neck ----
    d.line([(cx, head_cy + head_r * s - 2 * s), (cx, torso_top + 3 * s)],
           fill=SKIN_SH, width=8 * s)

    # ---- head ----
    hr = head_r * s
    E(cx - hr, head_cy - hr, cx + hr, head_cy + hr, SKIN, OUTLINE, ow)
    ey = head_cy + 1 * s

    if view == "front":
        d.pieslice([cx - hr - 1, head_cy - hr - 4 * s, cx + hr + 1, head_cy + hr], 180, 360, fill=HAIR)
        d.rectangle([cx - hr, head_cy - 4 * s, cx + hr, head_cy - 1 * s], fill=HAIR)
        E(cx - hr - 2 * s, head_cy - 1 * s, cx - hr + 4 * s, head_cy + 6 * s, SKIN, OUTLINE, ow)
        E(cx + hr - 4 * s, head_cy - 1 * s, cx + hr + 2 * s, head_cy + 6 * s, SKIN, OUTLINE, ow)
        for ex in (cx - 5 * s, cx + 5 * s):
            E(ex - 3 * s, ey - 3 * s, ex + 3 * s, ey + 3 * s, EYE, OUTLINE, ow)
            E(ex - 1 * s, ey - 1 * s, ex + 2 * s, ey + 2 * s, PUPIL)
        d.arc([cx - 5 * s, ey + 2 * s, cx + 5 * s, ey + 9 * s], 20, 160, fill=SKIN_SH, width=2 * s)

    elif view == "back":
        # hair covers almost the whole head; just ears + nape of neck show skin
        E(cx - hr - 1, head_cy - hr - 2 * s, cx + hr + 1, head_cy + hr - 3 * s, HAIR)
        d.rectangle([cx - hr, head_cy - 2 * s, cx + hr, head_cy + 4 * s], fill=HAIR)
        E(cx - hr - 2 * s, head_cy, cx - hr + 4 * s, head_cy + 7 * s, SKIN, OUTLINE, ow)
        E(cx + hr - 4 * s, head_cy, cx + hr + 2 * s, head_cy + 7 * s, SKIN, OUTLINE, ow)
        # faint hairline at the nape
        d.arc([cx - 7 * s, head_cy + 3 * s, cx + 7 * s, head_cy + 12 * s], 200, 340, fill=HAIR, width=2 * s)

    else:  # side, facing right
        # hair wraps the top and back (left) of the head
        d.pieslice([cx - hr - 2 * s, head_cy - hr - 4 * s, cx + hr, head_cy + hr], 150, 360, fill=HAIR)
        d.rectangle([cx - hr - 2 * s, head_cy - 4 * s, cx + 4 * s, head_cy - 1 * s], fill=HAIR)
        # ear toward the back (left)
        E(cx - 5 * s, head_cy, cx + 1 * s, head_cy + 7 * s, SKIN, OUTLINE, ow)
        # nose poking out the front (right)
        d.polygon([(cx + hr - 1, ey - 1 * s), (cx + hr + 4 * s, ey + 2 * s), (cx + hr - 1, ey + 4 * s)],
                  fill=SKIN, outline=OUTLINE)
        # single eye toward the front
        ex = cx + 5 * s
        E(ex - 2 * s, ey - 3 * s, ex + 3 * s, ey + 2 * s, EYE, OUTLINE, ow)
        E(ex + 1 * s, ey - 1 * s, ex + 3 * s, ey + 1 * s, PUPIL)
        # small mouth near the front
        d.arc([cx + 2 * s, ey + 3 * s, cx + 9 * s, ey + 9 * s], 10, 110, fill=SKIN_SH, width=2 * s)


def main():
    big = Image.new("RGBA", (FW * COLS * SS, FH * ROWS * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    for r, view in enumerate(VIEWS):
        for c in range(COLS):
            cx = FW * c + FW / 2
            foot_y = FH * r + (FH - 6)
            moving = c > 0
            t = ((c - 1) / (COLS - 1)) if moving else 0.0
            draw_character(d, cx, foot_y, t, moving, view)
    out = big.resize((FW * COLS, FH * ROWS), Image.LANCZOS)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    out.save(OUT)
    print(f"wrote {os.path.relpath(OUT)}  {out.size[0]}x{out.size[1]}  cols={COLS} rows={ROWS} ({', '.join(VIEWS)})")


if __name__ == "__main__":
    main()
