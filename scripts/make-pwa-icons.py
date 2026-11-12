#!/usr/bin/env python3
"""Génère les icônes PWA de Hermes Web (192/512 px) : carré arrondi
orange Hermes avec un « H » blanc stylisé (deux montants + barre)."""
from PIL import Image, ImageDraw

BG = (185, 84, 39)  # orange/terre cuite Hermes (proche oklch 0.63 0.17 42)
FG = (255, 250, 245)

def make(size: int, path: str, maskable: bool = False) -> None:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    radius = int(size * (0.34 if maskable else 0.22))
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=BG + (255,))
    # « H » stylisé : deux montants verticaux + barre centrale
    s = size
    w = int(s * 0.115)          # épaisseur des traits
    top = int(s * (0.30 if maskable else 0.24))
    bottom = int(s * (0.70 if maskable else 0.76))
    cx = s // 2
    left = cx - int(s * 0.17)
    right = cx + int(s * 0.17)
    d.rounded_rectangle([left, top, left + w, bottom], radius=w // 3, fill=FG + (255,))
    d.rounded_rectangle([right - w, top, right, bottom], radius=w // 3, fill=FG + (255,))
    d.rounded_rectangle([left, cx - w // 2, right, cx + w // 2], radius=w // 3, fill=FG + (255,))
    img.save(path)
    print(f"{path} ({size}x{size}) écrit")

make(192, "/home/z/my-project/public/icon-192.png")
make(512, "/home/z/my-project/public/icon-512.png")
make(512, "/home/z/my-project/public/icon-maskable-512.png", maskable=True)
