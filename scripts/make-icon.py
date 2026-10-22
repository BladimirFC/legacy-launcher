"""Recreate the original Legacy app icon (requires Pillow, development only)."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent / 'assets'
image = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((0, 0, 1023, 1023), radius=220, fill='#191a1d')
draw.rounded_rectangle((13, 13, 1010, 1010), radius=208, outline='#343136', width=9)
draw.polygon([(336, 233), (505, 233), (409, 620), (681, 620), (640, 784), (200, 784)], fill='#ed6f50')
draw.polygon([(557, 233), (829, 233), (762, 500), (660, 500), (687, 390), (506, 540), (434, 452), (615, 302), (540, 302)], fill='#ed6f50')
image.resize((512, 512), Image.Resampling.LANCZOS).save(root / 'icon.png')
image.save(root / 'icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
