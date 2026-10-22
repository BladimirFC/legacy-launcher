"""Convert the LG logo to Windows app icon formats (requires Pillow)."""
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent.parent / 'assets'
image = Image.open(root / 'logo-lg.png').convert('RGBA')
if image.width != image.height:
    raise ValueError('The LG logo must be square to package the application icon.')
image.resize((512, 512), Image.Resampling.LANCZOS).save(root / 'icon.png')
image.save(root / 'icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
